"""Ticket 09's tests for `fixtures/run_tuning_sweep.py` and for
`stt_replay.transcribe_wav_detailed`.

Everything runs against a synthetic corpus in `tmp_path` (a few 200 ms tones
standing in for the ~430 mixed WAVs `make_noisy_corpus.py` writes) and a fake
replay, so no test here opens a socket or needs a key. The sweep's own
mechanics -- which rows get planned, what gets skipped on a re-run, the
over-cap refusal, the printed table -- are what's being tested; whether
Deepgram transcribes a tone correctly is not a question this suite can ask.

`transcribe_wav_detailed` is exercised through a fake `STTProvider` injected
at `stt_replay._make_stt_provider`, the seam that also builds ticket 06's
`DeepgramParams` from the config under replay.
"""

import json
import math
import wave
from array import array
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any, Final

import pytest

from app.providers.base import TranscriptSegment
from app.providers.deepgram_stt import DeepgramParams
from app.providers.transcript_check import TranscriptCheckResult
from app.tuning.fingerprint import fingerprint
from app.tuning.schema import CascadeModeTuning, TuningConfig, to_wire
from tests.fixtures import run_tuning_sweep, stt_replay
from tests.fixtures.stt_replay import ReplayResult

SAMPLE_RATE: Final = 16000
CONDITIONS: Final = ("babble", "street", "fan", "white")
SNRS_DB: Final = (20, 10, 5)


# --- corpus + config builders ----------------------------------------------


def _write_tone(path: Path, *, seconds: float = 0.1, frequency: float = 440.0) -> None:
    samples = array(
        "h",
        (
            int(0.5 * 32767 * math.sin(2 * math.pi * frequency * index / SAMPLE_RATE))
            for index in range(int(SAMPLE_RATE * seconds))
        ),
    )
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(samples.tobytes())


def _make_corpus(
    tmp_path: Path,
    item_ids: Sequence[str],
    *,
    conditions: Sequence[str] = CONDITIONS,
    snrs: Sequence[int] = SNRS_DB,
    write_audio: bool = True,
) -> Path:
    """A miniature `noisy/` directory: same manifest shape
    `make_noisy_corpus.py` writes, one tone per variant."""
    corpus_dir = tmp_path / "noisy"
    corpus_dir.mkdir(exist_ok=True)
    rows = []
    for item_id in item_ids:
        variants: list[tuple[str, int | None]] = [("clean", None)]
        variants += [(condition, snr) for condition in conditions for snr in snrs]
        for condition, snr_db in variants:
            suffix = condition if snr_db is None else f"{condition}__{snr_db}dB"
            variant_id = f"{item_id}__{suffix}"
            rows.append(
                {
                    "id": variant_id,
                    "sourceItemId": item_id,
                    "audioFile": f"{variant_id}.wav",
                    "sourceLang": "en",
                    "targetLang": "es",
                    "referenceText": f"reference for {item_id}",
                    "referenceTranslation": f"referencia de {item_id}",
                    "condition": condition,
                    "snrDb": snr_db,
                    "measuredSnrDb": None if snr_db is None else float(snr_db),
                    "peakScale": 1.0,
                }
            )
            if write_audio:
                _write_tone(corpus_dir / f"{variant_id}.wav")

    manifest_path = corpus_dir / "noisy_manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "generatedAt": "2026-08-15T09:12:04+00:00",
                "seed": 1234,
                "sampleRate": SAMPLE_RATE,
                "items": rows,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return manifest_path


def _write_config(path: Path, **cascade_overrides: Any) -> Path:
    """A full `TuningConfig` document, as the panel's Export button writes
    it. `cascade_overrides` are applied to the cascade block so two configs
    in one sweep get two different fingerprints."""
    config = TuningConfig()
    for key, value in cascade_overrides.items():
        setattr(config.cascade, key, value)
    path.write_text(json.dumps(to_wire(config), indent=2), encoding="utf-8")
    return path


def _fingerprint_of(path: Path) -> str:
    return fingerprint(json.loads(path.read_text(encoding="utf-8")), "cascade")


