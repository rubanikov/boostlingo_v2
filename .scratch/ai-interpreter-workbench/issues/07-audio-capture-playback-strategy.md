Type: grilling
Status: resolved

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

## Answer

Resolved via a live grilling session as a Lavish review artifact:
[.lavish/ticket-07-audio-capture-playback-strategy.html](../../../.lavish/ticket-07-audio-capture-playback-strategy.html).

**The core finding: this isn't one answer, it splits cleanly by mode.** Both modes share
one `getUserMedia()` call (with ticket 11's `autoGainControl`/`noiseSuppression`/
`echoCancellation` constraints) and one `AnalyserNode` off the same raw `MediaStream` for
the level-meter/VAD-state UI — genuinely shared, mode-agnostic code. What happens next
diverges:

- **Capture — Realtime mode: neither MediaRecorder nor AudioWorklet.** WebRTC (ticket 03)
  handles capture, encoding, and transport natively once `pc.addTrack(stream.getTracks()[0])`
  is called on the raw stream.
- **Capture — Cascade mode: AudioWorklet.** Deepgram wants raw PCM binary frames, no
  container (ticket 04). AudioWorklet reads raw samples on the audio thread; convert
  Float32 → Int16 (`clamp(round(float32 * 32767), -32768, 32767)` — plain scale-and-clamp,
  no dithering, since the destination is an ASR model where 16-bit quantization noise sits
  below the mic's own noise floor, not a human-listening mastering context), buffer to
  ~20-40ms per WebSocket frame (AudioWorklet's native 128-frame callback is too chatty to
  send per-callback). MediaRecorder was rejected — it hands back compressed webm/opus
  blobs at coarse timeslices, the wrong shape entirely.
- **Playback — Realtime mode: WebRTC native.** `pc.ontrack` assigns the incoming media
  track straight to an `<audio>` element's `srcObject` (the exact pattern in OpenAI's
  `openai-realtime-console`, ticket 02's research) — the browser's own jitter buffer and
  audio pipeline handle it.
- **Playback — Cascade mode: Web Audio API buffer scheduling**, not MediaSource
  Extensions. Request raw PCM from ElevenLabs (skips decoding); each chunk becomes an
  `AudioBuffer` scheduled via `AudioBufferSourceNode.start(nextTime)` for gapless,
  sample-accurate playback starting the instant the first chunk arrives. MSE's strengths
  (compressed-format support, browser-managed buffering) don't line up with what this app
  needs (raw PCM, per-`segmentId` UI sync for highlighting the currently-speaking
  segment, lowest possible startup latency) — it's built more for adaptive video
  streaming's latency budget than real-time voice.

**Perceived smoothness of the target-text stream** (ticket 05's token-by-token target
pane): within one segment it reads as smooth incremental typing, same as any LLM chat
UI — but only if the UI appends text rather than re-rendering the whole block per token
(a real implementation pitfall to avoid, not just a theoretical one). Between segments
there's a natural pause while the next chunk of speech is captured/transcribed/judged
complete — this mirrors the actual audio gap rather than being a flaw, keeping the text
and audio experiences in sync with each other.

**Gotchas pinned down**: autoplay policy — tie `AudioContext` creation/`resume()` to the
same user gesture that triggers the mic-permission prompt, don't create it lazily on
first audio arrival. Mic permission denied — `getUserMedia()` rejects with a specifically
named `NotAllowedError`, which the brief's mic-permission-denied error case (ticket 10)
should catch by name rather than a generic catch-all.
