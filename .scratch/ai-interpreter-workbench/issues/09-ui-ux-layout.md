Type: prototype
Status: resolved

## Question

Produce a rough layout prototype for the SPA covering: mode toggle (Realtime/Cascade,
switchable pre-session and mid-session per the brief), language pair selector (minimum
English↔Spanish), dual live transcript panes (source + target text as they're produced),
a latency display area, and mic/connection controls plus error states (rate limit,
timeout, empty result, mic permission denied).

This is a cheap concrete mockup to react to, not final styling.

**Carried forward from [Provider abstraction design](06-provider-abstraction-design.md)**:
diarization + per-segment language detection was added for Cascade mode (supports true
back-and-forth between two speakers/languages, not just a fixed one-way direction). This
layout needs to design for: per-speaker transcript display (distinguishing which of the
two diarized speakers said what) and reflecting that each speaker gets a consistent,
distinct TTS voice across the session.

## Answer

Resolved via the `/prototype` skill's UI branch (per the map's Notes routing prototype
tickets there) — 3 structurally different variants built as a single switchable Lavish
artifact, populated with realistic mock data (2 diarized speakers, EN↔ES, mid-exchange)
rather than an empty shell:
[.lavish/ticket-09-ui-ux-layout.html](../../../.lavish/ticket-09-ui-ux-layout.html).

- **A — Split dual-column**: source/target transcript panes side by side, latency as a
  slim horizontal strip at the top, mic control with level meter centered at the bottom.
- **B — Chat thread**: single scrolling column, interleaved message bubbles color-coded
  per speaker, latency tucked into expandable per-message detail, session/latency
  controls in a right sidebar.
- **C — Instrumentation dashboard**: compact transcript panes up top, the per-stage
  latency table treated as a first-class persistent panel rather than tucked away —
  reflecting how central the brief's instrumentation requirement actually is.

**Winner: Variant A (split dual-column).** Confirmed directly after review.

Per-speaker requirements (carried from ticket 06) satisfied across all three variants:
color-coded badges/borders distinguish Speaker A (blue) from Speaker B (orange)
consistently in both transcript panes, doubling as the visual cue for each speaker's
distinct TTS voice. Latency display in the winning variant (A) matches ticket 08's
asymmetric-by-mode design directly — the strip shown is Cascade's per-stage breakdown;
Realtime mode would collapse this to a single end-to-end badge. Error states (mic
permission denied, rate limit, timeout, empty result) prototyped as a shared reference
strip applying across all variants, matching ticket 10's forthcoming error taxonomy —
empty result explicitly shown as *not* a user-facing error state, per ticket 11's
noise-rejection design (silence/noise correctly producing nothing isn't a failure).