class _FakeReplay:
    """Stands in for `transcribe_wav_detailed`: records every call and hands
    back a deterministic measurement. The corrected pair is what a `correct`-
    mode config measures (ticket 14) and stays `None` otherwise, matching the
    real replay."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.corrected_transcript: str | None = None
        self.corrected_wer: float | None = None

    async def __call__(
        self,
        path: Path,
        source_lang: str,
        target_lang: str,
        api_key: str,
        *,
        tuning: CascadeModeTuning | None = None,
        offline_stages: Sequence[str] | None = None,
        reference_text: str | None = None,
    ) -> ReplayResult:
        self.calls.append(
            {
                "path": path,
                "sourceLang": source_lang,
                "targetLang": target_lang,
                "tuning": tuning,
                "offlineStages": list(offline_stages or ()),
                "referenceText": reference_text,
            }
        )
        return ReplayResult(
            transcript=f"heard {path.stem}",
            wer=0.25,
            provider_latency_ms=812.0,
            added_latency_ms=41.5,
            stages=list(offline_stages or ()),
            corrected_transcript=self.corrected_transcript,
            corrected_wer=self.corrected_wer,
        )


@pytest.fixture
def fake_replay(monkeypatch: pytest.MonkeyPatch) -> _FakeReplay:
    replay = _FakeReplay()
    monkeypatch.setattr(run_tuning_sweep, "transcribe_wav_detailed", replay)
    monkeypatch.setattr(run_tuning_sweep.settings, "deepgram_api_key", "test-key")
    return replay


class _FakeSTTProvider:
    """Stands in for `DeepgramSTTProvider`: records every chunk it is fed and
    the params the connection was opened with, and answers with two finals,
    the second carrying `speech_final` -- the shape
    `transcribe_wav_detailed` stops collecting on."""

    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.stream_params: DeepgramParams | None = None

    async def stream(
        self,
        audio_chunks: AsyncIterator[bytes],
        *,
        languages: tuple[str, ...],
        params: DeepgramParams | None = None,
    ) -> AsyncIterator[TranscriptSegment]:
        del languages
        self.stream_params = params
        async for chunk in audio_chunks:
            self.chunks.append(chunk)
        yield TranscriptSegment(text="hello", is_final=True, speech_final=False)
        yield TranscriptSegment(text="there", is_final=True, speech_final=True)


@pytest.fixture
def fake_stt_provider(monkeypatch: pytest.MonkeyPatch) -> _FakeSTTProvider:
    """Replay against a fake provider, injected at the `_make_stt_provider`
    seam. The trailing silence is shortened because these tests pace in real
    time and 1.5s of it per clip buys nothing here -- the live replay keeps
    the real value, which is what Deepgram's endpointing needs."""
    provider = _FakeSTTProvider()
    monkeypatch.setattr(stt_replay, "_make_stt_provider", lambda api_key, tuning: (provider, None))
    monkeypatch.setattr(stt_replay, "TRAILING_SILENCE_S", 0.1)
    return provider


def _rows(out_path: Path) -> list[dict]:
    return json.loads(out_path.read_text(encoding="utf-8"))["rows"]


def _argv(config: Path, corpus: Path, out: Path, *extra: str) -> list[str]:
    return ["--config", str(config), "--corpus", str(corpus), "--out", str(out), *extra]


# --- S16: one row per (item, condition, SNR), and resume --------------------


@pytest.mark.asyncio
async def test_one_row_per_item_condition_and_snr_carrying_the_fingerprint(
    tmp_path: Path, fake_replay: _FakeReplay
) -> None:
    corpus = _make_corpus(tmp_path, ("item-a", "item-b"), conditions=("babble",), snrs=(20, 10))
    config = _write_config(tmp_path / "a.json")
    out = tmp_path / "tuning_sweep.json"

    assert await run_tuning_sweep.main(_argv(config, corpus, out)) == 0

    rows = _rows(out)
    assert {(row["itemId"], row["condition"], row["snrDb"]) for row in rows} == {
        ("item-a", "clean", None),
        ("item-a", "babble", 20),
        ("item-a", "babble", 10),
        ("item-b", "clean", None),
        ("item-b", "babble", 20),
        ("item-b", "babble", 10),
    }
    for row in rows:
        assert set(row) == {
            "fingerprint",
            "itemId",
            "condition",
            "snrDb",
            "wer",
            "correctedWer",
            "addedLatencyMs",
            "providerLatencyMs",
            "status",
            "skipReason",
        }
        assert row["fingerprint"] == _fingerprint_of(config)
        assert row["status"] == "ok"
        assert row["wer"] == 0.25
        assert row["correctedWer"] is None  # this config asks for no check
        assert row["addedLatencyMs"] == 41.5
        assert row["providerLatencyMs"] == 812.0
        assert row["skipReason"] is None

    document = json.loads(out.read_text(encoding="utf-8"))
    assert document["configs"] == [
        {"fingerprint": _fingerprint_of(config), "file": str(config), "mode": "cascade"}
    ]
    assert document["generatedAt"].endswith("+00:00")


