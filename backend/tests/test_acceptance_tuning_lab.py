"""Story-level acceptance walk for the Audio Tuning & Denoise Lab.

These tests deliberately do *not* re-test what the per-ticket suites already
pin (`test_tuning_config.py`, `test_tuning_api.py`, `test_realtime.py`,
`test_orchestrator.py`, `test_tuning_sweep.py`). They cover the joins
*between* those surfaces -- the places where two individually-green units can
still disagree in the researcher's hands:

* the config `/api/tuning/capabilities` publishes (what the panel displays,
  story AC 1.11) is the same config, byte for byte and hash for hash, that a
  session actually runs (AC 1.2, 1.4, 1.12);
* the whole published document -- not the sparse fixture the unit tests send
  -- parses and is honoured on both transports;
* the two halves of the asymmetric validation posture (AC 5.7) behave that way
  *for the same bad value*;
* the numbers the report promises (AC 2.6, 2.7) are actually produced, and a
  row stamped with a fingerprint was actually measured under that config
  (AC 2.2).

No live keys: the OpenAI call is mocked at `httpx.AsyncClient.post` and the
providers are the recording fakes `test_orchestrator.py` already owns.
"""

import asyncio
import copy
import json
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from app import orchestrator
from app.config import settings
from app.main import app
from app.providers.base import TranscriptSegment
from app.providers.deepgram_stt import DeepgramParams
from app.tuning.fingerprint import fingerprint, project_mode
from tests.fixtures import stt_replay
from tests.test_orchestrator import (
    _receive_until,
    _RecordingSTT,
    _RecordingTranslation,
    _RecordingTTS,
    _start_session,
    _tuning_message,
)
from tests.test_tuning_sweep import _write_tone

REPO_ROOT = Path(__file__).resolve().parents[2]

_real_post = httpx.AsyncClient.post


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture()
def recording_providers(monkeypatch: pytest.MonkeyPatch):
    """`test_orchestrator.py`'s recording fakes, wired in here rather than
    re-invented: they record the `DeepgramParams` each STT connection was
    opened with, the translation model and the TTS voices, which is exactly
    what "the published config is the config it runs" needs to read."""
    _RecordingSTT.calls = []
    _RecordingTranslation.models = []
    _RecordingTTS.voices = []
    monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _RecordingSTT)
    monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _RecordingTranslation)
    monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _RecordingTTS)
    return _RecordingSTT, _RecordingTranslation, _RecordingTTS


