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

**Depends on what's configured when you run it — same specs either way:**

- **Live backend/provider keys.** Both modes' "connected" outcome (and
  everything downstream of it — an actual transcript) only happens with a
  real backend + real API keys reachable. The specs assert on `['Connected',
  'Error']`, so they pass either way — they just don't *prove* much beyond
  "didn't hang or throw" without live keys.
- **The audio fixture.** `playwright.config.ts` uses
  `e2e/fixtures/real-speech.wav` automatically if that file exists (checked
  once, at config-load time), otherwise falls back to the synthesized
  placeholder tone — see "Using a real speech recording" below for how to
  add one. No test asserts *specific* transcript words against it (this
  suite has no way to know what a given recording says); "some non-empty
  live transcript text arrived" is what a fixture-agnostic test can
  honestly claim.
- **The noise-rejection claim ("silence never produces a spurious
  transcript") is fundamentally a backend/STT-provider (VAD/endpointing)
  behavior**, not client-side logic — the frontend has no VAD of its own; it
  only ever renders transcript segments a server message told it to render
  (see `useCascadeSession.ts`'s `handleServerMessage`). That test
  (`noise-rejection.spec.ts`'s second test) self-skips via `test.skip(...)`
  with a message explaining this whenever a live backend isn't reachable,
  rather than asserting something this environment can't actually prove.
- Each mode's "transcript reflects real speech" test only runs at all when
  `e2e/fixtures/real-speech.wav` exists (checked at collection time), and
  within that, skips at runtime unless the session actually reaches
  `'Connected'` — so it needs both a real fixture and a live backend to mean
  anything, same as the bullet above.

## Commands

```bash
# from frontend/
npx playwright install chromium   # one-time, fetches the browser binary
npm run test:e2e                  # runs the whole suite headless
npx playwright test --reporter=list         # same, more verbose output
npx playwright test --project=cascade-fake-mic   # one project only
npx playwright show-report        # open the last HTML report
```

`npm run test:e2e` (and the commands above) start both their own Vite dev
server *and* the FastAPI backend (`playwright.config.ts`'s `webServer` array,
`uv run uvicorn app.main:app` from `../backend`) — no need to start either
yourself first. Set real API keys in `backend/.env` before running for a live
result; see the root `README.md`.

### Using a real speech recording

**Easiest path**: open `../backend/tests/fixtures/real_audio/recorder.html`
directly in a browser, record a prompt, then click "Also set as E2E
real-speech.wav" (needs the File System Access API — Chrome/Edge — and repo
folder access granted in that page first). It writes an already-correct
`e2e/fixtures/real-speech.wav` directly, no `ffmpeg` step. Prefer the
`short-en-01` prompt ("Hi, how are you doing today?"): it's the sentence the
COMPARISON.md latency runs already use, and it's also part of the Realtime
quality corpus (see `../backend/tests/fixtures/realtime_quality/SCRIPT.md`),
so one recording serves all three.

Opening the file directly (`file://`) works in Chrome/Edge, but if prompts
won't select or Record does nothing, some browsers block microphone access on
`file://` pages entirely — the page itself will show a red error banner
explaining why. Fix: from the repo root, run
`npx --yes serve backend/tests/fixtures/real_audio` and open the
`http://localhost:...` URL it prints instead.

**Manual path**:

1. Record yourself (or someone else) speaking a short EN or ES sentence —
   varied conditions (quiet vs. background noise, laptop mic vs. headset) are
   more interesting than a clean studio take, since that's the whole point
   of testing with a real voice instead of more TTS.
2. Convert it to mono 16-bit PCM WAV at 16000Hz if it isn't already:

   ```bash
   ffmpeg -i your-recording.m4a -ar 16000 -ac 1 -sample_fmt s16 e2e/fixtures/real-speech.wav
   ```

   (Already have one from `backend/tests/fixtures/real_audio/` for the
   backend's own real-audio report? Same format — just copy it here.)
3. Run the suite again. `playwright.config.ts` picks up
   `e2e/fixtures/real-speech.wav` automatically (checked once at startup —
   restart `npm run test:e2e` if you add the file mid-session) and both
   fake-mic projects switch to it, no other change needed. Each mode's
   "transcript reflects real speech" test un-skips itself the moment the
   file is present.

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
These are explicitly not speech; `e2e/fixtures/real-speech.wav` (not
generated, not committed — a real recording) takes over for both fake-mic
projects automatically once it exists — see "Using a real speech recording"
above.

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
