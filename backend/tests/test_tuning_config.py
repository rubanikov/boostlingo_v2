"""Ticket 01: the Python half of the cross-language fingerprint contract.

The canonicalisation rules asserted here are the contract itself (brief
"Fingerprint algorithm (exact)"), so the expected values are written out as
literal canonical JSON rather than re-derived from the implementation.

The parity half (S1) reads `shared/tuning-fingerprint-cases.json` at the repo
root -- the same bytes `frontend/src/pages/tuningConfig.test.ts` reads. A
fixture that isn't literally the same file on both sides proves nothing.
"""

import hashlib
import json
from pathlib import Path

import pytest

from app.api import realtime as realtime_api
from app.config import settings
from app.providers import deepgram_stt, openai_translation, segmentation_checker
from app.tuning.defaults import default_tuning_config
from app.tuning.fingerprint import (
    canonical_document,
    canonicalize,
    fingerprint,
    project_mode,
)
from app.tuning.schema import TUNING_SCHEMA_VERSION, CascadeTuning, RealtimeTuning

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / "shared" / "tuning-fingerprint-cases.json"
)


def _fixture_cases() -> list[dict]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# S2 -- canonicalisation
# ---------------------------------------------------------------------------


class TestCanonicalisation:
    def test_absent_keys_are_omitted_and_falsey_values_are_kept(self) -> None:
        """`None` is "provider default, don't send the key"; `false`/`0`/`""`/
        `[]` are real values a user chose and must survive into the hash."""
        doc = {"kept": False, "zero": 0, "empty": "", "list": [], "gone": None}

        assert canonicalize(doc) == '{"empty":"","kept":false,"list":[],"zero":0}'

    def test_nested_absent_keys_are_omitted(self) -> None:
        doc = {"turnDetection": {"type": "server_vad", "threshold": None}}

        assert canonicalize(doc) == '{"turnDetection":{"type":"server_vad"}}'

    def test_keys_are_sorted_at_every_level(self) -> None:
        doc = {"b": {"z": 1, "a": 2}, "a": 3}

        assert canonicalize(doc) == '{"a":3,"b":{"a":2,"z":1}}'

    def test_integral_floats_are_emitted_without_a_decimal_point(self) -> None:
        doc = {"client": {"rmsGate": {"thresholdDbfs": -45.0, "attenuationDb": 12.0}}}

        assert (
            canonicalize(doc)
            == '{"client":{"rmsGate":{"attenuationDb":12,"thresholdDbfs":-45}}}'
        )

    def test_float_knobs_are_quantised_to_their_documented_step(self) -> None:
        """`propDecrease` has step 0.05, so 0.87 is not a reachable value: it
        quantises to 0.85 before hashing. Both languages must do this."""
        doc = {"cascade": {"denoise": {"noisereduce": {"propDecrease": 0.87}}}}

        assert (
            canonicalize(doc)
            == '{"cascade":{"denoise":{"noisereduce":{"propDecrease":0.85}}}}'
        )

    def test_post_filter_beta_uses_step_0_01_not_the_briefs_0_05(self) -> None:
        """Deviation, flagged in `_KNOB_RANGES` and mirrored in
        `tuningConfig.ts`: the knob's own documented default (0.02) is not on
        a 0.05 grid, so a 0.05 step would quantise the default to 0."""
        doc = {"cascade": {"denoise": {"deepfilternet": {"postFilterBeta": 0.02}}}}

        assert (
            canonicalize(doc)
            == '{"cascade":{"denoise":{"deepfilternet":{"postFilterBeta":0.02}}}}'
        )

    def test_quantised_floats_carry_no_binary_noise(self) -> None:
        """0.35 / 0.05 * 0.05 is 0.35000000000000003 in IEEE-754. The
        round-to-2-decimals step is what keeps Python's `repr` and JS's
        `String()` agreeing on `0.35`."""
        doc = {"client": {"rnnoise": {"voiceProbThreshold": 0.35}}}

        assert canonicalize(doc) == '{"client":{"rnnoise":{"voiceProbThreshold":0.35}}}'

    def test_knobs_are_clamped_to_their_documented_range(self) -> None:
        doc = {
            "client": {"rmsGate": {"thresholdDbfs": -400}},
            "cascade": {"deepgram": {"endpointingMs": 99999}},
        }

        assert canonicalize(doc) == (
            '{"cascade":{"deepgram":{"endpointingMs":5000}},'
            '"client":{"rmsGate":{"thresholdDbfs":-80}}}'
        )

    def test_no_whitespace_and_no_ascii_escaping(self) -> None:
        doc = {"ttsVoiceA": "café"}

        assert canonicalize(doc) == '{"ttsVoiceA":"café"}'

    def test_canonical_document_is_the_dict_form_of_the_same_projection(self) -> None:
        doc = {"b": None, "a": 1.0}

        assert canonical_document(doc) == {"a": 1}
        assert canonicalize(doc) == json.dumps(
            canonical_document(doc),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )


# ---------------------------------------------------------------------------
# Projection + fingerprint
# ---------------------------------------------------------------------------


class TestProjection:
    def test_projection_keeps_only_the_shared_block_and_the_active_mode(self) -> None:
        config = default_tuning_config()

        realtime_doc = project_mode(config, "realtime")
        cascade_doc = project_mode(config, "cascade")

        assert set(realtime_doc) == {"schemaVersion", "mode", "client", "realtime"}
        assert set(cascade_doc) == {"schemaVersion", "mode", "client", "cascade"}
        assert realtime_doc["mode"] == "realtime"
        assert cascade_doc["mode"] == "cascade"

    def test_mode_is_inside_the_hash_so_the_same_knobs_hash_differently_per_mode(
        self,
    ) -> None:
        config = default_tuning_config()

        assert fingerprint(config, "realtime") != fingerprint(config, "cascade")