@pytest.mark.asyncio
async def test_rerunning_against_the_same_out_file_skips_the_rows_already_there(
    tmp_path: Path, fake_replay: _FakeReplay, capsys: pytest.CaptureFixture[str]
) -> None:
    corpus = _make_corpus(tmp_path, ("item-a",), conditions=("babble",), snrs=(20,))
    config = _write_config(tmp_path / "a.json")
    out = tmp_path / "tuning_sweep.json"

    await run_tuning_sweep.main(_argv(config, corpus, out))
    first_pass = len(fake_replay.calls)
    capsys.readouterr()

    assert await run_tuning_sweep.main(_argv(config, corpus, out)) == 0

    assert len(fake_replay.calls) == first_pass, "already-measured rows were replayed again"
    assert len(_rows(out)) == first_pass
    assert f"{first_pass} row(s) already in" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_a_second_config_adds_its_own_rows_beside_the_first(
    tmp_path: Path, fake_replay: _FakeReplay
) -> None:
    corpus = _make_corpus(tmp_path, ("item-a",), conditions=("babble",), snrs=(20,))
    default_config = _write_config(tmp_path / "a.json")
    tuned_config = _write_config(tmp_path / "b.json")
    tuned = json.loads(tuned_config.read_text(encoding="utf-8"))
    tuned["cascade"]["deepgram"]["endpointingMs"] = 300
    tuned_config.write_text(json.dumps(tuned), encoding="utf-8")
    out = tmp_path / "tuning_sweep.json"

    await run_tuning_sweep.main(
        [
            "--config",
            str(default_config),
            "--config",
            str(tuned_config),
            "--corpus",
            str(corpus),
            "--out",
            str(out),
        ]
    )

    document = json.loads(out.read_text(encoding="utf-8"))
    fingerprints = {config["fingerprint"] for config in document["configs"]}
    assert fingerprints == {
        _fingerprint_of(default_config),
        _fingerprint_of(tuned_config),
    }
    assert len(fingerprints) == 2, "two different configs must not share a fingerprint"
    assert {row["fingerprint"] for row in document["rows"]} == fingerprints


# --- S19: the clean baseline row is in every run ----------------------------


@pytest.mark.asyncio
async def test_the_clean_row_is_included_even_when_conditions_excludes_it(
    tmp_path: Path, fake_replay: _FakeReplay, capsys: pytest.CaptureFixture[str]
) -> None:
    corpus = _make_corpus(tmp_path, ("item-a", "item-b"), conditions=("babble",), snrs=(20,))
    config = _write_config(tmp_path / "a.json")
    out = tmp_path / "tuning_sweep.json"

    await run_tuning_sweep.main(_argv(config, corpus, out, "--conditions", "babble"))

    clean = [row for row in _rows(out) if row["condition"] == "clean"]
    assert {row["itemId"] for row in clean} == {"item-a", "item-b"}
    assert all(row["snrDb"] is None for row in clean)
    assert "clean" in capsys.readouterr().out.lower()


# --- S20: the paste-ready markdown table ------------------------------------


@pytest.mark.asyncio
async def test_prints_one_markdown_row_per_fingerprint(
    tmp_path: Path, fake_replay: _FakeReplay, capsys: pytest.CaptureFixture[str]
) -> None:
    corpus = _make_corpus(tmp_path, ("item-a", "item-b"), conditions=(), snrs=())
    default_config = _write_config(tmp_path / "a.json")
    tuned_config = _write_config(tmp_path / "b.json")
    tuned = json.loads(tuned_config.read_text(encoding="utf-8"))
    tuned["cascade"]["deepgram"]["endpointingMs"] = 300
    tuned_config.write_text(json.dumps(tuned), encoding="utf-8")
    out = tmp_path / "tuning_sweep.json"

    await run_tuning_sweep.main(
        [
            "--config",
            str(default_config),
            "--config",
            str(tuned_config),
            "--corpus",
            str(corpus),
            "--out",
            str(out),
        ]
    )

    output = capsys.readouterr().out
    assert "COMPARISON.md section 7 rows:" in output
    table_rows = [line for line in output.splitlines() if line.startswith("| `cfg:")]
    assert len(table_rows) == 2, output

    for path in (default_config, tuned_config):
        row = next(line for line in table_rows if _fingerprint_of(path) in line)
        cells = [cell.strip() for cell in row.strip("|").split("|")]
        assert cells[1] == "cascade"
        assert cells[2] == "clean"
        assert cells[3] == "--"  # no SNR on a clean row
        assert cells[4] == "25.0% (n=2)"
        assert cells[5] == "--", "corrected WER is ticket 14's column"
        assert cells[6] == "--", "the judge is Realtime-only (builder decision 2)"
        assert cells[7] == "41.5 ms"
        assert cells[8] == "812 ms"


