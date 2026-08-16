Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 11 — Microphone constraint toggles, both modes

Type: task · Status: blocked · Tier: **3** · Depends on: 04, 06

Size check: **right-sized (~1.5 hrs).** At the low edge of the band but not merged: merging into 12
would make that ticket ~5.5 hrs (Too thick), and this is a genuinely separate user-visible behaviour
(`getUserMedia` constraints) with its own footnote and its own test.

## What to build

**Frontend scope**
- `TuningPanel.tsx`: the **Microphone** section — EC / NS / AGC toggles with the wire field name in
  muted mono on the right, and the inline footnote
  `Applied at getUserMedia time — takes effect on the next connect.` These knobs do **not** trigger a
  reconnect in either mode.
- `useCascadeSession.ts` and `useRealtimeSession.ts`: build the `getUserMedia` constraints from
  `tuning.client.microphone` instead of the current hardcoded `true`s.

**Backend scope**: None (browser constraints never reach the server; they are hashed into the
fingerprint so a run is still identifiable). **Harness scope**: None.

## Acceptance criteria

Story ACs: **3.1** (`getUserMedia` called with exactly those values in both modes).

Brief tests: **S21** (both hooks, via `installMockGetUserMedia`).

## Out of scope for this ticket

Any DSP graph work (12).
