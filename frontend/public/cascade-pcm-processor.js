// AudioWorklet processor for Cascade mode mic capture.
//
// Loaded via `audioContext.audioWorklet.addModule('/cascade-pcm-processor.js')`
// from src/pages/useCascadeSession.ts. Runs in AudioWorkletGlobalScope, a
// separate JS realm, so it can't import the app's TS module graph — the
// Float32 -> Int16 conversion below intentionally mirrors
// `floatSampleToInt16` in src/pages/pcm.ts, which is the unit-tested source
// of truth for the formula. Keep the two in sync by hand if it ever changes.
//
// Buffers ~30ms of samples before posting an ArrayBuffer back to the main
// thread, since AudioWorklet's native 128-frame render quantum (~2.7ms at
// 48kHz) is too chatty to send as one WebSocket frame per callback. The
// capture AudioContext is created with `sampleRate: 16000` (see
// useCascadeSession.ts), so the samples arriving here are already 16kHz
// regardless of the microphone's native rate.
const CHUNK_MS = 30;

class CascadePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._samplesPerChunk = Math.max(1, Math.round((sampleRate * CHUNK_MS) / 1000));
    this._buffer = new Int16Array(this._samplesPerChunk);
    this._writeIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) {
      return true;
    }

    for (let i = 0; i < channel.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      this._buffer[this._writeIndex] = Math.round(clamped * 32767);
      this._writeIndex++;

      if (this._writeIndex === this._samplesPerChunk) {
        this.port.postMessage(this._buffer.buffer);
        this._buffer = new Int16Array(this._samplesPerChunk);
        this._writeIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('cascade-pcm-processor', CascadePcmProcessor);