class TestFingerprint:
    def test_is_the_first_eight_hex_digits_of_the_canonical_sha256(self) -> None:
        canonical = canonicalize(project_mode(default_tuning_config(), "cascade"))
        expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:8]

        assert fingerprint(default_tuning_config(), "cascade") == f"cfg:{expected}"

    def test_key_order_does_not_change_the_fingerprint(self) -> None:
        config = default_tuning_config().model_dump(by_alias=True)
        reordered = {key: config[key] for key in reversed(list(config))}
        reordered["cascade"] = {
            key: config["cascade"][key] for key in reversed(list(config["cascade"]))
        }

        assert fingerprint(reordered, "cascade") == fingerprint(config, "cascade")

    def test_e11_a_schema_version_bump_changes_the_fingerprint(self) -> None:
        config = default_tuning_config().model_dump(by_alias=True)
        bumped = {**config, "schemaVersion": 2}

        assert fingerprint(bumped, "realtime") != fingerprint(config, "realtime")
        assert fingerprint(bumped, "cascade") != fingerprint(config, "cascade")

    def test_absent_optional_key_hashes_differently_from_an_explicit_value(
        self,
    ) -> None:
        config = default_tuning_config().model_dump(by_alias=True)
        explicit = json.loads(json.dumps(config))
        explicit["realtime"]["turnDetection"]["threshold"] = 0.5

        assert config["realtime"]["turnDetection"].get("threshold") is None
        assert fingerprint(explicit, "realtime") != fingerprint(config, "realtime")


# ---------------------------------------------------------------------------
# S1 -- cross-language parity fixture
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", _fixture_cases(), ids=lambda case: case["name"])
def test_s1_fingerprint_matches_the_shared_parity_fixture(case: dict) -> None:
    assert fingerprint(case["config"], case["mode"]) == case["expectedFingerprint"]


def test_s1_fixture_covers_both_modes_and_a_reordered_duplicate() -> None:
    """Guards the fixture itself: without a reordered pair and both modes,
    S1 can pass while the two implementations still disagree in practice."""
    cases = _fixture_cases()
    modes = {case["mode"] for case in cases}
    hashes = [case["expectedFingerprint"] for case in cases]

    assert modes == {"realtime", "cascade"}
    assert len(cases) >= 6
    assert len(hashes) > len(set(hashes)), "no key-reordered duplicate case present"


# ---------------------------------------------------------------------------
# Defaults come from the server's own configuration, not from blanks (AC 1.11)
# ---------------------------------------------------------------------------


class TestDefaults:
    def test_defaults_mirror_the_provider_constants(self) -> None:
        config = default_tuning_config()

        assert config.schema_version == TUNING_SCHEMA_VERSION
        assert config.realtime.model == realtime_api.REALTIME_MODEL
        assert config.realtime.voice == realtime_api.REALTIME_VOICE
        assert config.cascade.deepgram.model == deepgram_stt.MODEL
        assert config.cascade.deepgram.endpointing_ms == deepgram_stt.ENDPOINTING_MS
        assert config.cascade.deepgram.utterance_end_ms == deepgram_stt.UTTERANCE_END_MS
        assert config.cascade.translation_model == openai_translation.MODEL
        assert config.cascade.segmentation.model == segmentation_checker.MODEL
        assert config.cascade.tts_voice_a == settings.elevenlabs_voice_id
        assert config.cascade.tts_voice_b == settings.elevenlabs_voice_id_speaker_b

    def test_static_schema_defaults_do_not_drift_from_the_provider_constants(
        self,
    ) -> None:
        """`schema.py` deliberately imports nothing from `app` (see its
        docstring), so this is the guard that its literal defaults stay equal
        to the constants `defaults.py` reads."""
        assert RealtimeTuning().model == realtime_api.REALTIME_MODEL
        assert RealtimeTuning().voice == realtime_api.REALTIME_VOICE
        assert CascadeTuning().deepgram.model == deepgram_stt.MODEL
        assert CascadeTuning().deepgram.endpointing_ms == deepgram_stt.ENDPOINTING_MS
        assert (
            CascadeTuning().deepgram.utterance_end_ms == deepgram_stt.UTTERANCE_END_MS
        )
        assert CascadeTuning().translation_model == openai_translation.MODEL

    def test_unset_vad_settings_leave_the_keys_absent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "realtime_vad_silence_ms", None)
        monkeypatch.setattr(settings, "realtime_vad_interrupt_response", None)

        turn_detection = default_tuning_config().realtime.turn_detection

        assert turn_detection.silence_duration_ms is None
        assert turn_detection.interrupt_response is None
        assert "silenceDurationMs" not in canonicalize(
            project_mode(default_tuning_config(), "realtime")
        )

    def test_the_tracer_bullet_env_change_moves_the_fingerprint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The ticket's demo: change `REALTIME_VAD_SILENCE_MS` in
        `backend/.env`, restart, watch the chip change."""
        monkeypatch.setattr(settings, "realtime_vad_silence_ms", None)
        before = fingerprint(default_tuning_config(), "realtime")

        monkeypatch.setattr(settings, "realtime_vad_silence_ms", 900)
        after = fingerprint(default_tuning_config(), "realtime")

        assert before != after
        assert (
            default_tuning_config().realtime.turn_detection.silence_duration_ms == 900
        )
