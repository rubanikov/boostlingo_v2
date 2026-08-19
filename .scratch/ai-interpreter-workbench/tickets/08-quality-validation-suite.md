Type: task
Status: blocked
Depends on: [01](01-realtime-mvp.md)-[07](07-error-handling-resilience.md) (exercises the fully built app)

# Ticket 8 — Quality validation suite: shared test dataset, WER regression, fake-mic E2E, translation-quality LLM-judge

Size check: right-sized (~2.5-3 hrs). This is a genuine vertical deliverable,
not a horizontal "write tests for other tickets" slice — component-level
tests (provider contracts, segmentation race, retry/circuit-breaker) were
deliberately embedded in Tickets 2, 5, and 7 respectively, where that logic
gets built. This ticket is scoped to *system-level* validation: it produces
an actual data artifact (WER%, LLM-judge quality report) that
[Ticket 9](09-comparison-writeup.md) directly consumes — independently
demoable as "run the suite, get a quality/regression report," tied to the
brief's own Key Impact Metric ("interpretation quality (subjective + WER)").

The multi-turn snippets specifically test Ticket 5's segmentation-boundary
logic and Ticket 4's diarization; the memory-leak sample depends on Ticket 7's
reconnection/hygiene work.

Real-audio supplementary fixtures are cut candidate #3 if time runs short —
see [index](00-index.md).

## What to build

**Backend**
- Assemble the shared test dataset (~15-20 varied everyday-conversation
  items — greetings, questions, requests, casual filler — plus 2-3 longer
  multi-clause sentences and 2-3 multi-turn conversation snippets,
  domain-agnostic).
- TTS-generate audio fixtures per item (EN, ES).
- WER computation via `jiwer` (edit-distance alignment) against known source
  text, asserted below a threshold.
- LLM-as-judge translation-quality scorer — prompts for *what's* wrong (lost
  tense, wrong register, dropped negation), not just a score.
- Process-memory sampling harness (`psutil`) around a scripted 5-minute run.

**Frontend / test-infra**
- Playwright E2E using Chrome's `--use-fake-device-for-media-stream
  --use-file-for-fake-audio-capture=<path>`, exercising the real
  capture→STT→(translation→TTS) path in both modes, asserting expected words
  appear within a time budget.
- Noise-rejection case: silence/background-noise fixture, asserting no
  spurious transcript (or that VAD/endpointing never triggers a send).
- Supplementary manual-tier: a handful of real (non-TTS) audio recordings
  across varied conditions (quiet, some noise, near/far mic) through the same
  harness, validating `autoGainControl`/`noiseSuppression`/`echoCancellation`
  actually do something.

## Acceptance criteria

- WER regression test passes below an asserted threshold for both EN and ES,
  and fails loudly on a regression.
- Playwright fake-mic E2E test passes for both modes, producing the expected
  transcript within budget, using the real capture→STT→translation→TTS path
  (not mocked).
- Noise-rejection fixture produces no spurious transcript.
- LLM-as-judge produces an actionable per-item report (not just a score) for
  the same corpus run through both modes.
- The exact same dataset runs through both Realtime and Cascade modes
  (apples-to-apples for Ticket 9).
- Process-memory sample shows no unbounded growth across a simulated 5-minute
  run (brief's stability benchmark: "without... memory leaks").

## API / contract notes

No new app-facing contract; consumes Ticket 2/3's WS protocol and Ticket 1's
session endpoint as a test client.
