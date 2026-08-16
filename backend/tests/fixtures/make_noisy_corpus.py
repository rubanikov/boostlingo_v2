"""Ticket 08's noisy-corpus generator: takes the clean TTS corpus in
`tests/fixtures/audio/` (written by `generate_audio_fixtures.py`) and mixes
each item with babble / street / fan / white noise at 20, 10 and 5 dB SNR,
writing the results plus a `noisy_manifest.json` into
`tests/fixtures/noisy/`. That corpus is what `run_tuning_sweep.py` and the
Realtime capture harness replay to score a `TuningConfig` against conditions
the clean corpus can't produce.

Run from `backend/`:

    uv run python -m tests.fixtures.make_noisy_corpus

No API key, no network, and **no numpy** -- everything here is stdlib
(`wave`, `array`, `math`, `random`), matching `stt_replay.py`'s and
`generate_audio_fixtures.py`'s hand-rolled WAV handling. Street, fan and
white are synthesised procedurally; babble is an overlay of other clips from
the same corpus (see `noisy/SCRIPT.md` for why, and for the self-skip when
those clips aren't there). Everything is seeded from `--seed`, so the same
seed produces byte-identical output.

Per-item skips are not failures: a missing or wrongly-formatted source WAV
prints the `ffmpeg` conversion command and the run continues with the rest,
exiting 0 (same posture as `run_real_audio_report.py`).
"""

import argparse
import json
import math
import random
import wave
from array import array
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from app.providers.deepgram_stt import SAMPLE_RATE
from tests.fixtures.stt_replay import WavFormatError, assert_wav_format

FIXTURES_DIR: Final = Path(__file__).parent
DATASET_PATH: Final = FIXTURES_DIR / "interpreter_dataset.json"
AUDIO_DIR: Final = FIXTURES_DIR / "audio"
NOISY_DIR: Final = FIXTURES_DIR / "noisy"
MANIFEST_NAME: Final = "noisy_manifest.json"

CONDITIONS: Final = ("babble", "street", "fan", "white")
DEFAULT_SNRS_DB: Final = (20, 10, 5)
DEFAULT_SEED: Final = 1234

_MAX_INT16: Final = 32767
_MIN_INT16: Final = -32768

# Fan: white noise through a one-pole low-pass (a fan is mostly rumble), with
# a slow amplitude wobble so it isn't perfectly stationary -- stationary noise
# is exactly the easy case `noisereduce`'s `stationary=True` mode is built for.
_FAN_CUTOFF_HZ: Final = 220.0
_FAN_WOBBLE_HZ: Final = 0.35
_FAN_WOBBLE_DEPTH: Final = 0.18

# Street: brown noise (traffic rumble) with the DC an integrator accumulates
# blocked off, plus the occasional short burst (a horn, a door, a passing car).
_STREET_LEAK: Final = 0.995
_STREET_DC_BLOCK: Final = 0.995
_STREET_BURST_INTERVAL_S: Final = 1.5
_STREET_BURST_MS: Final = (80, 220)
_STREET_BURST_GAIN: Final = 3.0

# Babble: how many other corpus utterances get overlaid. Below the minimum
# the condition is skipped rather than faked with two voices.
_BABBLE_MIN_SPEAKERS: Final = 3
_BABBLE_MAX_SPEAKERS: Final = 5

_FFMPEG_HINT: Final = "ffmpeg -i <original> -ar 16000 -ac 1 -sample_fmt s16 {path}"


@dataclass(frozen=True)
class MixedClip:
    """One mixed variant: the PCM to write plus the two numbers the manifest
    records about how it was made."""

    samples: array
    measured_snr_db: float
    peak_scale: float


def _rms(samples: Sequence[float]) -> float:
    return math.sqrt(sum(float(value) * value for value in samples) / len(samples))


def _read_pcm(path: Path) -> array:
    with wave.open(str(path), "rb") as wav_file:
        return array("h", wav_file.readframes(wav_file.getnframes()))


def _write_pcm(path: Path, samples: array) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)  # PCM16
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(samples.tobytes())


def white_noise(rng: random.Random, frame_count: int) -> list[float]:
    return [rng.gauss(0.0, 1.0) for _ in range(frame_count)]


