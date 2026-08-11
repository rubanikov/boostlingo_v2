Type: grilling
Status: open

## Question

Decide the browser-side approach for low-latency microphone capture and streamed audio
playback:

- MediaRecorder vs AudioWorklet/Web Audio API for capture (chunk size/format tradeoffs
  for streaming to the backend).
- How to play back incrementally-arriving TTS audio chunks with minimal added buffering
  latency (Web Audio API scheduling vs MediaSource Extensions vs simple streamed
  `<audio>`).

Needs to work for both modes (Realtime and Cascade) to keep the UI mode-agnostic per the
code-quality bar. Note current browser support/gotchas (autoplay policies, mic permission
handling — the brief calls out mic-permission-denied as an error case to handle).

Also wire in the `getUserMedia` constraints (`autoGainControl`, `noiseSuppression`,
`echoCancellation`) and the level-meter/VAD-state UI decided in
[STT/audio quality assurance & mic calibration strategy](11-stt-quality-assurance-mic-calibration.md).
