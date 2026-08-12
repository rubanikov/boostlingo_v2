# E2E tests (Playwright, fake-mic)

Playwright end-to-end harness for the Workbench (Ticket 8, frontend/test-infra
half). Separate from `npm test` (Vitest unit/component tests, unaffected by
this) — see `package.json`'s `test:e2e` script and `playwright.config.ts`.

## What's real vs. placeholder right now

**Real, and genuinely exercised today:**

- Chrome launches with `--use-fake-device-for-media-stream` /
  `--use-file-for-fake-audio-capture=<fixture>.wav` — `getUserMedia()` is a
  real browser call returning a real (fake-backed) `MediaStreamTrack`, not
  mocked in JS.
- The real capture → session-negotiation path runs: mic access, then (mode
  depending) the ephemeral-token fetch + WebRTC offer/answer (Realtime) or
  the WebSocket `start_session` handshake (Cascade).
- The UI's graceful-failure behavior: an actionable error banner + "Try
  again" button, no unhandled exception, no indefinite "Connecting…" hang.
- The silence fixture (`fixtures/silence.wav`) flowing through that same
  real capture path without crashing anything.

**Not yet meaningful, and the specs say so explicitly:**

- **No live backend/provider keys exist in this environment.** Both modes'
  "connected" outcome (and everything downstream of it — an actual
  transcript, translation, TTS) is untested here; only the graceful
  *pre-connection* failure path is. The specs assert on `['Connected',
  'Error']` so they'd keep passing unmodified against a live backend, but
  today they only ever observe `'Error'`.
- **The audio fixtures are placeholders** (`fixtures/placeholder-tone.wav`,
  `fixtures/silence.wav`) — a synthesized tone and digital silence, not real
  or TTS-generated speech. No test asserts specific transcript *words*
  against them; that would be meaningless (and dishonest) against a tone.
- **The noise-rejection claim ("silence never produces a spurious
  transcript") is fundamentally a backend/STT-provider (VAD/endpointing)
  behavior**, not client-side logic — the frontend has no VAD of its own; it
  only ever renders transcript segments a server message told it to render
  (see `useCascadeSession.ts`'s `handleServerMessage`). That test
  (`noise-rejection.spec.ts`'s second test) self-skips via `test.skip(...)`
  with a message explaining this whenever a live backend isn't reachable,
  rather than asserting something this environment can't actually prove.
- Two tests (one per mode) that assert real transcript words appear within a
  time budget are written but `test.skip`'d outright — they need a real
  speech fixture with known text plus a live backend to mean anything. See
  the `TODO` comments in `realtime.spec.ts` / `cascade.spec.ts` for exactly
  what to change to enable them.

## Commands

```bash
# from frontend/
npx playwright install chromium   # one-time, fetches the browser binary
npm run test:e2e                  # runs the whole suite headless
npx playwright test --reporter=list         # same, more verbose output
npx playwright test --project=cascade-fake-mic   # one project only
npx playwright show-report        # open the last HTML report
```

`npm run test:e2e` (and the commands above) start their own Vite dev server
on a dedicated port (`playwright.config.ts`'s `webServer`) — no need to run
`npm run dev` yourself first.

### Once real speech fixtures exist (backend's TTS-generation script, run with
a live key)

1. Drop the generated `.wav` file(s) somewhere under `e2e/fixtures/` (or
   point at wherever the backend script writes them).
2. Update the `TONE_FIXTURE`/`SILENCE_FIXTURE` constants in
   `playwright.config.ts` (or add new ones) to point at the real files.
3. Un-skip the two `test.skip('transcript reflects real speech...', ...)`
   tests in `realtime.spec.ts` / `cascade.spec.ts` and fill in the expected
   words per their `TODO` comments.

### Once a live backend + real API keys exist

- No harness change needed — `expect(['Connected', 'Error']).toContain(...)`
  already accepts `'Connected'`.
- `noise-rejection.spec.ts`'s second test will stop self-skipping and
  actually assert "no spurious transcript" once `finalStatus === 'Connected'`
  is reachable.

## Fixtures

`fixtures/generate-fixtures.mjs` generates both placeholder `.wav` files
(dependency-free — plain `node:fs` + PCM math, no TTS or audio library
involved, since neither is available in this environment):

- `fixtures/placeholder-tone.wav` — 3s mono 440Hz sine tone. Fed to the
  `realtime-fake-mic` and `cascade-fake-mic` Playwright projects.
- `fixtures/silence.wav` — 3s of digital silence. Fed to the
  `noise-rejection-fake-mic` project.

Regenerate with `node e2e/fixtures/generate-fixtures.mjs` from `frontend/`.
These are explicitly not speech and are meant to be replaced by the
backend's TTS-generated fixtures (see
`.scratch/ai-interpreter-workbench/tickets/08-quality-validation-suite.md`)
once those exist — see "Once real speech fixtures exist" above.

## Environment quirk worth knowing

Chromium's headless mode needs **both** `--use-fake-device-for-media-stream`
**and** `--use-fake-ui-for-media-stream` for `getUserMedia()` to work at all
— confirmed by hand in this environment. With only the former (the flag most
docs mention on its own), every `getUserMedia()` call rejects with
`NotSupportedError` under `chromium.launch({ headless: true })`, even though
Playwright's `permissions: ['microphone']` context option grants the
permission via CDP. Both flags together work in headless and headed mode
alike. `playwright.config.ts`'s `fakeMicArgs()` sets both.

Also worth knowing: `role="status"`/`role="alert"` are ARIA "name from
author" roles, so an element with one of those roles and no explicit
`aria-label` has an **empty accessible name** even though it has visible
text — `getByRole('status', { name: 'Error' })` matches nothing against
WorkbenchPage's connection badge, for exactly this reason. `support/
workbench.ts`'s `connectionBadge()` uses `getByRole('status').filter({
hasText })` instead, which matches on rendered text rather than accessible
name.