def fan_noise(rng: random.Random, frame_count: int) -> list[float]:
    alpha = math.exp(-2 * math.pi * _FAN_CUTOFF_HZ / SAMPLE_RATE)
    wobble_phase = rng.uniform(0.0, 2 * math.pi)
    state = 0.0
    noise: list[float] = []
    for index in range(frame_count):
        state = alpha * state + (1.0 - alpha) * rng.gauss(0.0, 1.0)
        wobble = 1.0 + _FAN_WOBBLE_DEPTH * math.sin(
            2 * math.pi * _FAN_WOBBLE_HZ * index / SAMPLE_RATE + wobble_phase
        )
        noise.append(state * wobble)
    return noise


def street_noise(rng: random.Random, frame_count: int) -> list[float]:
    rumble: list[float] = []
    integrator = 0.0
    previous_input = 0.0
    blocked = 0.0
    for _ in range(frame_count):
        integrator = _STREET_LEAK * integrator + rng.gauss(0.0, 1.0)
        blocked = _STREET_DC_BLOCK * (blocked + integrator - previous_input)
        previous_input = integrator
        rumble.append(blocked)

    burst_gain = _STREET_BURST_GAIN * _rms(rumble)
    seconds = frame_count / SAMPLE_RATE
    for _ in range(max(1, round(seconds / _STREET_BURST_INTERVAL_S))):
        length = int(rng.uniform(*_STREET_BURST_MS) / 1000 * SAMPLE_RATE)
        start = rng.randrange(max(1, frame_count - length))
        for offset in range(min(length, frame_count - start)):
            # Raised-cosine envelope: a burst that starts and ends abruptly is
            # a click, which is a different (and much easier) test signal.
            envelope = 0.5 - 0.5 * math.cos(2 * math.pi * offset / length)
            rumble[start + offset] += burst_gain * envelope * rng.gauss(0.0, 1.0)
    return rumble


def babble_noise(rng: random.Random, frame_count: int, speakers: Sequence[array]) -> list[float]:
    """Overlays other corpus utterances, each level-matched to unit RMS and
    started at a random offset (wrapping around) so no two speakers line up."""
    babble = [0.0] * frame_count
    for speaker in speakers:
        scale = 1.0 / _rms(speaker)
        offset = rng.randrange(len(speaker))
        for index in range(frame_count):
            babble[index] += speaker[(offset + index) % len(speaker)] * scale
    return babble


def mix_at_snr(speech: array, noise: Sequence[float], snr_db: float) -> MixedClip:
    """RMS-matches `noise` to `speech`, scales it to sit `snr_db` below, and
    sums. The result is peak-normalised **only** if it would otherwise clip;
    that scales speech and noise equally, so it leaves the SNR untouched and
    is recorded as `peakScale` so a consumer can undo it.

    `measured_snr_db` is measured back out of the emitted 16-bit samples
    (speech component versus everything else), not restated from the request,
    so quantisation and any clamping are included in the number.
    """
    speech_rms = _rms(speech)
    noise_rms = _rms(noise)
    gain = speech_rms * (10 ** (-snr_db / 20)) / noise_rms

    mixed = [speech[index] + gain * noise[index] for index in range(len(speech))]
    peak = max(abs(value) for value in mixed)
    peak_scale = _MAX_INT16 / peak if peak > _MAX_INT16 else 1.0

    samples = array(
        "h", (max(_MIN_INT16, min(_MAX_INT16, round(value * peak_scale))) for value in mixed)
    )
    speech_component = [value * peak_scale for value in speech]
    residual = [samples[index] - speech_component[index] for index in range(len(samples))]
    return MixedClip(
        samples=samples,
        measured_snr_db=20 * math.log10(_rms(speech_component) / _rms(residual)),
        peak_scale=peak_scale,
    )


def _condition_rng(seed: int, item_id: str, condition: str) -> random.Random:
    """One stream per (item, condition) so `--only` and `--conditions` can't
    shift anyone else's noise, and so an item's SNR ladder is the same noise
    at three levels rather than three unrelated noises."""
    return random.Random(f"{seed}:{item_id}:{condition}")