# --- S30 (sweep half): offline stages are honoured --------------------------


@pytest.mark.asyncio
async def test_a_config_naming_demucs_reaches_the_replay_as_an_offline_stage(
    tmp_path: Path, fake_replay: _FakeReplay
) -> None:
    corpus = _make_corpus(tmp_path, ("item-a",), conditions=(), snrs=())
    config = _write_config(tmp_path / "a.json")
    document = json.loads(config.read_text(encoding="utf-8"))
    document["cascade"]["denoise"]["offline"] = {"demucs": True, "dns64": False}
    config.write_text(json.dumps(document), encoding="utf-8")
    out = tmp_path / "tuning_sweep.json"

    assert await run_tuning_sweep.main(_argv(config, corpus, out)) == 0

    assert [call["offlineStages"] for call in fake_replay.calls] == [["demucs"]]
    assert _rows(out)[0]["status"] == "ok"


@pytest.mark.asyncio
async def test_an_uninstalled_offline_stage_is_recorded_rather_than_dropped(
    tmp_path: Path, fake_stt_provider: _FakeSTTProvider
) -> None:
    """The other half of S30: `run_tuning_sweep` asks for the stage, and
    `stt_replay` reports that it didn't run instead of implying it did."""
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)

    result = await stt_replay.transcribe_wav_detailed(
        clip, "en", "es", "test-key", offline_stages=["demucs", "dns64"]
    )

    assert result.stages == [
        "offline:demucs (unavailable)",
        "offline:dns64 (unavailable)",
    ]


# --- F17 / E14: nothing to measure is not a failure -------------------------


@pytest.mark.asyncio
async def test_a_missing_corpus_manifest_is_a_message_and_exit_0(
    tmp_path: Path, fake_replay: _FakeReplay, capsys: pytest.CaptureFixture[str]
) -> None:
    config = _write_config(tmp_path / "a.json")
    out = tmp_path / "tuning_sweep.json"

    assert await run_tuning_sweep.main(_argv(config, tmp_path / "gone.json", out)) == 0

    output = capsys.readouterr().out
    assert "make_noisy_corpus" in output
    assert "not an error" in output
    assert not out.exists()
    assert fake_replay.calls == []


@pytest.mark.asyncio
async def test_a_manifest_whose_audio_is_all_missing_reports_zero_ok_rows_and_exits_0(
    tmp_path: Path, fake_replay: _FakeReplay, capsys: pytest.CaptureFixture[str]
) -> None:
    corpus = _make_corpus(
        tmp_path, ("item-a",), conditions=("babble",), snrs=(20,), write_audio=False
    )
    config = _write_config(tmp_path / "a.json")
    out = tmp_path / "tuning_sweep.json"

    assert await run_tuning_sweep.main(_argv(config, corpus, out)) == 0

    rows = _rows(out)
    assert [row["status"] for row in rows] == ["skipped", "skipped"]
    assert all(row["skipReason"] == "missing audio file" for row in rows)
    assert all(row["wer"] is None for row in rows)
    assert fake_replay.calls == []

    output = capsys.readouterr().out
    assert "-ar 16000 -ac 1 -sample_fmt s16" in output
    assert "0 ok" in output


# --- E12: the over-cap refusal ---------------------------------------------


