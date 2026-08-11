Type: grilling
Status: resolved
Blocked by: 06

## Question

Given the provider abstraction design
([Provider abstraction interface design](06-provider-abstraction-design.md)), decide:

- (a) Concrete error-handling behavior for each brief-mandated failure mode (provider
  rate limit, timeout, empty STT/translation result, mic permission denied) — retry with
  backoff? user-facing message? fallback provider? session termination?
- (b) What counts as "critical path" for the targeted tests the brief requires — which
  parts of the cascade pipeline and provider boundaries get tested, and with what
  strategy (mocked provider responses, contract tests against the abstraction
  interfaces, etc.).

Note: speech-quality tests (WER regression, Playwright fake-mic E2E, noise-rejection) are
already decided separately in
[STT/audio quality assurance & mic calibration strategy](11-stt-quality-assurance-mic-calibration.md)
— this ticket's test strategy is about pipeline/provider-boundary correctness, not
speech quality; the two should end up as one coherent test suite, not overlapping ones.

## Answer

Resolved via a live grilling session as a Lavish review artifact:
[.lavish/ticket-10-error-handling-test-strategy.html](../../../.lavish/ticket-10-error-handling-test-strategy.html).
The throughline for both decisions: every failure is scoped to **one segment**, never
the whole session, with a circuit breaker as the sole backstop.

**(a) Error-handling behavior, per failure mode:**

| Failure mode | Behavior | User sees |
|---|---|---|
| Rate limit | 2 retries, backoff 200ms → 400ms (bounded — real-time voice can't tolerate long waits). Exhausted → drop segment, session stays alive. | Brief non-blocking toast, only if noticeable. |
| Timeout | Per-stage timeout budget tied to ticket 08's latency targets — 1 retry on overrun, then drop the segment. | Segment silently skipped. |
| Empty STT result | Usually **not an error** — `TranscriptSegment.is_empty` (ticket 06) is the correct outcome for silence/noise. Only flagged if `SpeechStarted` fired but STT produced nothing — logged, dropped, no retry. | Nothing — silence should look like silence. |
| Empty translation result | A real anomaly (shouldn't legitimately be blank) — 1 retry, then logged and dropped rather than showing confusing untranslated source text. | Segment silently skipped (logged server-side). |
| Mic permission denied | Not a provider error — browser-level `NotAllowedError` (ticket 07), blocks session start. No auto-retry (needs the user to fix browser settings). | Blocking error banner (ticket 09) with a "try again" button re-attempting `getUserMedia()`, not a full reload. |

**Fallback provider — explicitly not automatic.** Ticket 06's swappable-provider design
is a build-time/config-time property, not a runtime automatic-failover feature — wiring
live automatic failover between concurrently-connected providers is meaningfully more
engineering than a 15-20hr build serves, for a benefit outside what the brief evaluates.

**Session termination — circuit breaker only.** 5 consecutive segment failures trips a
hard "interpretation unavailable" state (suggests something structurally broken, not a
transient blip); an actual dropped WebSocket connection is
[Stability: reconnection, drift, memory](13-stability-reconnection-drift-memory.md)'s
territory, not this ticket's.

**(b) Critical-path test strategy:**

In scope: **provider boundary contract tests** (each Protocol implementation from ticket
06, tested against a mocked SDK — normal streaming maps correctly to the typed events,
each failure mode above maps to the right `ProviderError` kind + `retryable` flag);
**segmentation logic tests** (the LLM-hybrid clause-check vs. Deepgram-fallback race,
ticket 05 — the single most complex custom logic in the system: fallback-on-timeout,
LLM-wins-when-first, correct carry-forward behavior); **retry/circuit-breaker logic
tests** (correct attempt count/backoff timing, circuit breaker trips at 5 consecutive
failures); **end-to-end pipeline** — already decided (ticket 11's Playwright fake-mic
E2E), this ticket's tests complement rather than duplicate it. Explicitly not in scope,
matching the brief's "full coverage not required": exhaustive per-provider parameter
testing, UI snapshot tests, load/stress testing, multi-provider combinatorial testing.

Tooling: pytest + pytest-asyncio, hand-mocked provider SDKs / fake WebSocket connection
objects rather than live network calls — fast, deterministic, no flakiness from real API
dependencies in the suite.

**Amendment triggered for tickets 11/14**: real audio recordings (not just TTS-generated)
added as supplementary WER/E2E test fixtures — TTS-generated audio can't surface real
background noise or volume/distance variance, and real recordings are the only way to
validate ticket 07's `autoGainControl`/`noiseSuppression`/`echoCancellation` constraints
are actually doing something. No new test infrastructure needed — Chrome's
`--use-file-for-fake-audio-capture` flag doesn't care whether the WAV is synthetic or
real, so these are just additional fixture files in the same harness. Treated as
supplementary/manual-tier, same spirit as ticket 11's device-coverage call — not
blocking automated CI on a recording being available. Full detail in ticket 11's
amendment.
