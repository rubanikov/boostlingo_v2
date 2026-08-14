# 03 — Realtime turns land in Langfuse without touching WebRTC

**What to build:** `POST /api/realtime/session` returns a 2h telemetry token + `trace_id` (nulls when OTel is off). Each completed Realtime turn is POSTed to ingest and becomes a `realtime.turn` under `realtime.session`. A bad/expired token is 401; the SPA drops the turn silently and WebRTC stays connected. No re-mint.

**Blocked by:** 01 — Empty `.env` is a no-op; optional Langfuse compose comes up

**Size:** Right-sized — mint + ingest + silent client reporter is one operator-visible path (Realtime in Langfuse) with its auth/limit failure paths.

**Status:** ready-for-agent

**Backend scope:** Extend `RealtimeSessionResponse`; `POST /api/telemetry/realtime/turn`; telemetry-token mint/verify + in-process rate buckets.

**Frontend scope:** `realtimeTelemetry.ts` wired into `useRealtimeSession.ts`; endpoint constants; Vitest that ingest 401 leaves the peer connection up.

## Acceptance criteria

- [ ] Session response gains `telemetry_token`, `telemetry_expires_at` (= now+7200), `trace_id`; existing `client_secret` / `expires_at` / `model` / `voice` unchanged (AC3). All three new fields `null` when OTLP is off.
- [ ] Token format as brief (`base64url(json) + "." + base64url(hmac_sha256)` over `{"sid", "tid", "exp"}`); TTL from `telemetry_token_ttl_seconds` (7200s); held in a `useRef`, never `localStorage`/`sessionStorage`. Opaque to the SPA — it forwards the token and never parses it.
- [ ] Valid turn POST → `202 {"accepted": true}` and one `realtime.turn` in the token’s trace (AC4). Observability off → still `202`, span dropped. SPA never behaves differently when observability is off.
- [ ] Auth order: Origin (reuse `origins.py`; present-and-not-allowlisted → 403; absent → allow) → 16 KiB `Content-Length` → 413 → 60/min per `sid` → 429 → bad/expired/tampered token → 401 `{"detail": "Invalid or expired telemetry token."}` (AC5).
- [ ] Unknown JSON fields → 422 (`extra="forbid"`). `turnIndex` / `latencyMs` / `startedAt` / `endedAt` required; everything else optional/nullable.
- [ ] Frontend: 401/413/429/network/off are all `void fetch(...).catch(() => {})`; **must not** call `setStatus`/`fail`; status stays `connected` (AC5). `console.debug` is the maximum reaction. Reuse `realtimeLatency.ts` timestamps; POST on `response.done` with any `response.usage`.
- [ ] Mint failure ends `realtime.session` ERROR and increments `interpreter.realtime.mint.failures`; successful turns record `interpreter.turn.duration` with `mode=realtime` (AC6, Realtime half). Session span is ended immediately; children arrive later linked by trace ID.
- [ ] `POST /api/realtime/session` still works with no `obs_session` cookie (AC16).
- [ ] No re-mint in v1. No retry queue. No user-visible ingest error.

## Brief anchors

- Brief: `.scratch/briefs/observability-technical-brief.md` — Realtime (thin, client-reported) flow; `POST /api/realtime/session` extension; `POST /api/telemetry/realtime/turn` contract.
- Trace shape: `realtime.session` (root, one per session mint, incl. mint failures) → `realtime.turn` (one per client-reported turn).
- Tests: extend `backend/tests/test_realtime.py`; new `backend/tests/test_telemetry_ingest.py`. Frontend: unit test that a 401 from turn-ingest leaves `useRealtimeSession` status `connected` and the peer connection open.
- May touch `observability/auth.py` in parallel with 04 — this ticket owns token helpers and the per-`sid` rate limiter; 04 owns cookie helpers.
- If 02 has not yet extracted `origins.py`, this ticket extracts it (same function as the orchestrator’s existing check) and calls it from ingest; if 02 already did, import it.
- Client-reported Realtime latency is not trustworthy telemetry — attribute as client-reported in README (already in 01) and later in the UI (05).

## Locked substitutions (gate 7)

- Telemetry token TTL 2h, no re-mint.
- Turn ingest: Origin + 16 KiB cap + 60/min rate limit.
- Owned ingest endpoint, not a catch-all proxy.