@pytest.mark.asyncio
async def test_a_sweep_over_the_row_cap_refuses_and_prints_an_estimated_wall_clock(
    tmp_path: Path, fake_replay: _FakeReplay, capsys: pytest.CaptureFixture[str]
) -> None:
    item_ids = tuple(f"item-{index:02d}" for index in range(21))
    corpus = _make_corpus(tmp_path, item_ids)
    config = _write_config(tmp_path / "a.json")
    out = tmp_path / "tuning_sweep.json"
    planned = len(item_ids) * (1 + len(CONDITIONS) * len(SNRS_DB))

    assert planned > run_tuning_sweep.MAX_ROWS_WITHOUT_CONFIRM
    assert await run_tuning_sweep.main(_argv(config, corpus, out)) == 1

    output = capsys.readouterr().out
    assert f"{planned} rows" in output
    assert "estimated wall-clock" in output
    assert "--limit" in output and "--yes" in output
    assert fake_replay.calls == []
    assert not out.exists()


@pytest.mark.asyncio
async def test_yes_proceeds_past_the_cap_and_limit_stays_under_it(
    tmp_path: Path, fake_replay: _FakeReplay
) -> None:
    item_ids = tuple(f"item-{index:02d}" for index in range(21))
    corpus = _make_corpus(tmp_path, item_ids)
    config = _write_config(tmp_path / "a.json")

    limited = tmp_path / "limited.json"
    assert await run_tuning_sweep.main(_argv(config, corpus, limited, "--limit", "5")) == 0
    assert len(_rows(limited)) == 5

    confirmed = tmp_path / "confirmed.json"
    assert await run_tuning_sweep.main(_argv(config, corpus, confirmed, "--yes")) == 0
    assert len(_rows(confirmed)) == len(item_ids) * (1 + len(CONDITIONS) * len(SNRS_DB))


# --- selection flags --------------------------------------------------------


@pytest.mark.asyncio
async def test_only_and_snr_narrow_the_run(tmp_path: Path, fake_replay: _FakeReplay) -> None:
    corpus = _make_corpus(
        tmp_path, ("item-a", "item-b"), conditions=("babble", "fan"), snrs=(20, 5)
    )
    config = _write_config(tmp_path / "a.json")
    out = tmp_path / "tuning_sweep.json"

    await run_tuning_sweep.main(
        _argv(config, corpus, out, "--only", "item-a", "--conditions", "fan", "--snr", "5")
    )

    assert {(row["itemId"], row["condition"], row["snrDb"]) for row in _rows(out)} == {
        ("item-a", "clean", None),
        ("item-a", "fan", 5),
    }


@pytest.mark.asyncio
async def test_a_missing_deepgram_key_is_a_message_and_exit_0(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(run_tuning_sweep.settings, "deepgram_api_key", "")
    corpus = _make_corpus(tmp_path, ("item-a",), conditions=(), snrs=())
    config = _write_config(tmp_path / "a.json")
    out = tmp_path / "tuning_sweep.json"

    assert await run_tuning_sweep.main(_argv(config, corpus, out)) == 0

    assert "DEEPGRAM_API_KEY" in capsys.readouterr().out
    assert not out.exists()


# --- stt_replay: the delegation contract ------------------------------------


@pytest.mark.asyncio
async def test_transcribe_wav_still_returns_a_plain_transcript(
    tmp_path: Path, fake_stt_provider: _FakeSTTProvider
) -> None:
    """`test_quality_wer.py` and `run_real_audio_report.py` call this and
    expect a `str`; the detailed variant is additive."""
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)

    transcript = await stt_replay.transcribe_wav(clip, "en", "es", "test-key")

    assert transcript == "hello there"


@pytest.mark.asyncio
async def test_detailed_replay_scores_the_transcript_and_reports_zero_added_latency(
    tmp_path: Path, fake_stt_provider: _FakeSTTProvider
) -> None:
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)

    result = await stt_replay.transcribe_wav_detailed(
        clip, "en", "es", "test-key", reference_text="hello world"
    )

    assert result.transcript == "hello there"
    assert result.wer == 0.5  # one of two reference words wrong
    assert result.added_latency_ms == 0.0, "no denoise chain is enabled, so nothing was added"
    assert result.provider_latency_ms >= 0.0
    assert result.stages == []
    assert result.corrected_transcript is None
    assert result.corrected_wer is None
    # 50ms of audio at 20ms per chunk, then the trailing silence.
    silence_chunks = int(stt_replay.TRAILING_SILENCE_S * 1000 / 20)
    assert len(fake_stt_provider.chunks) == 3 + silence_chunks


