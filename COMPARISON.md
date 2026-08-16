# Comparison Write-Up: Realtime API vs. Cascade Pipeline

Both modes are fully built and tested against mocked provider boundaries (see [AGENTS.md](AGENTS.md)).
Every number below is either computed from current public pricing (cost) or measured
against the live app with real API keys (latency, quality) — none of it is fabricated.
Live numbers come from an automated fake-mic run (Playwright driving the real UI against
the real backend, real Deepgram/OpenAI/ElevenLabs calls, a single short sentence repeated
across several turns), not a long natural human conversation — real measurements, a
narrower scenario than full manual testing would cover. Exact commands to reproduce or
extend these runs are given inline below.

## 1. Latency

The two modes measure latency in structurally different ways: a direct consequence of
Ticket 3's transport decision, and the first concrete instance of the controllability gap
in §4.

**Cascade** owns every stage server-side, so `app/orchestrator.py` emits a `latency` WS
message per segment at each of six stages: `stt_final` (a standalone pre-reference
duration: how long the finished transcript waited on the segmentation decision before the
cut), then `speech_end` → `translation_first_token` → `translation_complete` →
`tts_first_byte` → `playback_start`, each of those `ms` cumulative since `speech_end`.
Clock offset resyncs every 30s and after reconnects. Target **< 2s**. (The measured
numbers below predate the `stt_final` stage; the cumulative stages they report are
unchanged by its addition.)

**Realtime** mints an ephemeral token and is then off the audio path entirely (WebRTC goes
browser ↔ OpenAI directly), so no server-side sub-stage timestamps are possible. The
frontend measures one client-side proxy: `speech_stopped` → first
`response.output_audio_transcript.delta` (`src/pages/realtimeLatency.ts`), a reasonable
stand-in for "reply starting," not a frame-accurate playback timestamp. Target **< 1.5s**.

Measured live, 2026-08-12, EN→ES, "Hi, how are you doing today?" (Cascade: 7 segments;
Realtime: 3 turns):

| Mode | Stage | Result |
|---|---|---|
| Cascade | `translation_first_token` (mean) | 656ms |
| Cascade | `translation_complete` (mean) | 763ms |
| Cascade | `tts_first_byte` (mean) | 931ms |
| Cascade | `playback_start` (benchmark, mean / range) | **939ms** / 830-1199ms |
| Realtime | end-to-end (`speech_stopped` → first transcript delta) | **283-395ms** (395, 285, 369ms) |
| Realtime | same proxy, 33 real-voice turns, VAD at defaults (the §2 quality run, 2026-08-15) | median **319ms**, mean 382ms, p90 576ms, range 168-1500ms |
| Realtime | same proxy, same 33 turns, VAD tuned (§2) | median **286ms**, mean 303ms, p90 514ms, range 176-743ms |

Both comfortably clear their targets (Cascade < 2s, Realtime < 1.5s) — Realtime especially
so, by roughly 4-5x, consistent with §4's controllability trade: fewer stages, less to
inspect, but a real latency-floor advantage. The 33-turn samples confirm the three-turn
number wasn't a lucky draw; the default run's two 1500ms outliers are both turns where
server VAD split the utterance and cancelled a reply mid-stream (see §2), so the proxy
measured from the *last* speech-stop to a restarted response. One caveat the proxy hides:
the tuned run's 900ms silence window is extra time the listener waits *before*
`speech_stopped` fires, so its true perceived latency is roughly 400ms worse than the
default run's, not better, even though the post-turn number is smaller.

