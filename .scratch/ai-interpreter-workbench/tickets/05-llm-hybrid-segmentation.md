Type: task
Status: blocked
Depends on: [02](02-cascade-mvp.md), [04](04-diarization.md)

# Ticket 5 — Cascade: LLM-hybrid segmentation upgrade

Size check: right-sized (~2-2.5 hrs). This is called out in the wayfinder as
"the single most complex custom logic in the system"
([ticket 10](../issues/10-error-handling-test-strategy.md)) — deliberately
kept as its own ticket with its own dedicated test.

**Includes its own test**: segmentation race logic test (fallback-on-timeout,
LLM-wins-when-first, correct carry-forward of text after a snapshot) — the
piece of custom logic the wayfinder flags as needing dedicated coverage, not
deferred elsewhere.

Cut candidate #1 (LLM-priority mode only, keep hybrid-race) if time runs
short — see [index](00-index.md).

## What to build

**Backend**
- Async LLM clause-check side-channel — as the partial transcript grows, a
  fast LLM call checks whether the text-so-far is a complete, translatable
  clause; if yes, cut and translate immediately, without waiting for silence.
- Debounced to one check in flight per speaker (needs Ticket 4's speaker
  tracking).
- Races independently against Deepgram's `speech_final`/`UtteranceEnd`
  (1000-5000ms gap, requires `interim_results=true`) — whichever fires first
  wins; capture never pauses for the LLM check.
- Configurable segmentation mode: **hybrid race** (default) vs.
  **LLM-priority** (LLM verdict preferred, `speech_final` ignored,
  `UtteranceEnd` stays as a hard fallback ceiling so a segment can never hang
  indefinitely).

**Frontend**
- Light — surface `segment_boundary`'s trigger reason (`llm` vs. Deepgram
  signal) for debugging; a dev-facing toggle/query-param for segmentation
  mode is sufficient (full settings UI not required — see index assumption
  #2).

## Acceptance criteria

- A long sentence containing a natural mid-thought pause (e.g., "thinking
  pause" while finding a word) is *not* cut prematurely —
  `endpointing=500ms`, not the original 300ms.
- A speaker producing a complete, grammatically finished clause gets it
  translated and spoken before they pause, when the LLM check wins the race.
- Worst case (LLM check slow/fails to fire), the segment still completes via
  Deepgram's `speech_final`/`UtteranceEnd` fallback — no segment ever hangs
  indefinitely, in either segmentation mode.
- Both segmentation modes (hybrid race, LLM-priority) are exercisable for the
  comparison write-up's empirical A/B testing.

## API / contract notes

- `segment_boundary` (server) carries the trigger mechanism: `llm` or a named
  Deepgram signal.
- `endpointing=500` (bumped from research's original 300).
