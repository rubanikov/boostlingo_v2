Type: task
Status: blocked
Depends on: [06](06-latency-instrumentation.md), [08](08-quality-validation-suite.md) (practically, everything — it's the capstone)

# Ticket 9 — Comparison write-up (1-2 pages)

Size check: right-sized (~1.5-2 hrs).

## What to build

No new application code. Draws on:
- Ticket 6's real latency numbers (both modes, multiple runs).
- Ticket 8's WER/LLM-judge output.
- Hands-on experience from building/using both modes (controllability —
  e.g., Cascade's full per-stage visibility vs. Realtime's end-to-end-only
  per Ticket 6; diarization as Cascade-only per Ticket 4).
- A cost-per-minute estimate pulled from current OpenAI/Deepgram/ElevenLabs
  pricing at write-up time.
- Give `gpt-realtime-translate` real weight here specifically, per
  [wayfinder ticket 03](../issues/03-realtime-transport-architecture.md)'s
  explicit deferral — "if this were a production decision rather than a
  specified requirement, `gpt-realtime-translate` would likely be the better
  choice, because [turn-free design / structured language targeting / native
  dual transcripts]."

## Acceptance criteria

- 1-2 pages, covers all five brief-named dimensions: latency, quality, cost,
  controllability, and a scenario-based recommendation (brief FR8, literal).
- Latency figures cited are the actual measured numbers from Ticket 6, not
  estimates.
- Quality figures cite the actual WER% and LLM-judge findings from Ticket 8.
- Explicitly names the diarization asymmetry (Cascade-only) and the
  latency-visibility asymmetry (Cascade full breakdown vs. Realtime
  end-to-end) as concrete, demonstrated instances of "more control" vs.
  "less control."
- README (setup/run/architecture overview) and AGENTS.md/CLAUDE.md
  (agent-usage description) are finalized alongside this ticket, since the
  full architecture is only complete by this point.

## API / contract notes

None — this ticket produces documentation, not code.
