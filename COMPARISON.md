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
| Realtime | same proxy, 33 real-voice turns (the §2 quality run, 2026-08-15) | median **319ms**, mean 382ms, p90 576ms, range 168-1500ms |

Both comfortably clear their targets (Cascade < 2s, Realtime < 1.5s) — Realtime especially
so, by roughly 4-5x, consistent with §4's controllability trade: fewer stages, less to
inspect, but a real latency-floor advantage. The 33-turn sample confirms the three-turn
number wasn't a lucky draw; its two 1500ms outliers are both turns where server VAD split
the utterance and cancelled a reply mid-stream (see §2), so the proxy measured from the
*last* speech-stop to a restarted response.

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
| Realtime LLM-judge acceptance rate (33 real-voice clips, run 2026-08-15) | **19/33 (58%)** |
| Realtime, short single-clause items only (n=18) | 13/18 (72%) |
| Realtime, long + multi-turn items (n=15) | 6/15 (40%) |

WER this low (clean, single-speaker, TTS-generated audio — no room noise or accent
variation) is expected per `test_quality_wer.py`'s own threshold reasoning, not a surprise;
it's real headroom under the 20% regression bar, not evidence the bar is too loose (a
noisier real-recording corpus, see `run_real_audio_report.py`, is the harder test).

**Realtime quality, measured 2026-08-15** on 33 clips of the same corpus recorded by a
person (laptop mic, quiet room), one live `gpt-realtime` session per clip. Reproduce with
`cd frontend && npm run capture:realtime-quality` then
`cd backend && uv run python -m tests.fixtures.run_realtime_quality_report`
(`backend/tests/fixtures/realtime_quality/SCRIPT.md` covers recording the corpus). Full
per-item verdicts in `backend/tests/fixtures/realtime_quality_report.json` (git-ignored,
personal audio-derived).

**Why 58% and not ~100%: turn-taking, not translation.** When `gpt-realtime` translated
a complete utterance, it translated it well; the failures are almost all the model
answering the wrong *unit* of speech, and the captures show the mechanism directly:

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

This is the concrete, measured version of §6's structural argument: `gpt-realtime` is a
conversational model steered into interpreting by a prompt, and its VAD/barge-in defaults
are tuned for a chat partner who stops talking, not for a speaker mid-thought. Two
session-level knobs (`turn_detection.silence_duration_ms` raised toward 800–1000ms, and
`interrupt_response: false`) are the obvious next experiment and would likely recover a
large share of the long/multi-turn failures; they are left as-shipped here so the number
above reflects the brief's "required" model at defaults, not a tuned variant. Cascade
does not have this failure class at all: its segmentation is explicit, inspectable, and
tunable (§4), and a paused sentence is still one translation unit.

Judging note: each Realtime capture is judged against the *reference text* (what was
actually said), not against `gpt-4o-transcribe`'s caption of it, because the caption is a
side channel the model does not translate from. The caption's WER (23% average, inflated
by hallucinated tokens on the clips' silent lead-in/tail, e.g. "sourire", "Ehhez") is
reported alongside as an informational signal only.

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
context describes, and per §3 it isn't even the cheaper option. §2's measured 58% vs 100%
sharpens this: on real speech, `gpt-realtime` at defaults loses whole clauses whenever a
speaker pauses mid-sentence, a failure class Cascade's explicit segmentation simply
doesn't have, and one that matters more, not less, in the interpreting scenarios where
people speak in long, hesitant sentences.

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
