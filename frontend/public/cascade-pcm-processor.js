// AudioWorklet processor for Cascade mode mic capture.
//
// Loaded via `audioContext.audioWorklet.addModule('/cascade-pcm-processor.js')`
// from src/pages/useCascadeSession.ts. Runs in AudioWorkletGlobalScope, a
// separate JS realm, so it can't import the app's TS module graph — everything
// below intentionally mirrors two unit-tested sources of truth, and both of
// them have a parity test that loads *this* file and runs it:
//
//   - the Float32 -> Int16 conversion mirrors `floatSampleToInt16` in
//     src/pages/pcm.ts;
//   - the 48kHz -> 16kHz decimator mirrors `decimate48kTo16k` and
//     `decimatorTaps` in src/pages/resample.ts (ticket 13).
//
// Keep them in sync by hand if either formula ever changes.
//
// Buffers ~30ms of samples before posting an ArrayBuffer back to the main
// thread, since AudioWorklet's native 128-frame render quantum (~2.7ms at
// 48kHz) is too chatty to send as one WebSocket frame per callback.
//
// Two context rates are possible (see useCascadeSession.ts):
//   - 16000 Hz, the default: Web Audio has already resampled the mic for us and
//     the samples arriving here need nothing done to them.
//   - 48000 Hz, when RNNoise is enabled — that stage only runs at 48kHz. The
//     backend contract does not move with it (Deepgram is opened at 16kHz and
//     the frame is 480 samples / 960 bytes / 30ms), so the decimator below runs
//     first and the chunk size is computed at the *output* rate. It is gated on
//     `processorOptions.targetSampleRate` rather than assumed, so a context at
//     some third rate falls through to the pass-through path instead of being
//     silently decimated by 3.
const CHUNK_MS = 30;
const DECIMATION_SOURCE_RATE = 48000;
const DECIMATOR_TAP_COUNT = 8;
const DECIMATOR_CUTOFF_HZ = 7000;

// Mirrors `decimatorTaps()` in src/pages/resample.ts, arithmetic for
// arithmetic: windowed-sinc low-pass, Hamming window, normalised to unity DC
// gain. Float64 in this accumulation order, so both implementations agree to
// the last bit.
function decimatorTaps() {
  const taps = new Float64Array(DECIMATOR_TAP_COUNT);
  const center = (DECIMATOR_TAP_COUNT - 1) / 2;
  const fc = DECIMATOR_CUTOFF_HZ / DECIMATION_SOURCE_RATE;
  let sum = 0;
  for (let k = 0; k < DECIMATOR_TAP_COUNT; k++) {
    const x = k - center;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (DECIMATOR_TAP_COUNT - 1));
    taps[k] = sinc * window;
    sum += taps[k];
  }
  for (let k = 0; k < DECIMATOR_TAP_COUNT; k++) taps[k] /= sum;
  return taps;
}

const DECIMATOR_TAPS = decimatorTaps();

class CascadePcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = (options && options.processorOptions) || {};
    const targetSampleRate = processorOptions.targetSampleRate;
    this._decimationFactor =
      sampleRate === DECIMATION_SOURCE_RATE &&
      typeof targetSampleRate === 'number' &&
      targetSampleRate > 0 &&
      sampleRate % targetSampleRate === 0 &&
      sampleRate !== targetSampleRate
        ? sampleRate / targetSampleRate
        : 1;
    // Mirrors `DecimatorState` in resample.ts: the filter's input history plus
    // the position of the next input sample in its group, both carried across
    // render quanta (128 is not a multiple of 3, so the phase genuinely moves).
    this._history = new Float64Array(DECIMATOR_TAP_COUNT);
    this._phase = 0;

    const outputRate = sampleRate / this._decimationFactor;
    this._samplesPerChunk = Math.max(1, Math.round((outputRate * CHUNK_MS) / 1000));
    this._buffer = new Int16Array(this._samplesPerChunk);
    this._writeIndex = 0;
  }

  /** Mirrors `decimate48kTo16k` in src/pages/resample.ts. */
  _decimate(input) {
    const factor = this._decimationFactor;
    const history = this._history;
    const firstEmit = (factor - this._phase) % factor;
    const outputLength = input.length > firstEmit ? Math.ceil((input.length - firstEmit) / factor) : 0;
    const output = new Float32Array(outputLength);
    let written = 0;

    for (let i = 0; i < input.length; i++) {
      for (let k = 0; k < DECIMATOR_TAP_COUNT - 1; k++) history[k] = history[k + 1];
      history[DECIMATOR_TAP_COUNT - 1] = input[i];

      if (this._phase === 0) {
        let acc = 0;
        for (let k = 0; k < DECIMATOR_TAP_COUNT; k++) acc += DECIMATOR_TAPS[k] * history[k];
        output[written] = acc;
        written++;
      }
      this._phase = (this._phase + 1) % factor;
    }

    return output;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) {
      return true;
    }

    const samples = this._decimationFactor > 1 ? this._decimate(channel) : channel;

    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
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
