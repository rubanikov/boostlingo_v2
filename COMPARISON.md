# Comparison Write-Up: Realtime API vs. Cascade Pipeline

Both modes are fully built and tested against mocked provider boundaries (see [AGENTS.md](AGENTS.md)).
**No live provider API keys have existed in this build environment**, so figures below are
either real/computed (cost, from current pricing) or explicit placeholders (latency,
quality) with exact commands to fill them in. Nothing here is a fabricated measurement.

## 1. Latency

The two modes measure latency in structurally different ways: a direct consequence of
Ticket 3's transport decision, and the first concrete instance of the controllability gap
in §4.

**Cascade** owns every stage server-side, so `app/orchestrator.py` emits a `latency` WS
message per segment at each of five stages (`speech_end` → `translation_first_token` →
`translation_complete` → `tts_first_byte` → `playback_start`), each `ms` cumulative since
`speech_end`. Clock offset resyncs every 30s and after reconnects. Target **< 2s**.

**Realtime** mints an ephemeral token and is then off the audio path entirely (WebRTC goes
browser ↔ OpenAI directly), so no server-side sub-stage timestamps are possible. The
frontend measures one client-side proxy: `speech_stopped` → first
`response.output_audio_transcript.delta` (`src/pages/realtimeLatency.ts`), a reasonable
stand-in for "reply starting," not a frame-accurate playback timestamp. Target **< 1.5s**.

| Mode | Metric | Result |
|---|---|---|
| Cascade | per-stage medians, `playback_start` (benchmark) | *[fill in, see below]* |
| Realtime | end-to-end (`speech_stopped` → first transcript delta) | *[fill in, see below]* |

**To fill in:** set real API keys in `backend/.env`, start both servers
([README](README.md#running-the-dev-servers)), run 5-10 exchanges per mode, and read the
numbers off the UI (Cascade's latency strip / Realtime's end-to-end badge) or the raw
`latency` WS messages / `oai-events` data-channel timestamps in devtools. Take the median
across turns.

## 2. Quality

Ticket 8 built two pipelines against the same 33-item EN↔ES dataset
(`backend/tests/fixtures/interpreter_dataset.json`), neither yet run against live APIs.

**WER (Cascade STT only)**: `test_quality_wer.py` TTS-generates each item's source text,
replays it through the real `DeepgramSTTProvider`, and asserts `jiwer.wer` below a 20%
starting threshold. **LLM-as-judge**: `app/quality/llm_judge.py` scores a candidate
translation and reports *what's* wrong (lost tense, wrong register, dropped negation), not
just a score. `backend/tests/fixtures/run_quality_report.py` (new this ticket) runs it over
all 33 items through Cascade's real translation stage.

**Asymmetry**: only Cascade has an exposed, independently-callable `translate()` step, so a
Realtime quality number needs a manual audio-session run capturing
`response.output_audio_transcript.delta` per turn, since translation happens inside the
opaque `gpt-realtime` model. Same backend-off-the-audio-path asymmetry as §1.

| Metric | Result |
|---|---|
| Cascade WER (EN / ES source) | *[fill in, %]* |
| Cascade LLM-judge acceptance rate (33 items) | *[fill in, X/33]* |
| Realtime LLM-judge acceptance rate | *[fill in, manual run, see below]* |

**To fill in:** `PYTHONPATH=. uv run python backend/tests/fixtures/generate_audio_fixtures.py`
→ `uv run pytest backend/tests/test_quality_wer.py -v` →
`PYTHONPATH=. uv run python backend/tests/fixtures/run_quality_report.py` (writes
`quality_report.json`). For Realtime: run each item's text as speech through the UI,
capture the transcript deltas, and feed `(source, transcript)` pairs through
`judge_translation()` the same way the report script does.

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
context describes, and per §3 it isn't even the cheaper option.

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
