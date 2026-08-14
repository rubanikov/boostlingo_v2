# 04 — Operator can open `/observability`, log in, and log out

**What to build:** Workbench and Observability are real routes under `AppShell` (`Workbench | Observability` tabs). `/observability` shows disabled (token unset), login, or a signed-in shell. Correct token sets an `obs_session` browser-session cookie; wrong token stays locked with no cookie; logout clears it. After login, the shell calls the owned summary/traces APIs and shows **Telemetry Backend Unreachable** when Langfuse keys are unset (503) — not a fake dashboard. Latency badges stay on the workbench only. Mic sessions still work with no cookie.

**Blocked by:** 01 — Empty `.env` is a no-op; optional Langfuse compose comes up

**Size:** Right-sized — one operator-visible gate (enable → login → logout / disabled / unreachable) with its JSON APIs. Cards, table, and waterfall wait for 05.

**Status:** ready-for-agent

**Backend scope:** `/config` `/login` `/logout` plus cookie-gated `/summary` and `/traces` that 503 without Langfuse keys (owned resources, not a proxy). Cookie HMAC as brief.

**Frontend scope:** Router, `AppShell`, `ObservabilityPage` (disabled / login / signed-in unreachable), `LoginCard`, `observabilityApi.ts`; extend `WorkbenchPage.test.tsx`.

## Acceptance criteria

- [ ] `react-router-dom` v7: `/` = workbench, `/observability` = this page. Keep it to `createBrowserRouter` + `RouterProvider`; no loaders, no data APIs, no code splitting in v1. Latency strip on `/` unchanged (AC17, AC19). **No latency badges on `/observability`.**
- [ ] `GET /api/observability/config` unauthenticated, always 200 `{enabled, authenticated}` (AC13: unset token → `enabled: false`). Never reveals the token or the Langfuse host.
- [ ] Login `204` + `Set-Cookie: obs_session` with HttpOnly, SameSite=Lax, Path=/, **no Max-Age/Expires**; `Secure` iff HTTPS. Cookie value is 64-char lowercase hex HMAC. Copy: “Signed in until you log out or close the browser.” (not 2 hours — the 2h TTL is the Realtime telemetry token, never shown here).
- [ ] Wrong token → `401 {"detail": "Invalid operator token."}`, **no Set-Cookie of any kind**, form stays, field cleared (AC11).
- [ ] Token unset → login and data routes `404 {"detail": "Observability is not enabled on this server."}` (AC13). Disabled UI: 🔒 “Observability Disabled”, `OBSERVABILITY_UI_TOKEN` explanation, no login form, no further fetches.
- [ ] Logout `204`, `Set-Cookie: obs_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`; next data call `401` (AC15). Idempotent without a cookie. Never 401 on logout.
- [ ] Cookie-gated `GET /summary` and `GET /traces` exist: no/tampered cookie → `401` (AC12); Langfuse keys unset or client not built yet → `503` with `{"detail": ...}`. SPA maps 401 → login card, 404 → disabled, 502/503 → unreachable + Retry (partial AC14).
- [ ] Fetches use `credentials: 'include'`. `observabilityApi.ts` is the only status→state mapper (`ok | unauthenticated | disabled | unavailable`).
- [ ] Mic `/ws/cascade` and `POST /api/realtime/session` work with no cookie (AC16). `npm run build` dist contains no `OBSERVABILITY_UI_TOKEN`, `LANGFUSE_SECRET_KEY`, or `sk-` (AC15).
- [ ] Loading state: DaisyUI `loading-spinner` + “Loading telemetry data…”. Any 401 from a later call drops back to `LoginCard`.

## Brief anchors

- Brief: `.scratch/briefs/observability-technical-brief.md` — Cookie table; error-status table; Frontend changes (routes, `ObservabilityPage` branches, `LoginCard`).
- Wireframe: `.scratch/wireframes/observability-wireframe.html` — states login / unset / down / expired. Nits override HTML: no latency badges on `/observability`; session copy is browser-session, not “2 hours”.
- Cookie: `hmac_sha256(key=OBSERVABILITY_UI_TOKEN, msg=b"observability-ui-session-v1").hexdigest()`, verified with `secrets.compare_digest`. Rotating or unsetting the token invalidates every outstanding cookie.
- Do **not** implement Langfuse Metrics/Observations mapping or `GET /traces/{id}` here. Stub `/summary` and `/traces` as cookie-gated routes that 503 without keys; 05 replaces the body with real mapping.
- Router in this ticket: `/` and `/observability` only. 05 adds `/observability/traces/:id`.
- Parallel with 03 on `observability/auth.py`: this ticket owns cookie mint/verify; 03 owns telemetry-token helpers.

## Locked substitutions (gate 7)

- Cookie: `obs_session`, browser-session, httpOnly, SameSite=Lax.
- Owned JSON APIs, not a catch-all proxy.
- `react-router-dom` for the SPA.