@pytest.fixture
def recording_stt_provider(monkeypatch: pytest.MonkeyPatch) -> _FakeSTTProvider:
    """Same fake, but injected one level lower -- at the provider class rather
    than at `_make_stt_provider` -- so the seam's own param-building is what's
    under test rather than stubbed out."""
    provider = _FakeSTTProvider()
    monkeypatch.setattr(stt_replay, "DeepgramSTTProvider", lambda _api_key: provider)
    monkeypatch.setattr(stt_replay, "TRAILING_SILENCE_S", 0.1)
    return provider


@pytest.mark.asyncio
async def test_the_replay_opens_the_connection_with_the_configs_deepgram_knobs(
    tmp_path: Path, recording_stt_provider: _FakeSTTProvider
) -> None:
    """A row's fingerprint hashes `cascade.deepgram.*`, so the connection has
    to have run under those four knobs -- otherwise two configs differing only
    in `endpointingMs` measure identically under a different label."""
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)
    tuning = CascadeModeTuning()
    tuning.cascade.deepgram.model = "nova-2"
    tuning.cascade.deepgram.endpointing_ms = 300
    tuning.cascade.deepgram.utterance_end_ms = 2000
    tuning.cascade.deepgram.diarize = False

    await stt_replay.transcribe_wav_detailed(clip, "en", "es", "test-key", tuning=tuning)

    assert recording_stt_provider.stream_params == DeepgramParams(
        model="nova-2", endpointing_ms=300, utterance_end_ms=2000, diarize=False
    )


@pytest.mark.asyncio
async def test_a_wire_dict_tuning_reaches_the_connection_the_same_way(
    tmp_path: Path, recording_stt_provider: _FakeSTTProvider
) -> None:
    """`run_tuning_sweep` passes a `CascadeModeTuning`, but the harness also
    accepts the wire document straight from a config file (aliased keys)."""
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)

    await stt_replay.transcribe_wav_detailed(
        clip,
        "en",
        "es",
        "test-key",
        tuning={"cascade": {"deepgram": {"endpointingMs": 250, "utteranceEndMs": 1500}}},
    )

    assert recording_stt_provider.stream_params is not None
    assert recording_stt_provider.stream_params.endpointing_ms == 250
    assert recording_stt_provider.stream_params.utterance_end_ms == 1500


@pytest.mark.asyncio
async def test_an_untuned_replay_passes_no_params_at_all(
    tmp_path: Path, recording_stt_provider: _FakeSTTProvider
) -> None:
    """The pre-tuning callers (`test_quality_wer.py`,
    `run_real_audio_report.py`) must keep opening the URL they always did,
    which is what `params=None` means to `DeepgramSTTProvider`."""
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)

    await stt_replay.transcribe_wav(clip, "en", "es", "test-key")

    assert recording_stt_provider.stream_params is None


# --- ticket 14: the correctedWer column -------------------------------------


class _FakeTranscriptChecker:
    """Stands in for `TranscriptChecker` in the replay. `corrected` is what
    the check rewrites the transcript to (`None` = nothing to fix)."""

    def __init__(self) -> None:
        self.corrected: str | None = None
        self.calls: list[dict[str, Any]] = []

    async def check(
        self, text: str, language: str, mode: str, *, model: str | None = None
    ) -> TranscriptCheckResult:
        self.calls.append({"text": text, "language": language, "mode": mode, "model": model})
        return TranscriptCheckResult(
            flagged=self.corrected is not None, corrected_text=self.corrected, failed=False
        )


@pytest.fixture
def fake_transcript_checker(monkeypatch: pytest.MonkeyPatch) -> _FakeTranscriptChecker:
    """The checker class itself is replaced, not the decision to build one --
    so whether the replay runs a check at all (the mode, and the key) stays
    under test."""
    checker = _FakeTranscriptChecker()
    monkeypatch.setattr(stt_replay, "TranscriptChecker", lambda api_key, model: checker)
    monkeypatch.setattr(stt_replay.settings, "openai_api_key", "test-key")
    return checker


def _correct_mode_tuning() -> CascadeModeTuning:
    tuning = CascadeModeTuning()
    tuning.cascade.transcript_check.mode = "correct"
    return tuning