@pytest.fixture()
def openai_session_call(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Intercepts the one outbound call `POST /api/realtime/session` makes and
    returns the list of payloads it was given, so a test can read exactly what
    OpenAI would have been sent. The server needs a key to get that far."""
    monkeypatch.setattr(settings, "openai_api_key", "sk-not-a-real-key")
    payloads: list[dict[str, Any]] = []

    async def fake_post(
        self: httpx.AsyncClient,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json: dict | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        if "client_secrets" not in str(url):
            return await _real_post(self, url, headers=headers, json=json, timeout=timeout)
        payloads.append(json or {})
        request = httpx.Request("POST", url, headers=headers, json=json)
        return httpx.Response(
            status_code=200,
            json={
                "value": "ek_test_ephemeral_token",
                "expires_at": 1_999_999_999,
                "session": {
                    "type": "realtime",
                    "model": "gpt-realtime",
                    "audio": {"output": {"voice": "alloy"}},
                },
            },
            request=request,
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return payloads


def _published_defaults(client: TestClient) -> dict[str, Any]:
    """The full `TuningConfig` the panel is served on load."""
    response = client.get("/api/tuning/capabilities")
    assert response.status_code == 200
    return response.json()["defaults"]


def _mode_document(defaults: dict[str, Any], mode: str) -> dict[str, Any]:
    """The wire document the panel would send for `mode`, deep-copied so a
    test can move one knob without also moving the defaults it compares
    against (`project_mode` shares its sub-dicts with its input)."""
    return copy.deepcopy(project_mode(defaults, mode))


class TestTheConfigTheServerPublishesIsTheConfigItRuns:
    """AC 1.11 + 1.12, across surfaces: "the panel displays those same values"
    is only true if the two endpoints agree on the *string*, not just on the
    idea."""

    def test_ac_1_11_a_realtime_session_with_no_tuning_runs_the_published_defaults(
        self, client: TestClient, openai_session_call: list[dict[str, Any]]
    ) -> None:
        defaults = _published_defaults(client)

        response = client.post(
            "/api/realtime/session", json={"sourceLanguage": "en", "targetLanguage": "es"}
        )

        assert response.status_code == 200
        # A fresh browser hasn't stored anything, sends no `tuning`, and must
        # still see the chip the panel drew from `defaults`.
        assert response.json()["fingerprint"] == fingerprint(defaults, "realtime")

    def test_ac_1_11_a_cascade_session_with_no_tuning_reports_the_published_defaults(
        self, client: TestClient, recording_providers
    ) -> None:
        stt, _, _ = recording_providers
        defaults = _published_defaults(client)

        with client.websocket_connect("/ws/cascade") as ws:
            ws.send_json({"type": "start_session", "languages": ["en", "es"]})
            assert json.loads(ws.receive()["text"])["type"] == "session_started"
            applied = json.loads(ws.receive()["text"])
            ws.send_bytes(b"\x00\x01")
            _receive_until(ws, "source_transcript")

        assert applied["fingerprint"] == fingerprint(defaults, "cascade")
        # ...and the connection those published values describe is the one
        # that was actually opened.
        published = defaults["cascade"]["deepgram"]
        assert stt.calls == [
            DeepgramParams(
                model=published["model"],
                endpointing_ms=published["endpointingMs"],
                utterance_end_ms=published["utteranceEndMs"],
                diarize=published["diarize"],
            )
        ]

    def test_ac_1_2_and_1_3_one_knob_moved_in_the_panel_reaches_openai_and_moves_the_hash(
        self, client: TestClient, openai_session_call: list[dict[str, Any]]
    ) -> None:
        """The whole published document, with exactly one knob changed --
        which is how the researcher uses the lab, and a stricter input than
        the sparse fixture the unit tests send."""
        defaults = _published_defaults(client)
        document = _mode_document(defaults, "realtime")
        document["realtime"]["turnDetection"] = {"type": "server_vad", "silenceDurationMs": 300}

        response = client.post(
            "/api/realtime/session",
            json={"sourceLanguage": "en", "targetLanguage": "es", "tuning": document},
        )

        assert response.status_code == 200
        outbound = openai_session_call[-1]["session"]
        assert outbound["audio"]["input"]["turn_detection"] == {
            "type": "server_vad",
            "silence_duration_ms": 300,
        }
        # AC 1.3: the knobs left on "provider default" are absent, not restated.
        assert "threshold" not in outbound["audio"]["input"]["turn_detection"]
        assert "prefix_padding_ms" not in outbound["audio"]["input"]["turn_detection"]
        # AC 1.12: one knob moved => a different run.
        body = response.json()
        assert body["fingerprint"] == fingerprint(document, "realtime")
        assert body["fingerprint"] != fingerprint(defaults, "realtime")

    def test_ac_1_4_the_whole_published_document_is_honoured_on_the_cascade_socket(
        self, client: TestClient, recording_providers
    ) -> None:
        stt, _, _ = recording_providers
        defaults = _published_defaults(client)
        document = _mode_document(defaults, "cascade")
        document["cascade"]["deepgram"]["endpointingMs"] = 300
        document["cascade"]["segmentation"]["mode"] = "llm_priority"

        with client.websocket_connect("/ws/cascade") as ws:
            ws.send_json({"type": "start_session", "languages": ["en", "es"], "tuning": document})
            assert json.loads(ws.receive()["text"])["type"] == "session_started"
            applied = json.loads(ws.receive()["text"])
            ws.send_bytes(b"\x00\x01")
            _receive_until(ws, "source_transcript")

        assert applied["fingerprint"] == fingerprint(document, "cascade")
        assert stt.calls[0].endpointing_ms == 300


class TestValidationIsAsymmetricOnPurpose:
    """AC 5.7: the same out-of-allow-list value is a 400 over HTTP and a
    logged fallback over the WebSocket. Each half has its own unit test; the
    claim is about the pair."""

    def test_ac_5_7_the_same_bad_model_is_a_400_over_http_and_a_fallback_over_the_socket(
        self, client: TestClient, recording_providers
    ) -> None:
        stt, translation, _ = recording_providers
        defaults = _published_defaults(client)

        realtime_document = _mode_document(defaults, "realtime")
        realtime_document["realtime"]["model"] = "gpt-5-audio-imaginary"
        http_response = client.post(
            "/api/realtime/session",
            json={
                "sourceLanguage": "en",
                "targetLanguage": "es",
                "tuning": realtime_document,
            },
        )

        assert http_response.status_code == 400
        assert "gpt-5-audio-imaginary" in http_response.json()["detail"]

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(
                    deepgram={"model": "whisper-imaginary"},
                    translationModel="gpt-imaginary",
                ),
            )
            ws.send_bytes(b"\x00\x01")
            # The session survives: a full segment still comes back.
            _receive_until(ws, "target_transcript")

        assert stt.calls[0].model == defaults["cascade"]["deepgram"]["model"]
        assert translation.models[0] == defaults["cascade"]["translationModel"]


class TestTheNumbersTheReportPromises:
    """Story 2's claims about what a benchmark row is worth."""

    def test_ac_2_7_a_stage_that_runs_reports_what_it_cost_apart_from_the_provider(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A row has to say what a stage cost, which means the harness times
        the chain it ran and names it, separately from what the provider then
        took."""

        class _CostlyStage:
            name = "acceptance-stage"

            def process(self, frame: bytes) -> bytes:
                time.sleep(0.002)
                return frame

            def reset(self) -> None:
                pass

        stage = _CostlyStage()
        monkeypatch.setattr(stt_replay, "build_denoise_chain", lambda _cascade: [stage])
        monkeypatch.setattr(stt_replay, "TRAILING_SILENCE_S", 0.1)
        provider = _RecordingReplayProvider()
        monkeypatch.setattr(stt_replay, "DeepgramSTTProvider", lambda _key: provider)
        clip = _clip(tmp_path)

        result = asyncio.run(
            stt_replay.transcribe_wav_detailed(
                clip,
                "en",
                "es",
                "test-key",
                tuning=_cascade_document(),
                reference_text="hello there",
            )
        )

        assert result.stages == ["acceptance-stage"], "the row has to name what actually ran"
        assert result.added_latency_ms > 0, "a stage that ran cost something"
        assert result.provider_latency_ms >= 0
        # Two numbers, not one total: adding them would hide which was paid.
        assert result.added_latency_ms != result.provider_latency_ms

    def test_ac_2_2_a_row_stamped_with_a_fingerprint_was_measured_under_that_config(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A sweep row's join key is its fingerprint. Two configs differing
        only in `cascade.deepgram.endpointingMs` hash differently and must
        therefore *run* differently -- otherwise the sweep reports two rows
        for one measurement and the comparison is meaningless."""
        provider = _RecordingReplayProvider()
        monkeypatch.setattr(stt_replay, "DeepgramSTTProvider", lambda _key: provider)
        monkeypatch.setattr(stt_replay, "TRAILING_SILENCE_S", 0.1)
        clip = _clip(tmp_path)
        document = _cascade_document()
        document["cascade"]["deepgram"]["endpointingMs"] = 300
        document["cascade"]["deepgram"]["model"] = "nova-2"

        asyncio.run(
            stt_replay.transcribe_wav_detailed(clip, "en", "es", "test-key", tuning=document)
        )

        assert provider.stream_params is not None, (
            "the replay opened the Deepgram connection with no params at all, so the "
            "cascade.deepgram.* knobs in the fingerprint were never applied"
        )
        assert provider.stream_params.endpointing_ms == 300
        assert provider.stream_params.model == "nova-2"

    def test_ac_2_6_comparison_md_carries_the_tuning_section_and_its_provenance(self) -> None:
        """The story's deliverable is a place to paste the rows into, with the
        columns the report prints and the commands that reproduce them."""
        text = (REPO_ROOT / "COMPARISON.md").read_text(encoding="utf-8")

        assert "## 7. Tuning-config comparisons" in text
        section = text.split("## 7. Tuning-config comparisons", 1)[1]
        for column in (
            "fingerprint",
            "condition",
            "SNR",
            "WER",
            "corrected WER",
            "judge acceptance",
            "added latency",
            "provider latency",
        ):
            assert column in section, f"the §7 table has no {column!r} column"
        # Step 3 gate answer 2: the noisy conditions are report-only.
        assert "report-only" in section
        assert "run_tuning_sweep" in section


class _RecordingReplayProvider:
    """A `DeepgramSTTProvider` stand-in that records how the replay opened the
    connection -- both the constructor arguments and the per-stream params."""

    def __init__(self) -> None:
        self.stream_params: DeepgramParams | None = None
        self.chunks: list[bytes] = []

    async def stream(self, audio_chunks, *, languages, params: DeepgramParams | None = None):
        del languages
        self.stream_params = params
        async for chunk in audio_chunks:
            self.chunks.append(chunk)
        yield TranscriptSegment(text="hello there", is_final=True, speech_final=True)


def _cascade_document() -> dict[str, Any]:
    """The cascade projection of the server's own defaults, as a wire dict."""
    with TestClient(app) as client:
        defaults = _published_defaults(client)
    return _mode_document(defaults, "cascade")


def _clip(tmp_path: Path) -> Path:
    """A short mono 16-bit 16 kHz clip -- enough audio for the replay to pace
    a handful of frames through the chain."""
    path = tmp_path / "clip.wav"
    _write_tone(path, seconds=0.05)
    return path
