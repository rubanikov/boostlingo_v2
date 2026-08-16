# Noisy benchmark corpus

The clean corpus (`tests/fixtures/audio/*.wav`, 33 TTS clips) says how the
pipeline does in a quiet room. This directory says how it does everywhere
else: the same 33 utterances mixed with babble, street, fan and white noise
at 20, 10 and 5 dB SNR, which is what a `TuningConfig` gets scored against by
`run_tuning_sweep.py` and by the Realtime capture harness.

Nothing here is committed except this file — see [Why the audio isn't
committed](#why-the-audio-isnt-committed).

## Regenerate it

From `backend/`:

```
uv run python -m tests.fixtures.make_noisy_corpus
```

Takes about 35 seconds and writes ~430 WAVs (~37 MB) plus
`noisy_manifest.json`. No API key, no network, no `numpy` — the whole thing is
stdlib (`wave`, `array`, `math`, `random`), matching `stt_replay.py`'s and
`generate_audio_fixtures.py`'s hand-rolled WAV handling.

Options:

| flag | default | what it does |
|---|---|---|
| `--seed N` | `1234` | seeds every noise stream; the same seed produces byte-identical output |
| `--only ID` | all 33 | restrict to one item (repeatable) |
| `--conditions babble,street,fan,white` | all four | subset of conditions |
| `--snr 20,10,5` | `20,10,5` | SNRs in dB |
| `--out-dir DIR` | `tests/fixtures/noisy` | where the WAVs and the manifest go |
| `--dataset PATH` / `--audio-dir DIR` | the fixture corpus | point at a different corpus (the tests use this) |

Narrowing the run doesn't perturb what's left: the noise stream is seeded per
`(seed, item, condition)`, so `--only short-en-01` produces exactly the clips a
full run would have produced for that item. An item's three SNR variants are
the *same* noise at three levels, not three unrelated noises, so a WER
difference across the ladder is about level and nothing else.

**First run the clean corpus generator** if `tests/fixtures/audio/` is empty
(`uv run python tests/fixtures/generate_audio_fixtures.py`, needs a live
`ELEVENLABS_API_KEY`). Without it there is nothing to add noise to, and every
item skips.

## The conditions

Every output is mono 16-bit PCM at 16 kHz — the format
`DeepgramSTTProvider` expects and the format the clean fixtures already use.

| condition | how it's made |
|---|---|
| `clean` | the untouched source clip, copied in so the baseline is a first-class manifest row rather than a special case every consumer has to code around. `snrDb: null`. |
| `white` | Gaussian white noise. The flat-spectrum control case. |
| `fan` | white noise through a one-pole 220 Hz low-pass (a fan is mostly rumble), with a slow 0.35 Hz amplitude wobble at 18% depth so it isn't perfectly stationary — perfectly stationary noise is precisely the easy case `noisereduce`'s `stationary=True` mode is built for, and a corpus made only of it would flatter that setting. |
| `street` | brown noise (leaky-integrated white, then a DC-blocking high-pass) for traffic rumble, plus roughly one short burst per 1.5 s — an 80–220 ms raised-cosine-enveloped noise event at 3× RMS, standing in for a horn, a door, a passing car. Bursts are enveloped rather than square so they're not just clicks. |
| `babble` | 3–5 **other utterances from this same corpus**, each level-matched to equal RMS, each started at a random offset and wrapped around to cover the clip. Speakers are picked alternating other-language / same-language relative to the item, so the babble is bilingual rather than a monolingual chorus. |

### Why babble reuses the corpus, and what happens when it can't

Babble is the one condition that can't be synthesised convincingly — "several
overlaid speakers" needs actual speech. Two options were on the table:
call ElevenLabs for fresh babble voices (which would make this script
key-gated and its output non-reproducible), or overlay the TTS clips that are
already on disk. **This script does the latter**: it stays key-free,
network-free and fully reproducible from `--seed`, which is what lets the
tests run it in CI with no secrets.

The cost is a self-skip. If `tests/fixtures/audio/` holds fewer than 3 other
usable clips, babble is skipped for that item with a printed message and the
other conditions are still generated — no faked two-voice babble, no failed
run. The same posture applies per item: a missing or wrongly-formatted source
WAV prints the `ffmpeg` conversion command and the run continues, exiting 0
(same as `run_real_audio_report.py`).

One consequence worth knowing when reading results: the babble speakers are
the same voice as the target utterance, because the whole corpus was
synthesised from one ElevenLabs voice. That's harder than real babble for
diarization and speaker separation, not easier.

## SNR mixing

Noise is RMS-matched to the clip's speech RMS, then scaled by `10^(-snr/20)`,
then summed. If the sum would clip, the whole mix (speech *and* noise
together) is scaled down to fit — which leaves the ratio between them
untouched — and the factor is recorded as `peakScale`, so a consumer can
recover the original level. At 5 dB on a loud TTS clip `peakScale` runs as low
as ~0.63; that's expected, and it's why the field exists.

`measuredSnrDb` is measured back out of the emitted 16-bit samples (speech
component versus everything else), not restated from the request, so
quantisation and any clamping show up in the number. It lands within 0.01 dB
of the label in practice; `tests/test_noisy_corpus.py` asserts ±0.5 dB against
an SNR the test recomputes from the WAV files itself.

## The manifest

`noisy_manifest.json`, next to the WAVs:

```jsonc
{
  "generatedAt": "2026-08-16T00:36:41.581224+00:00",   // UTC, ISO 8601
  "seed": 1234,
  "sampleRate": 16000,
  "items": [
    {
      "id": "short-en-01__babble__10dB",       // <sourceItemId>__<condition>__<snr>dB
      "sourceItemId": "short-en-01",
      "audioFile": "short-en-01__babble__10dB.wav",
      "sourceLang": "en",
      "targetLang": "es",
      "referenceText": "Hi, how are you doing today?",        // inherited from interpreter_dataset.json
      "referenceTranslation": "Hola, ¿cómo estás hoy?",
      "condition": "babble",                   // clean | babble | street | fan | white
      "snrDb": 10,                             // null for the clean row
      "measuredSnrDb": 10.0,                   // null for the clean row
      "peakScale": 1.0
    }
  ]
}
```

Every row's `audioFile` is in this directory, clean rows included, so a
consumer iterates one flat list and never has to reach back into
`tests/fixtures/audio/`.

## Why the audio isn't committed

Same convention as `tests/fixtures/audio/` and
`tests/fixtures/realtime_quality/`: generated audio is not committed, the
script and this file are. Here the argument is even simpler — the output is a
pure function of the clean fixtures and `--seed`, so ~430 WAVs in git history
would be 37 MB of something anyone can reproduce byte for byte in 35 seconds.
`.gitignore` covers `noisy/*.wav` and `noisy/noisy_manifest.json`.
