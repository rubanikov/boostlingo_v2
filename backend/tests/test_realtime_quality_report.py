"""Ticket 10's tests for `fixtures/run_realtime_quality_report.py`.

The question here is only whether the tuning fingerprint survives the trip
from a capture file to the report: onto every result row, into the summary,
and into the COMPARISON.md section 7 row the script prints. Whether
`gpt-realtime` translates well is not something a unit test can ask, so the
judge is faked and no test here opens a socket or needs a key -- same posture
as `test_tuning_sweep.py`.

The captures themselves are written by
`frontend/e2e/realtime-quality-capture.mjs`, which scrapes the fingerprint
off the Tuning panel's chip; the fixtures below are that file's shape,
trimmed to the fields this script reads.
"""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.quality.llm_judge import TranslationJudgment
from tests.fixtures import run_realtime_quality_report as report

DEFAULTS_FINGERPRINT = "cfg:7f3a9c21"
TUNED_FINGERPRINT = "cfg:0a1b2c3d"


def _capture(item_id: str, **overrides: Any) -> dict:
    """One capture entry. The caption (`inputTranscript`) drives the WER
    column and the reply (`outputTranscript`) is what the judge sees."""
    capture = {
        "id": item_id,
        "sourceLang": "en",
        "targetLang": "es",
        "referenceText": "hello there friend",
        "referenceTranslation": "hola amigo",
        "conditions": None,
        "fingerprint": DEFAULTS_FINGERPRINT,
        "inputTranscript": "hello there friend",
        "outputTranscript": "hola amigo",
        "endToEndLatencyMs": 200,
        "error": None,
    }
    capture.update(overrides)
    return capture


async def _fake_judge(
    source_text: str,
    source_language: str,
    candidate_translation: str,
    target_language: str,
    *,
    client: object | None = None,
) -> TranslationJudgment:
    """Accepts anything but a reply containing "wrong", so a fixture decides
    its own verdict without the test having to stub per call."""
    del source_text, source_language, target_language, client
    if "wrong" in candidate_translation:
        return TranslationJudgment(acceptable=False, issues=["mistranslation"], notes="")
    return TranslationJudgment(acceptable=True, issues=[], notes="")


@pytest.fixture
def run_report(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Runs the script against a capture document in `tmp_path` and returns
    the report it wrote."""
    captures_path = tmp_path / "captures.json"
    report_path = tmp_path / "realtime_quality_report.json"
    monkeypatch.setattr(report, "CAPTURES_PATH", captures_path)
    monkeypatch.setattr(report, "REPORT_PATH", report_path)
    monkeypatch.setattr(report, "settings", SimpleNamespace(openai_api_key="test-key"))
    monkeypatch.setattr(report, "AsyncOpenAI", lambda api_key: SimpleNamespace(api_key=api_key))
    monkeypatch.setattr(report, "judge_translation", _fake_judge)

    def run(document: dict) -> dict:
        captures_path.write_text(json.dumps(document), encoding="utf-8")
        asyncio.run(report.main())
        return json.loads(report_path.read_text(encoding="utf-8"))

    return run


def test_fingerprint_reaches_every_result_the_summary_and_the_printed_row(run_report, capsys):
    written = run_report(
        {
            "baseUrl": "http://localhost:5173",
            "leadSilenceS": 4,
            "fingerprint": DEFAULTS_FINGERPRINT,
            "tuningFile": "configs/a.json",
            "items": [
                _capture("short-en-01"),
                _capture(
                    "short-en-02",
                    inputTranscript="hello there enemy",
                    outputTranscript="hola wrong",
                    endToEndLatencyMs=400,
                ),
                _capture("short-en-03", error="session settled to 'Error'"),
            ],
        }
    )

    assert [result["fingerprint"] for result in written["results"]] == [DEFAULTS_FINGERPRINT] * 3
    # Including the capture that never reached the judge: which config a clip
    # failed under is exactly as interesting as which one it passed under.
    assert written["results"][2]["status"] == "capture_failed"
    assert written["summary"]["fingerprint"] == DEFAULTS_FINGERPRINT
    assert "fingerprints" not in written["summary"]

    printed = capsys.readouterr().out
    assert "COMPARISON.md section 7 rows:" in printed
    assert (
        f"| `{DEFAULTS_FINGERPRINT}` | realtime | clean | -- | 16.7% (n=2) | -- | 1/2 (50%) | -- | 300 ms |"
        in printed
    )


def test_an_item_without_a_fingerprint_inherits_the_envelope(run_report):
    written = run_report(
        {
            "fingerprint": DEFAULTS_FINGERPRINT,
            "tuningFile": None,
            "items": [_capture("short-en-01", fingerprint=None)],
        }
    )

    assert written["results"][0]["fingerprint"] == DEFAULTS_FINGERPRINT
    assert written["summary"]["fingerprint"] == DEFAULTS_FINGERPRINT


def test_a_capture_file_with_no_fingerprints_at_all_still_reports(run_report, capsys):
    """Capture files written before ticket 10 have no fingerprint anywhere.
    They still judge; the row just says the config is unknown."""
    written = run_report({"items": [_capture("short-en-01", fingerprint=None)]})

    assert written["results"][0]["fingerprint"] is None
    assert written["summary"]["fingerprint"] is None
    assert "| `cfg:unknown` | realtime | clean |" in capsys.readouterr().out


def test_mixed_fingerprints_are_listed_and_reported_one_row_each(run_report, capsys):
    written = run_report(
        {
            "fingerprint": TUNED_FINGERPRINT,
            "items": [
                _capture("short-en-01"),
                _capture("short-en-02", fingerprint=TUNED_FINGERPRINT, outputTranscript="hola wrong"),
            ],
        }
    )

    assert written["summary"]["fingerprint"] is None
    assert written["summary"]["fingerprints"] == sorted([DEFAULTS_FINGERPRINT, TUNED_FINGERPRINT])

    printed = capsys.readouterr().out
    assert f"| `{DEFAULTS_FINGERPRINT}` | realtime | clean | -- | 0.0% (n=1) | -- | 1/1 (100%) | -- | 200 ms |" in printed
    assert f"| `{TUNED_FINGERPRINT}` | realtime | clean | -- | 0.0% (n=1) | -- | 0/1 (0%) | -- | 200 ms |" in printed


def test_the_condition_column_comes_from_the_captures_conditions_field(run_report, capsys):
    run_report({"items": [_capture("short-en-01", conditions="cafe background noise")]})

    assert (
        f"| `{DEFAULTS_FINGERPRINT}` | realtime | cafe background noise | -- | 0.0% (n=1) | -- | 1/1 (100%) | -- | 200 ms |"
        in capsys.readouterr().out
    )
