Type: grilling
Status: open
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
