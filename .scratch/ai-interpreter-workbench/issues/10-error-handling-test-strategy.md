Type: grilling
Status: claimed
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
