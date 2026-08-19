"""Ticket 08's tests for `fixtures/make_noisy_corpus.py`.

Runs the generator's real CLI entry point over a *synthetic* corpus written
into `tmp_path` -- a handful of pure tones standing in for the 33 TTS clips
in `tests/fixtures/audio/`. That's deliberate: the SNR maths is what's
being tested, and a tone whose exact samples are known lets the test
measure the SNR of each output back out of the written WAV file
(`noise = mixed - clean * peakScale`) instead of trusting the number the
generator put in the manifest. No real corpus, no API key, no `numpy`.
"""

import json
import math
import wave
from array import array
from datetime import datetime, timedelta
from pathlib import Path
from typing import Final

import pytest

from tests.fixtures.make_noisy_corpus import main

SAMPLE_RATE: Final = 16000
SNR_TOLERANCE_DB: Final = 0.5


def _write_tone(
    path: Path,
    *,
    frequency: float = 440.0,
    seconds: float = 1.0,
    amplitude: float = 0.5,
    sample_rate: int = SAMPLE_RATE,
    channels: int = 1,
) -> None:
    frame_count = int(sample_rate * seconds)
    samples = array("h")
    for index in range(frame_count):
        value = int(amplitude * 32767 * math.sin(2 * math.pi * frequency * index / sample_rate))
        samples.extend([value] * channels)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(samples.tobytes())


def _read_pcm(path: Path) -> array:
    with wave.open(str(path), "rb") as wav_file:
        return array("h", wav_file.readframes(wav_file.getnframes()))


def _wav_format(path: Path) -> tuple[int, int, int]:
    with wave.open(str(path), "rb") as wav_file:
        return wav_file.getnchannels(), wav_file.getsampwidth(), wav_file.getframerate()


def _rms(samples) -> float:
    return math.sqrt(sum(float(value) * value for value in samples) / len(samples))


def _measure_snr_db(clean: array, mixed: array, peak_scale: float) -> float:
    """Recovers the SNR of `mixed` without asking the generator: the speech
    component is the known clean signal scaled by the manifest's `peakScale`,
    so whatever is left over is exactly the noise that was mixed in."""
    speech = [value * peak_scale for value in clean]
    noise = [mixed[i] - speech[i] for i in range(len(speech))]
    return 20 * math.log10(_rms(speech) / _rms(noise))


def _make_corpus(tmp_path: Path, item_ids: tuple[str, ...]) -> tuple[Path, Path]:
    """A miniature stand-in for `interpreter_dataset.json` + `fixtures/audio/`.
    Each item gets its own pitch so the babble sources aren't a copy of the
    item they're mixed into."""
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir(exist_ok=True)
    items = []
    for index, item_id in enumerate(item_ids):
        _write_tone(audio_dir / f"{item_id}.wav", frequency=220.0 + 90 * index)
        items.append(
            {
                "id": item_id,
                "sourceLang": "en" if index % 2 == 0 else "es",
                "targetLang": "es" if index % 2 == 0 else "en",
                "text": f"utterance {index}",
                "referenceTranslation": f"enunciado {index}",
            }
        )
    dataset_path = tmp_path / "dataset.json"
    dataset_path.write_text(json.dumps({"items": items}), encoding="utf-8")
    return audio_dir, dataset_path


def _argv(audio_dir: Path, dataset_path: Path, out_dir: Path, *extra: str) -> list[str]:
    return [
        "--audio-dir",
        str(audio_dir),
        "--dataset",
        str(dataset_path),
        "--out-dir",
        str(out_dir),
        *extra,
    ]


def _generate(tmp_path: Path, audio_dir: Path, dataset_path: Path, *extra: str) -> tuple[int, Path]:
    out_dir = tmp_path / "noisy"
    return main(_argv(audio_dir, dataset_path, out_dir, *extra)), out_dir


def _manifest(out_dir: Path) -> dict:
    return json.loads((out_dir / "noisy_manifest.json").read_text(encoding="utf-8"))


def test_every_variant_is_16k_mono_16bit_at_its_labelled_snr(tmp_path: Path) -> None:
    audio_dir, dataset_path = _make_corpus(tmp_path, ("item-a", "item-b", "item-c", "item-d"))

    exit_code, out_dir = _generate(tmp_path, audio_dir, dataset_path, "--only", "item-a")
    assert exit_code == 0

    clean = _read_pcm(audio_dir / "item-a.wav")
    rows = [row for row in _manifest(out_dir)["items"] if row["condition"] != "clean"]

    assert {(row["condition"], row["snrDb"]) for row in rows} == {
        (condition, snr)
        for condition in ("babble", "street", "fan", "white")
        for snr in (20, 10, 5)
    }

    for row in rows:
        variant_path = out_dir / row["audioFile"]
        assert _wav_format(variant_path) == (1, 2, SAMPLE_RATE), row["id"]
        measured = _measure_snr_db(clean, _read_pcm(variant_path), row["peakScale"])
        assert abs(measured - row["snrDb"]) <= SNR_TOLERANCE_DB, (
            f"{row['id']}: measured {measured:.2f} dB against a {row['snrDb']} dB label"
        )
        assert abs(row["measuredSnrDb"] - measured) <= SNR_TOLERANCE_DB, row["id"]


