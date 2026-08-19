# Demo video

`ai-interpreter-workbench-demo.mp4` (1440×900, ~4:45) is a narrated walkthrough of
the workbench: both modes doing a real EN↔ES conversation, the latency
instrumentation, and the Tuning panel end to end (microphone constraints, the
denoise chain — RMS gate, RNNoise, OpenAI noise reduction, DeepFilterNet /
noisereduce — endpointing, segmentation, transcript check, models & voices,
presets, apply kinds, fingerprints, export). The narration track also ships as
soft subtitles.

Everything on screen is the real app running against real providers. Nothing is
mocked or staged:

- **Video** is Playwright's screencast of the app served by the Vite dev server,
  one browser launch per scene, driven by `record.mjs`.
- **Speech into the app** is Chromium's fake microphone playing recorded clips
  from `backend/tests/fixtures/realtime_quality/` (the same corpus the quality
  reports use), spliced with a quiet noise floor between turns.
- **Speech out of the app** — ElevenLabs TTS in Cascade, the remote WebRTC track
  in Realtime — is captured *in the page* by tapping Web Audio / `srcObject` into
  a `MediaRecorder` (see `TAP_INIT` in `record.mjs`), so what you hear is what the
  browser played.
- **Narration** is ElevenLabs (`eleven_multilingual_v2`), voice
  `ELEVENLABS_VOICE_ID_VIDEO` from `backend/.env`, one clip per line in
  `narration.mjs`.

## Regenerating it

```bash
# once
cd demo && npm install            # ffmpeg-static (or put ffmpeg on PATH / set FFMPEG=)
cd ../frontend && npx playwright install chromium

# both dev servers up with real keys in backend/.env (.\dev.ps1 from the repo root)

cd demo
node tts.mjs                      # -> out/narration/*.mp3 + index.json (skips lines already rendered)
node record.mjs                   # -> out/video/*.webm, out/audio/*.webm, out/timeline.json
node assemble.mjs                 # -> out/ai-interpreter-workbench-demo.mp4
```

`record.mjs --scene cascade,tuning` re-records only those scenes (each scene is
its own video file, so a bad take is cheap to redo); `--headed` shows the browser.
`BASE_URL` / `BACKEND_URL` override the dev-server addresses (defaults
`http://localhost:5173` and `http://localhost:8002`; the script probes the
backend's `/api/realtime/session` rather than `/health` because another server
on this machine answers `/health` on 8000).

`assemble.mjs` places each narration line at the moment its step began (from
`out/timeline.json`), mixes it over the tapped app audio with sidechain ducking,
and burns nothing in — subtitles are a `mov_text` track. `--app-gain`,
`--nar-gain`, `--duck` adjust the mix.

## Editing the script

`narration.mjs` is the single source of truth: scenes, the mic clips each scene
plays, and one entry per narrated line (or a silent `{ hold: seconds }` step that
leaves room to hear a turn and its translation). What the page *does* at each
line lives in `ACTIONS` in `record.mjs`, keyed by the same ids. Change a line's
text and `tts.mjs` re-renders just that line on the next run (`--force` re-renders
everything).

## Things worth knowing

- The scene lengths follow the narration: each step holds until its line has
  finished, so re-rendering a line changes the timing of everything after it in
  that scene — re-record the scene after changing its text.
- The Realtime scene's input caption sometimes ends with a short phantom
  utterance (a stray "Hallo!"-style token) after the second turn: gpt-4o-transcribe
  transcribing the near-silence after a reply. It is the model's real output,
  left in rather than edited around.
- `out/` is git-ignored: it holds ~60 MB of intermediates. Only this README, the
  scripts, and the finished MP4 are meant to be tracked.