@pytest.mark.asyncio
async def test_correct_mode_scores_the_rewritten_transcript_as_corrected_wer(
    tmp_path: Path,
    fake_stt_provider: _FakeSTTProvider,
    fake_transcript_checker: _FakeTranscriptChecker,
) -> None:
    """Story AC 4.5's Cascade half: the row carries the raw WER *and* the WER
    after the transcript check rewrote it, so the two are comparable per
    item rather than only in aggregate."""
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)
    fake_transcript_checker.corrected = "hello world"

    result = await stt_replay.transcribe_wav_detailed(
        clip,
        "en",
        "es",
        "test-key",
        tuning=_correct_mode_tuning(),
        reference_text="hello world",
    )

    assert result.transcript == "hello there"
    assert result.wer == 0.5
    assert result.corrected_transcript == "hello world"
    assert result.corrected_wer == 0.0
    assert fake_transcript_checker.calls == [
        {"text": "hello there", "language": "en", "mode": "correct", "model": None}
    ]


@pytest.mark.asyncio
async def test_a_check_that_changes_nothing_still_reports_a_corrected_wer(
    tmp_path: Path,
    fake_stt_provider: _FakeSTTProvider,
    fake_transcript_checker: _FakeTranscriptChecker,
) -> None:
    """`correctedWer` is null only when the check didn't run. A check that
    ran and found nothing to fix is a real measurement -- and the answer
    "correct mode bought nothing here" is one the sweep exists to give."""
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)

    result = await stt_replay.transcribe_wav_detailed(
        clip, "en", "es", "test-key", tuning=_correct_mode_tuning(), reference_text="hello world"
    )

    assert result.corrected_transcript == "hello there"
    assert result.corrected_wer == result.wer


@pytest.mark.asyncio
async def test_no_check_runs_when_the_mode_is_not_correct(
    tmp_path: Path,
    fake_stt_provider: _FakeSTTProvider,
    fake_transcript_checker: _FakeTranscriptChecker,
) -> None:
    """`flag` has nothing to score: it never rewrites the transcript."""
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)
    tuning = CascadeModeTuning()
    tuning.cascade.transcript_check.mode = "flag"

    result = await stt_replay.transcribe_wav_detailed(
        clip, "en", "es", "test-key", tuning=tuning, reference_text="hello world"
    )

    assert fake_transcript_checker.calls == []
    assert result.corrected_wer is None


@pytest.mark.asyncio
async def test_correct_mode_self_skips_without_an_openai_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_stt_provider: _FakeSTTProvider,
    fake_transcript_checker: _FakeTranscriptChecker,
) -> None:
    """Same posture as every other harness here (AGENTS.md): no key means the
    column is left null and the sweep still measures everything else."""
    monkeypatch.setattr(stt_replay.settings, "openai_api_key", "")
    clip = tmp_path / "clip.wav"
    _write_tone(clip, seconds=0.05)

    result = await stt_replay.transcribe_wav_detailed(
        clip,
        "en",
        "es",
        "test-key",
        tuning=_correct_mode_tuning(),
        reference_text="hello world",
    )

    assert fake_transcript_checker.calls == []
    assert result.corrected_wer is None
    assert result.wer == 0.5, "the rest of the measurement is unaffected"


@pytest.mark.asyncio
async def test_the_sweep_writes_corrected_wer_into_the_row_and_the_table(
    tmp_path: Path, fake_replay: _FakeReplay, capsys: pytest.CaptureFixture[str]
) -> None:
    """The sweep's half of ticket 14: whatever the replay measured lands in
    the `correctedWer` column and in section 7's corrected-WER cell."""
    fake_replay.corrected_transcript = "recognise speech"
    fake_replay.corrected_wer = 0.125
    corpus = _make_corpus(tmp_path, ("item-a",), conditions=(), snrs=())
    config = _write_config(tmp_path / "a.json")
    document = json.loads(config.read_text(encoding="utf-8"))
    document["cascade"]["transcriptCheck"] = {"mode": "correct", "model": "gpt-4o-mini"}
    config.write_text(json.dumps(document), encoding="utf-8")
    out = tmp_path / "tuning_sweep.json"

    assert await run_tuning_sweep.main(_argv(config, corpus, out)) == 0

    assert [row["correctedWer"] for row in _rows(out)] == [0.125]
    table_row = next(
        line for line in capsys.readouterr().out.splitlines() if line.startswith("| `cfg:")
    )
    cells = [cell.strip() for cell in table_row.strip("|").split("|")]
    assert cells[4] == "25.0% (n=1)"
    assert cells[5] == "12.5% (n=1)"