def _babble_speaker_ids(rng: random.Random, item: dict, corpus: list[dict]) -> list[str]:
    """Picks 3-5 other utterances, preferring an other-language/same-language
    alternation so the babble isn't a monolingual chorus."""
    same_language, other_language = [], []
    for candidate in corpus:
        if candidate["id"] == item["id"]:
            continue
        bucket = same_language if candidate["sourceLang"] == item["sourceLang"] else other_language
        bucket.append(candidate["id"])
    rng.shuffle(same_language)
    rng.shuffle(other_language)

    interleaved: list[str] = []
    for first, second in zip(other_language, same_language, strict=False):
        interleaved += [first, second]
    interleaved += other_language[len(same_language) :] + same_language[len(other_language) :]

    wanted = rng.randint(_BABBLE_MIN_SPEAKERS, _BABBLE_MAX_SPEAKERS)
    return interleaved[:wanted]


def _build_noise(
    condition: str,
    rng: random.Random,
    frame_count: int,
    speakers: Sequence[array],
) -> list[float]:
    if condition == "white":
        return white_noise(rng, frame_count)
    if condition == "fan":
        return fan_noise(rng, frame_count)
    if condition == "street":
        return street_noise(rng, frame_count)
    return babble_noise(rng, frame_count, speakers)


def _manifest_row(
    item: dict,
    condition: str,
    snr_db: int | None,
    measured_snr_db: float | None,
    peak_scale: float,
) -> dict:
    suffix = condition if snr_db is None else f"{condition}__{snr_db}dB"
    variant_id = f"{item['id']}__{suffix}"
    return {
        "id": variant_id,
        "sourceItemId": item["id"],
        "audioFile": f"{variant_id}.wav",
        "sourceLang": item["sourceLang"],
        "targetLang": item["targetLang"],
        "referenceText": item["text"],
        "referenceTranslation": item["referenceTranslation"],
        "condition": condition,
        "snrDb": snr_db,
        "measuredSnrDb": measured_snr_db,
        "peakScale": peak_scale,
    }


def _read_babble_source(path: Path) -> array | None:
    """A babble source that isn't usable is dropped quietly -- it gets its own
    skip line when the run reaches it as an item in its own right."""
    if not path.exists():
        return None
    try:
        assert_wav_format(path)
    except WavFormatError:
        return None
    pcm = _read_pcm(path)
    return pcm if pcm and _rms(pcm) > 0.0 else None


def _babble_speakers(
    rng: random.Random,
    item: dict,
    corpus: list[dict],
    audio_dir: Path,
    cache: dict[str, array],
) -> list[array]:
    speakers = []
    for speaker_id in _babble_speaker_ids(rng, item, corpus):
        if speaker_id not in cache:
            pcm = _read_babble_source(audio_dir / f"{speaker_id}.wav")
            if pcm is None:
                continue
            cache[speaker_id] = pcm
        speakers.append(cache[speaker_id])
    return speakers


def _load_source(path: Path, item_id: str, skips: list[str]) -> array | None:
    """Reads one clean item, or reports why it can't be used and returns None.
    A missing or wrongly-formatted file prints the `ffmpeg` command that fixes
    it; no failure here stops the run."""
    if not path.exists():
        skips.append(f"{item_id}: missing audio file")
        print(f"SKIP  {item_id}: missing audio file: {path}")
        print("      generate it with: uv run python tests/fixtures/generate_audio_fixtures.py")
        print(f"      or convert a recording: {_FFMPEG_HINT.format(path=path)}")
        return None
    try:
        assert_wav_format(path)
    except WavFormatError as exc:
        skips.append(f"{item_id}: wrong format")
        print(f"SKIP  {exc}")
        print(f"      convert with: {_FFMPEG_HINT.format(path=path)}")
        return None

    pcm = _read_pcm(path)
    if not pcm or _rms(pcm) == 0.0:
        skips.append(f"{item_id}: silent or empty")
        print(f"SKIP  {item_id}: {path} is silent or empty -- nothing to mix noise into")
        return None
    return pcm


