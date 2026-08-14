# Observability — Implementation Tickets

Status: **approved** via feature-factory ticket-slicer gate. Sliced from
[observability-technical-brief.md](../../briefs/observability-technical-brief.md)
(gate-7 substitutions locked). Wireframe:
[observability-wireframe.html](../../wireframes/observability-wireframe.html)
— nits in the brief override the HTML.

Five right-sized vertical tracer-bullet tickets. Too thin: 0. Too thick: 0.

## Waves

```
Wave 1 (start now):     [01] Empty .env no-op + optional Langfuse compose
                                  /          |          \
Wave 2 (parallel):   [02] Cascade traces  [03] Realtime ingest  [04] Operator login shell
                                                                  \
Wave 3:                                                    [05] Dashboard cards + waterfall
```

## Tickets

| # | Title | Depends on | Size | Status |
|---|-------|-----------|------|--------|
| [01](01-empty-env-noop-compose.md) | Empty `.env` is a no-op; optional Langfuse compose comes up | none | Right-sized | ready-for-agent |
| [02](02-cascade-session-trace.md) | A Cascade session shows up as one trace (fail-open) | 01 | Right-sized | ready-for-agent |
| [03](03-realtime-turn-ingest.md) | Realtime turns land in Langfuse without touching WebRTC | 01 | Right-sized | ready-for-agent |
| [04](04-operator-login-shell.md) | Operator can open `/observability`, log in, and log out | 01 | Right-sized | ready-for-agent |
| [05](05-operator-dashboard.md) | Operator dashboard: cards, cursor table, waterfall | 04 | Right-sized | ready-for-agent |

## Parallel frontier

**01 only.** After 01 lands, **02, 03, and 04** start together. **05** waits on 04.

## Reconcile notes (wave 2)

- `observability/spans.py`, `metrics.py`, `origins.py` — 02 and 03 may both touch these; names come from the brief.
- `observability/auth.py` — 03 owns telemetry-token helpers; 04 owns cookie helpers.
- 05 is not blocked by 02/03 (tests use a faked Langfuse). A live compose demo needs 01+02+03 for real rows.

## Story AC coverage

| AC | Ticket |
|---|---|
| 1 Cascade traces | 02 |
| 2 ProviderError spans | 02 |
| 3 Realtime telemetry token | 03 |
| 4 Turn ingest | 03 |
| 5 Bad token 401 (silent, WebRTC continues) | 03 |
| 6 Metrics 100% | 01 (provider/sampler) + 02 (Cascade instruments) + 03 (mint/turn) |
| 7 README alerts | 01 |
| 8 Empty `.env` no-op | 01 |
| 9 Dead collector fail-open | 02 |
| 10 Login + dashboard + waterfall | 04 (login/shell) + 05 (cards/table/detail e2e) |
| 11 Wrong login | 04 |
| 12 No cookie 401 | 04 |
| 13 Token unset 404 | 04 |
| 14 Langfuse down vs empty | 04 (503 unreachable) + 05 (200 empty ≠ 502/503) |
| 15 Logout + no secrets in bundle | 04 |
| 16 Mic unauthenticated | 02, 03, 04 (each must not gate mic) |
| 17 Latency strip unchanged | 02 (no WS change) + 04 (router) |
| 18 Optional compose | 01 |
| 19 Frontend router | 04 (+ 05 adds `/observability/traces/:id`) |