def test_manifest_carries_the_brief_shape_and_a_clean_baseline_row(tmp_path: Path) -> None:
    audio_dir, dataset_path = _make_corpus(tmp_path, ("item-a", "item-b", "item-c", "item-d"))

    _, out_dir = _generate(tmp_path, audio_dir, dataset_path, "--seed", "99", "--only", "item-b")
    manifest = _manifest(out_dir)

    assert manifest["seed"] == 99
    assert manifest["sampleRate"] == SAMPLE_RATE
    generated_at = datetime.fromisoformat(manifest["generatedAt"])
    assert generated_at.utcoffset() == timedelta(0)

    for row in manifest["items"]:
        assert set(row) == {
            "id",
            "sourceItemId",
            "audioFile",
            "sourceLang",
            "targetLang",
            "referenceText",
            "referenceTranslation",
            "condition",
            "snrDb",
            "measuredSnrDb",
            "peakScale",
        }
        assert row["sourceItemId"] == "item-b"
        assert row["referenceText"] == "utterance 1"
        assert row["referenceTranslation"] == "enunciado 1"
        assert (row["sourceLang"], row["targetLang"]) == ("es", "en")
        assert (out_dir / row["audioFile"]).exists()

    clean_rows = [row for row in manifest["items"] if row["condition"] == "clean"]
    assert len(clean_rows) == 1
    assert clean_rows[0]["id"] == "item-b__clean"
    assert clean_rows[0]["snrDb"] is None
    assert clean_rows[0]["measuredSnrDb"] is None
    assert clean_rows[0]["peakScale"] == 1.0
    assert _read_pcm(out_dir / clean_rows[0]["audioFile"]) == _read_pcm(audio_dir / "item-b.wav")

    noisy = next(row for row in manifest["items"] if row["condition"] == "babble")
    assert noisy["id"] == f"item-b__babble__{noisy['snrDb']}dB"
    assert noisy["audioFile"] == f"{noisy['id']}.wav"


def test_same_seed_reproduces_identical_audio_and_a_new_seed_does_not(tmp_path: Path) -> None:
    audio_dir, dataset_path = _make_corpus(tmp_path, ("item-a", "item-b", "item-c", "item-d"))
    variant = "item-a__street__10dB.wav"

    runs = {}
    for run_name, seed in (("first", "1234"), ("second", "1234"), ("other-seed", "4321")):
        out_dir = tmp_path / run_name
        main(_argv(audio_dir, dataset_path, out_dir, "--only", "item-a", "--seed", seed))
        runs[run_name] = (out_dir / variant).read_bytes()

    assert runs["first"] == runs["second"]
    assert runs["first"] != runs["other-seed"]


def test_selecting_a_subset_does_not_change_the_audio_of_the_items_kept(tmp_path: Path) -> None:
    """`--only` / `--conditions` / `--snr` narrow what gets written; they must
    not perturb the noise of whatever's left, or two partial runs can't be
    compared against each other."""
    audio_dir, dataset_path = _make_corpus(tmp_path, ("item-a", "item-b", "item-c", "item-d"))
    variant = "item-a__fan__5dB.wav"

    full_dir = tmp_path / "full"
    main(_argv(audio_dir, dataset_path, full_dir))
    subset_dir = tmp_path / "subset"
    main(_argv(audio_dir, dataset_path, subset_dir, "--only", "item-a", "--conditions", "fan"))

    assert (full_dir / variant).read_bytes() == (subset_dir / variant).read_bytes()


def test_missing_and_wrong_format_sources_are_skipped_with_an_ffmpeg_hint(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    audio_dir, dataset_path = _make_corpus(
        tmp_path, ("item-a", "item-b", "item-c", "item-d", "gone", "wrong-format")
    )
    (audio_dir / "gone.wav").unlink()
    _write_tone(audio_dir / "wrong-format.wav", sample_rate=44100, channels=2)

    exit_code, out_dir = _generate(tmp_path, audio_dir, dataset_path)
    assert exit_code == 0

    output = capsys.readouterr().out
    assert "SKIP  gone: missing audio file" in output
    assert "44100Hz" in output and "2ch" in output
    for item_id in ("gone", "wrong-format"):
        assert f"-ar 16000 -ac 1 -sample_fmt s16 {audio_dir / f'{item_id}.wav'}" in output

    generated = {row["sourceItemId"] for row in _manifest(out_dir)["items"]}
    assert generated == {"item-a", "item-b", "item-c", "item-d"}
    assert not list(out_dir.glob("gone__*.wav"))


def test_babble_skips_itself_when_there_are_no_other_clips_to_overlay(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    audio_dir, dataset_path = _make_corpus(tmp_path, ("lonely",))

    exit_code, out_dir = _generate(tmp_path, audio_dir, dataset_path)
    assert exit_code == 0

    output = capsys.readouterr().out
    assert "SKIP  lonely babble" in output

    conditions = {row["condition"] for row in _manifest(out_dir)["items"]}
    assert conditions == {"clean", "street", "fan", "white"}