def _print_summary(rows: list[dict], snrs: Sequence[int], skips: list[str], out_dir: Path) -> None:
    generated = {row["condition"] for row in rows}
    conditions = [condition for condition in CONDITIONS if condition in generated]
    header = "condition  " + "".join(f"{f'{snr} dB':>26}" for snr in snrs)
    print("\n=== noisy corpus ===")
    print(header)
    print("-" * len(header))
    for condition in conditions:
        cells = []
        for snr in snrs:
            measured = [
                r["measuredSnrDb"] for r in rows if r["condition"] == condition and r["snrDb"] == snr
            ]
            cells.append(
                f"{len(measured):3d} items {min(measured):6.2f}..{max(measured):6.2f}"
                if measured
                else f"{'-':>26}"
            )
        print(f"{condition:<11}" + "".join(f"{cell:>26}" for cell in cells))

    clean_count = sum(1 for row in rows if row["condition"] == "clean")
    print(
        f"\n{len(rows)} manifest rows ({clean_count} clean baseline + {len(rows) - clean_count} "
        f"noisy) written to {out_dir}"
    )
    if skips:
        print(f"{len(skips)} skipped: " + "; ".join(skips))
    else:
        print("0 skipped")


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m tests.fixtures.make_noisy_corpus",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="noise seed (default 1234)")
    parser.add_argument(
        "--only", action="append", metavar="ID", help="restrict to this item id (repeatable)"
    )
    parser.add_argument(
        "--conditions",
        default=",".join(CONDITIONS),
        help=f"comma-separated subset of {','.join(CONDITIONS)}",
    )
    parser.add_argument(
        "--snr",
        default=",".join(str(snr) for snr in DEFAULT_SNRS_DB),
        help="comma-separated SNRs in dB (default 20,10,5)",
    )
    parser.add_argument("--out-dir", type=Path, default=NOISY_DIR)
    parser.add_argument("--dataset", type=Path, default=DATASET_PATH)
    parser.add_argument("--audio-dir", type=Path, default=AUDIO_DIR)
    args = parser.parse_args(argv)

    args.conditions = [name.strip() for name in args.conditions.split(",") if name.strip()]
    unknown = [name for name in args.conditions if name not in CONDITIONS]
    if unknown:
        parser.error(f"unknown condition(s) {unknown} -- pick from {','.join(CONDITIONS)}")
    try:
        args.snr = [int(value) for value in args.snr.split(",") if value.strip()]
    except ValueError:
        parser.error(f"--snr must be comma-separated integers, got {args.snr!r}")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    corpus = json.loads(args.dataset.read_text(encoding="utf-8"))["items"]
    selected = [item for item in corpus if not args.only or item["id"] in args.only]
    args.out_dir.mkdir(parents=True, exist_ok=True)

    speaker_cache: dict[str, array] = {}
    rows: list[dict] = []
    skips: list[str] = []

    for item in selected:
        speech = _load_source(args.audio_dir / f"{item['id']}.wav", item["id"], skips)
        if speech is None:
            continue

        clean_row = _manifest_row(item, "clean", None, None, 1.0)
        _write_pcm(args.out_dir / clean_row["audioFile"], speech)
        rows.append(clean_row)

        for condition in args.conditions:
            rng = _condition_rng(args.seed, item["id"], condition)
            speakers: list[array] = []
            if condition == "babble":
                speakers = _babble_speakers(rng, item, corpus, args.audio_dir, speaker_cache)
                if len(speakers) < _BABBLE_MIN_SPEAKERS:
                    skips.append(f"{item['id']}: babble (needs {_BABBLE_MIN_SPEAKERS} other clips)")
                    print(
                        f"SKIP  {item['id']} babble: only {len(speakers)} other usable clip(s) in "
                        f"{args.audio_dir} -- babble overlays other corpus utterances, so it needs "
                        f"at least {_BABBLE_MIN_SPEAKERS}. Other conditions still generated."
                    )
                    continue

            noise = _build_noise(condition, rng, len(speech), speakers)
            for snr_db in args.snr:
                clip = mix_at_snr(speech, noise, snr_db)
                row = _manifest_row(
                    item,
                    condition,
                    snr_db,
                    round(clip.measured_snr_db, 2),
                    round(clip.peak_scale, 6),
                )
                _write_pcm(args.out_dir / row["audioFile"], clip.samples)
                rows.append(row)

    manifest = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "seed": args.seed,
        "sampleRate": SAMPLE_RATE,
        "items": rows,
    }
    (args.out_dir / MANIFEST_NAME).write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    _print_summary(rows, args.snr, skips, args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
