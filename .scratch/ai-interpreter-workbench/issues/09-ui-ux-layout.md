Type: prototype
Status: open

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