**To extend with more/longer/natural-conversation runs:** set real API keys in
`backend/.env`, start both servers ([README](README.md#running-the-dev-servers)), and
either use the app directly (read the UI's latency strip / end-to-end badge) or open
devtools and watch the raw `latency` WS messages (Cascade) / `oai-events` data-channel
timestamps (Realtime).

## 2. Quality

Ticket 8 built two pipelines against the same 33-item EN↔ES dataset
(`backend/tests/fixtures/interpreter_dataset.json`), both now run against live APIs.

**WER (Cascade STT only)**: `test_quality_wer.py` TTS-generates each item's source text,
replays it through the real `DeepgramSTTProvider`, and asserts `jiwer.wer` below a 20%
threshold. **LLM-as-judge**: `app/quality/llm_judge.py` scores a candidate translation and
reports *what's* wrong (lost tense, wrong register, dropped negation), not just a score.
`backend/tests/fixtures/run_quality_report.py` runs it over all 33 items through Cascade's
real translation stage.

**Asymmetry**: only Cascade has an exposed, independently-callable `translate()` step.
Realtime's translation happens inside the opaque `gpt-realtime` model, so its quality
number has to come from real audio sessions: `frontend/e2e/realtime-quality-capture.mjs`
plays each recorded clip of the same 33-item corpus into a live session through
Chromium's fake-mic device and captures the model's output transcript per turn, and
`backend/tests/fixtures/run_realtime_quality_report.py` judges those captures with the
same `judge_translation()`. Same backend-off-the-audio-path asymmetry as §1: Cascade's
number reads the dataset text directly, Realtime's needs a microphone in the loop.

Measured live, 2026-08-12, all 33 dataset items:

| Metric | Result |
|---|---|
| Cascade WER, EN source (n=18) | **0.7%** |
| Cascade WER, ES source (n=15) | **0.0%** |
| Cascade WER, overall | **0.4%** |
| Cascade LLM-judge acceptance rate (33 items) | **33/33 (100%)** |
| Realtime LLM-judge acceptance rate, **VAD at OpenAI defaults** (33 real-voice clips, run 2026-08-15) | **19/33 (58%)** |
| — short single-clause items only (n=18) / long + multi-turn (n=15) | 13/18 (72%) / 6/15 (40%) |
| Realtime LLM-judge acceptance rate, **VAD tuned** (`silence_duration_ms=900`, `interrupt_response=false`; same 33 clips, same day) | **31/33 (94%)** |
| — short single-clause items only (n=18) / long + multi-turn (n=15) | 18/18 (100%) / 13/15 (87%) |

WER this low (clean, single-speaker, TTS-generated audio — no room noise or accent
variation) is expected per `test_quality_wer.py`'s own threshold reasoning, not a surprise;
it's real headroom under the 20% regression bar, not evidence the bar is too loose (a
noisier real-recording corpus, see `run_real_audio_report.py`, is the harder test).

**Realtime quality, measured 2026-08-15** on 33 clips of the same corpus recorded by a
person (laptop mic, quiet room), one live `gpt-realtime` session per clip, run twice: once
at the session configuration this app ships (bare `server_vad`, i.e. OpenAI's defaults),
and once with two server-VAD knobs changed via `.env`
(`REALTIME_VAD_SILENCE_MS=900`, `REALTIME_VAD_INTERRUPT_RESPONSE=false`; see
`app/config.py`). Reproduce with `cd frontend && npm run capture:realtime-quality` then
`cd backend && uv run python -m tests.fixtures.run_realtime_quality_report`
(`backend/tests/fixtures/realtime_quality/SCRIPT.md` covers recording the corpus). Full
per-item verdicts for both runs in `backend/tests/fixtures/realtime_quality_report.{defaults,tuned}.json`
(git-ignored, personal audio-derived).

**Why 58% at defaults and not ~100%: turn-taking, not translation.** When `gpt-realtime`
translated a complete utterance, it translated it well; the default-run failures are
almost all the model answering the wrong *unit* of speech, and the captures show the
mechanism directly:

- **Mid-sentence pauses become turn boundaries.** The session uses `server_vad` at its
  defaults (`app/api/realtime.py`), where ~500ms of silence ends the turn. A natural
  breath at a comma ("Perdón por llegar tarde, [breath] había mucho tráfico") splits one
  sentence into two turns; the caption side channel shows exactly these splits.
- **Continued speech cancels the in-flight reply.** Server VAD's default
  `interrupt_response` treats the speaker resuming as barge-in and cancels the
  translation already being spoken. The captures contain the truncated stubs of those
  cancelled replies ("Y para cuando en", "Claro, estar…"), and the final reply covers only
  the last clause: `long-en-02`'s five-clause story came back as "Lo cual fue un poco
  decepcionante, pero igual la pasamos bien"; `conv-delayed-order-t4` as "But it will
  arrive tomorrow."
- The effect scales with utterance length: 72% acceptable on short single-clause items,
  40% on long and multi-turn ones. Two items also broke the "no preface" instruction
  ("Sure, here's the translation: …"), and one is a genuine mistranslation
  (`turn left` → `gira a la derecha`).

**The tuned run confirms the diagnosis.** Raising the silence window to 900ms and turning
barge-in off, nothing else changed, took the same 33 clips from 19/33 to **31/33**: every
short item passed, and long/multi-turn went from 6/15 to 13/15. `long-en-02`'s five-clause
story came back complete ("Así que condujimos todo el camino hasta la costa y el clima al
principio estuvo genial, pero luego empezó a llover justo cuando llegamos…"), the truncated
reply stubs vanished from the captures, and the caption side channel's WER fell from 23%
to 2.6% (the "hallucinated" tokens were an artifact of transcribing the split-off
fragments, not of the recordings). Per-turn latency did not get worse: median 286ms /
p90 514ms tuned vs 319ms / 576ms at defaults, since the longer silence window only delays
the *turn end*, and the proxy measures from there. The two remaining failures are genuine
mistranslations, and one of them is consistent across both runs: "turn left" → "gira a la
derecha" both times, and "Disculpa" → "Sure" once; worth knowing that the model can be
confidently wrong on a directional word.

This is the concrete, measured version of §6's structural argument: `gpt-realtime` is a
conversational model steered into interpreting by a prompt, and its VAD/barge-in defaults
are tuned for a chat partner who stops talking, not for a speaker mid-thought. The two
knobs are cheap and recover most of the gap, but they are still a *workaround inside a
turn-based design* rather than a fix: `interrupt_response=false` means a speaker who
genuinely wants to cut the interpreter off can't, and 900ms of silence is a real added
delay before every reply that the latency proxy above deliberately doesn't count. The
app ships at defaults, with the knobs one `.env` line away, so the headline number
reflects the brief's "required" model as OpenAI ships it and the tuned number shows what
a deployment would actually do. Cascade does not have this failure class at all: its
segmentation is explicit, inspectable, and tunable (§4), and a paused sentence is still
one translation unit.

Judging note: each Realtime capture is judged against the *reference text* (what was
actually said), not against `gpt-4o-transcribe`'s caption of it, because the caption is a
side channel the model does not translate from. The caption's WER is reported alongside
as an informational signal only.

## 3. Cost

Real, computed cost per minute of conversation, current pricing checked 2026-08-12,
citing the exact model each provider file uses.

| Provider / model (as used here) | Rate | Source |
|---|---|---|
| `gpt-realtime` audio in / out | $32 / $64 per 1M tok (600/1,200 tok/min) | [model card](https://developers.openai.com/api/docs/models/gpt-realtime), [costs guide](https://developers.openai.com/api/docs/guides/realtime-costs) |
| `gpt-4o-transcribe` (Realtime captions) | $0.006/min | [pricing](https://developers.openai.com/api/docs/pricing) |
| `gpt-4o-mini` (translation + segmenter + judge) | $0.15 / $0.60 per 1M tok | same |
| Deepgram `nova-3`, `language=multi` | $0.0058/min | [Deepgram](https://deepgram.com/pricing) |
| ElevenLabs `eleven_flash_v2_5` | $0.05/1,000 chars | [ElevenLabs](https://elevenlabs.io/pricing/api) |
| `gpt-realtime-translate` (§6) | $0.034/min flat | [model card](https://developers.openai.com/api/docs/models/gpt-realtime-translate) |

**Cascade, 1 min ≈ $0.054** (~150 words, ~12 segments): Deepgram $0.0058 + translation
~$0.00025 + segmentation-checker ~$0.00011 + TTS (~950 target-language chars) $0.0475.

**Realtime (as built), 1 min ≈ $0.064-$0.096**: continuous input audio $0.0192 (600
tok, billed even through silence) + output audio $0.038-$0.070 depending on speaking-time
ratio (30-55s/min) + captions side-channel $0.006.

**Result**: Realtime costs roughly **1.2x-1.8x more per minute** than Cascade, driven by
audio-token pricing and paying for continuous capture even during silence. §6 shows how
`gpt-realtime-translate` changes this.

## 4. Controllability

Concrete asymmetries, not a theoretical list:

- **Diarization + per-speaker voice, Cascade only.** `diarize=true` plus a consistent
  `speaker → voice_id` map (Ticket 4) gives two alternating speakers distinct TTS voices;
  `gpt-realtime` has no speaker concept at all.
- **Latency visibility, full 5-stage breakdown vs. one number** (§1): a structural
  consequence of which mode keeps the backend on the audio path, not a UI choice.
- **Segmentation strategy tunable, Cascade only.** `segmentationMode` (`hybrid` vs.
  `llm_priority`, Ticket 5) trades cut-latency for cut-correctness per deployment.
  Realtime's turn-taking is entirely internal to `gpt-realtime`'s own VAD.
- **Resilience, explicit and inspectable vs. implicit.** Ticket 7's bounded retries,
  circuit breaker, and reconnect/resume machinery are all testable in isolation
  (`test_resilience.py`). Realtime's resilience is WebRTC's own jitter buffer and ICE
  reconnection: real, but opaque to this codebase.
- **Provider swap points exist only in Cascade.** `providers/base.py`'s `Protocol`s make
  swapping STT/TTS/translation a one-class change across three real implementations.
  `gpt-realtime` *is* the pipeline, so there's nothing to swap underneath it.
- **Quality assessability is asymmetric too** (§2): the corpus runner targets Cascade
  directly; Realtime needs a manual session capture.

Cascade trades more moving parts for more levers to pull, inspect, and test. Realtime
trades those levers for architectural simplicity and, per §1, generally lower latency
risk. This is the brief's own framing made concrete rather than asserted.

## 5. Scenario-based recommendation

**Cascade is the better fit for Boostlingo's actual core product; Realtime for narrower,
lower-stakes slices of it.** A 12-18 month platform bet has to answer for cost per minute,
latency floor, vendor lock-in, and differentiated quality on uncommon language pairs; all
four are Cascade's structural strengths. A B2B product that needs to swap an underperforming
vendor, prove per-stage SLA compliance, or avoid single-sourcing its entire voice pipeline
on one OpenAI model should build on Cascade despite the five-moving-parts overhead: that
overhead is exactly what buys the control the business needs.

Realtime earns its place in narrower scenarios: a low-stakes, high-volume consumer feature
where raw perceived snappiness matters more than per-vendor tuning; rapid prototyping of a
new language pair before investing in Cascade-side provider selection; or a
manually-selectable fallback when a Cascade vendor is degraded (not automatic: Ticket 7
deliberately didn't build that, but the mode toggle already supports a manual switch). It
is not the right foundation for the differentiated, vendor-flexible platform the business
context describes, and per §3 it isn't even the cheaper option. §2's measurements sharpen
this in both directions: at defaults, `gpt-realtime` loses whole clauses whenever a
speaker pauses mid-sentence (58% acceptable on real speech), a failure class Cascade's
explicit segmentation simply doesn't have; and two VAD knobs recover most of it (94%),
which is exactly the kind of lever a team would need to know about, tune, and be able to
measure. That the lever exists is a point for Realtime's viability; that it had to be
found by building a corpus harness because the failure is invisible from the model's side
is a point for Cascade's inspectability.

## 6. `gpt-realtime` vs. `gpt-realtime-translate`

This build uses `gpt-realtime` because the brief calls it **"required,"** deliberately
different wording than cascade providers' "candidate's choice." 
[Ticket 03](.scratch/ai-interpreter-workbench/issues/03-realtime-transport-architecture.md)
treated that as intentional, not worth risking an evaluated take-home over.

**As a production decision, `gpt-realtime-translate` would likely be the better choice**,
per [research](.scratch/ai-interpreter-workbench/research/realtime-api-integration.md):

- **Turn-free by design.** `gpt-realtime` is steered into interpreter behavior purely via
  a system prompt (`app/api/realtime.py`) and inherits its turn-based conversational
  design. OpenAI's own cookbook for this pattern notes the speaker must pause for the
  model to respond. `gpt-realtime-translate` streams continuously with no committed-turn
  wait, structurally closer to real interpretation.
- **Structured language targeting.** `gpt-realtime` has no language-pair session field;
  it's prompt text. `gpt-realtime-translate` sets `audio.output.language` directly.
- **Native dual transcript streams.** This build bolts a separate `gpt-4o-transcribe`
  side channel onto `gpt-realtime` for captions; `gpt-realtime-translate` exposes
  `session.input_transcript.delta`/`output_transcript.delta` natively, one mechanism.
- **It's cheaper.** $0.034/min flat vs. this build's $0.064-$0.096/min. The
  architecturally better fit isn't a premium option; it's roughly half to a third cheaper.

The real cost of switching: one session per target language (a 2-way UX needs two
concurrent sessions), a smaller 16K context window, and a September 2024 knowledge cutoff.
For a product whose whole job is translate-only interpretation, none of that outweighs the
three advantages above.

## 7. Tuning-config comparisons

§2's quality numbers are one configuration each. This section is the same measurements
taken per `TuningConfig`, joined to that config's fingerprint, across the noise conditions
of `backend/tests/fixtures/noisy/`. A fingerprint (`cfg:` + 8 hex digits of the canonical
config's sha256) is the join key between a row here and the exact knob settings that
produced it.

### What each fingerprint is

<!-- One line per fingerprint measured below: the knobs that differ from the server
     defaults, not the whole document. Get the config back with the panel's Import
     button, or read the `configs[].file` entry in tuning_sweep.json. -->

- `cfg:39ace417` — server defaults (`nova-3`, `endpointingMs 500`, `utteranceEndMs 3000`,
  `diarize`, hybrid segmentation, every denoise stage off, transcript check off).
- `cfg:9d963847` — defaults but `cascade.deepgram.endpointingMs: 800`.
- `cfg:dc4da27f` — defaults but `cascade.transcriptCheck.mode: "correct"`.
- `cfg:b3bb3fbe` — defaults but `cascade.denoise.noisereduce: {enabled: true,
  propDecrease: 1.0, stationary: false}`.
- `cfg:4762791b` / `cfg:724ea8f0` — the Realtime smoke pair below: client-side RNNoise on,
  and the `.env` Realtime defaults with it off.

Cascade fingerprints depend on this machine's `.env` (the two ElevenLabs voice ids are
hashed in), so re-deriving them elsewhere gives different hex for the same knobs. Derive
your own from `GET /api/tuning/capabilities` before comparing.

### Results

| fingerprint | mode | condition | SNR | WER | corrected WER | judge acceptance | added latency | provider latency |
|---|---|---|---|---|---|---|---|---|
| `cfg:39ace417` | cascade | clean | -- | 1.6% (n=8) | -- | -- | 0.0 ms | 855 ms |
| `cfg:39ace417` | cascade | babble | 10 dB | 3.6% (n=8) | -- | -- | 0.0 ms | 1170 ms |
| `cfg:39ace417` | cascade | street | 10 dB | 1.6% (n=8) | -- | -- | 0.0 ms | 1075 ms |
| `cfg:9d963847` | cascade | clean | -- | 1.6% (n=8) | -- | -- | 0.0 ms | 1295 ms |
| `cfg:9d963847` | cascade | babble | 10 dB | 3.6% (n=8) | -- | -- | 0.0 ms | 1637 ms |
| `cfg:9d963847` | cascade | street | 10 dB | 1.6% (n=8) | -- | -- | 0.0 ms | 1557 ms |
| `cfg:dc4da27f` | cascade | clean | -- | 1.6% (n=8) | 1.6% (n=8) | -- | 0.0 ms | 832 ms |
| `cfg:dc4da27f` | cascade | babble | 10 dB | 3.6% (n=8) | 3.6% (n=8) | -- | 0.0 ms | 1178 ms |
| `cfg:dc4da27f` | cascade | street | 10 dB | 1.6% (n=8) | 1.6% (n=8) | -- | 0.0 ms | 1058 ms |
| `cfg:b3bb3fbe` | cascade | clean | -- | 14.1% (n=8) | -- | -- | 3256.2 ms | 1065 ms |
| `cfg:b3bb3fbe` | cascade | babble | 10 dB | 3.6% (n=8) | -- | -- | 2742.7 ms | 1679 ms |
| `cfg:b3bb3fbe` | cascade | street | 10 dB | 1.6% (n=8) | -- | -- | 2653.7 ms | 1509 ms |

Realtime smoke (**n=2, not a WER measurement** — two clips, one config each, from ticket
13's live A/B): RNNoise on (`cfg:4762791b`) end-to-end 421 ms / 249 ms and an exact
transcript on the clean clip; RNNoise off (`cfg:724ea8f0`) 487 ms / 171 ms. Two clips
cannot separate a denoiser from run-to-run variance; this is evidence the client DSP path
runs end to end, not evidence that it helps.

What was measured: **Deepgram endpointing** (`cfg:9d963847` costs ~440 ms of provider
latency for no WER change — the endpointing wait is inside `provider latency` by design),
**transcript check in `correct` mode** (`cfg:dc4da27f`, whose corrected-WER column is
filled and identical to raw: the checker rewrote nothing it had reason to), and
**server-side `noisereduce`** (`cfg:b3bb3fbe`). Its clean-condition 14.1% is one bad row,
not a trend: seven of the eight clean clips scored 0.0–12.5%, and `short-en-01` scored
100% with 0 ms provider latency — the non-stationary spectral gate emitted NaN
(`RuntimeWarning: invalid value encountered in divide`, then in the int16 cast in
`denoise.py`) and Deepgram returned no final result. The ~2.6 s `added latency` is a
whole-clip figure from a harness that denoises faster than real time; the 8.1 s on that
first row is library warm-up. `noisereduce` is a benchmark stage, and this is what
benchmarking it looks like.

What was **not** measured, and why: the client-side stages — microphone constraints, the
RMS gate, RNNoise — are applied in the browser, and this sweep replays WAV files
server-side, so no configuration of them can move a Cascade row. They have no WER rows at
all, and the "identical by construction" result ticket 13 saw for a gate config is a
property of the harness, not a finding about the gate. Measuring them properly needs the
browser in the loop (the Playwright capture harness), which yields judge acceptance and
end-to-end latency rather than WER. **DeepFilterNet was not run**: the `denoise` extra
(torch + deepfilternet, a ~200 MB CPU wheel) is deliberately not synced into `.venv`, and
it was smoke-tested in an isolated venv instead. **Judge acceptance is Realtime-only** and is blank on
every Cascade row: the Cascade sweep scores WER and latency and deliberately does not run
the LLM judge (that would mean a second key and a second cost per row for a number §2
already reports per configuration). **Corrected WER** is blank on rows whose config left
`transcriptCheck.mode` at `off`; a blank there means "not measured", never "no
improvement". **The noisy rows are report-only**: `test_quality_wer.py`'s
`WER_THRESHOLD = 0.20` remains a clean-corpus assertion and no noisy result gates CI.
`added latency` is the time the tuning's own denoise stages cost; `provider latency` is
what the provider then took, measured from the end of the clip's audio to the final
result (so it moves with `endpointingMs`, not with the denoise chain). Reported
separately on purpose — added together they would hide which of the two a config paid.

One more honest caveat on the corpus: at 10 dB SNR the defaults already score 1.6–3.6%,
so there is very little room for a denoiser to show a win. A config comparison that
matters would need the 5 dB conditions and more items than the eight these runs used.

### Reproduce

The four Cascade configs above are the server defaults plus one edit each. Dump the
defaults (they carry *your* `.env`'s voice ids, so do not copy the fingerprints), then
edit a copy per row:

```bash
cd backend
uv run python -c "import json;from fastapi.testclient import TestClient;from app.main \
import app;print(json.dumps(TestClient(app).get('/api/tuning/capabilities').json()['defaults'],indent=2))" \
  > /tmp/configs/defaults.json
# endpointing-800.json : cascade.deepgram.endpointingMs = 800, utteranceEndMs = 3000
# transcript-correct.json: cascade.transcriptCheck.mode = "correct"
# noisereduce.json      : cascade.denoise.noisereduce = {enabled:true, propDecrease:1.0, stationary:false}
```

```bash
# Cascade half (WER, added latency, provider latency) -- needs DEEPGRAM_API_KEY
# (and OPENAI_API_KEY for the transcript-check config). 72 rows, ~9 min.
cd backend
uv run python -m tests.fixtures.make_noisy_corpus
uv run python -m tests.fixtures.run_tuning_sweep \
  --config /tmp/configs/defaults.json \
  --config /tmp/configs/endpointing-800.json \
  --config /tmp/configs/transcript-correct.json \
  --limit 72 --conditions clean,babble,street --snr 10 --yes \
  --out tests/fixtures/tuning_sweep.json

# noisereduce needs the bench extra, which is never synced into .venv. 24 rows, ~4 min;
# it resumes into the same file, so the fourth config appends to the three above.
uv run --with noisereduce --with numpy python -m tests.fixtures.run_tuning_sweep \
  --config /tmp/configs/noisereduce.json \
  --limit 24 --conditions clean,babble,street --snr 10 --yes \
  --out tests/fixtures/tuning_sweep.json

# re-print all four configs' rows without re-measuring anything
uv run python -m tests.fixtures.run_tuning_sweep \
  --config /tmp/configs/defaults.json \
  --config /tmp/configs/endpointing-800.json \
  --config /tmp/configs/transcript-correct.json \
  --config /tmp/configs/noisereduce.json \
  --only short-en-01,short-en-02,short-en-03,short-en-04 \
  --only short-en-05,short-en-06,short-en-07,short-en-08 \
  --conditions clean,babble,street --snr 10 --yes --out tests/fixtures/tuning_sweep.json
# prints the rows above; full results in tests/fixtures/tuning_sweep.json (git-ignored)

# Realtime half (judge acceptance) -- needs a recorded corpus + OPENAI_API_KEY
cd frontend && npm run capture:realtime-quality -- --tuning /tmp/configs/a.json
cd backend && uv run python -m tests.fixtures.run_realtime_quality_report
```

`--limit` counts *rows*, not items: the runner plans item-outer/config-inner, so 72 rows
across three configs is the first 24 corpus variants (8 source items × clean/babble/
street) measured against all three.

A caution on the Realtime half, learned the hard way: the report back-fills a capture's
missing per-item `fingerprint` from the envelope's. A `captures.json` that was *resumed*
into by a run with a different config therefore reports every older, untagged item under
the newest fingerprint, and the per-fingerprint rows it prints are an average across
configs. Capture each config into its own `--out` file rather than resuming, and check
`captures[].fingerprint` before pasting anything it prints.

The sweep replays audio in real time, so a full corpus against two configs is hours: it
refuses more than 200 rows without `--yes`, prints an estimated wall-clock, and resumes
from `--out` on a re-run. `--limit`, `--only`, `--conditions` and `--snr` narrow it. Every
run reports a `clean` baseline row per item regardless of `--conditions`, because a noisy
WER means nothing without one.
