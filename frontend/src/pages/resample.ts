/**
 * The 48 kHz -> 16 kHz decimator (ticket 13): PURE, and the unit-tested source
 * of truth for the formula that `public/cascade-pcm-processor.js` runs.
 *
 * That file lives in AudioWorkletGlobalScope, a separate JS realm loaded via
 * `audioContext.audioWorklet.addModule()`, so it cannot import this module — it
 * **hand-mirrors** everything below, exactly as it already hand-mirrors
 * `floatSampleToInt16` from `pcm.ts` and as `public/gate-processor.js`
 * hand-mirrors `rmsGate.ts`. `resample.test.ts` loads the real worklet file and
 * requires sample-for-sample agreement, so the mirror cannot drift silently.
 *
 * ## Why this exists at all
 *
 * RNNoise only runs at 48 kHz (the model is trained on 480-sample / 10 ms
 * frames at that rate, and `RnnoiseWorkletNode` says so in its own doc
 * comment), so with the stage on, Cascade's capture AudioContext switches from
 * 16 kHz to 48 kHz. The backend contract does not move with it: Deepgram is
 * opened at 16 kHz mono PCM16 and the frame size stays 480 samples / 960 bytes
 * / 30 ms. Something therefore has to come back down by 3:1 before the Int16
 * conversion, and this is it.
 *
 * ## The filter
 *
 * Dropping two samples in three without filtering first would fold everything
 * above 8 kHz back into the band we keep. So each output sample is a
 * **windowed-sinc FIR low-pass** over the last {@link DECIMATOR_TAP_COUNT}
 * input samples, taken every {@link DECIMATION_FACTOR}th sample:
 *
 *   h[k] = sinc(2 * fc * (k - (N-1)/2)) * hamming(k),  normalised to sum 1
 *   y[m] = sum(h[k] * x[3m - (N-1) + k])
 *
 * with `fc = 7000 / 48000` and `N = 8`, per the brief. Eight taps is a
 * deliberately cheap filter and its skirt is correspondingly gentle — measured
 * from these coefficients: -0.09 dB at 1 kHz, -3 dB at ~5.6 kHz, -4.6 dB at the
 * nominal 7 kHz corner, -6 dB at the 8 kHz output Nyquist, -14.8 dB at 12 kHz.
 * Content above 8 kHz is attenuated rather than removed, so some of it still
 * aliases. That is an accepted cost of the round trip, not an oversight: the
 * brief's own sharp-edges note calls the 16k -> 48k -> 16k trip a plausible WER
 * regression and points at the sweep's clean-baseline row as the guard.
 */

/** The only context rate this decimator is defined for. */
export const DECIMATION_SOURCE_RATE = 48000;
/** The rate the backend's frame contract is fixed at. */
export const DECIMATION_TARGET_RATE = 16000;
/** 48000 / 16000. Integer by construction, so no fractional resampling. */
export const DECIMATION_FACTOR = DECIMATION_SOURCE_RATE / DECIMATION_TARGET_RATE;
/** Per the brief. Short enough to be free, long enough to be worth running. */
export const DECIMATOR_TAP_COUNT = 8;
/** Nominal corner frequency of the anti-alias low-pass. */
export const DECIMATOR_CUTOFF_HZ = 7000;

/**
 * The FIR coefficients, computed rather than pasted so the worklet's copy is
 * the same eight lines of arithmetic instead of eight literals that could be
 * transcribed wrong. Float64 throughout, in this exact accumulation order, so
 * the two implementations agree to the last bit.
 */
export function decimatorTaps(): Float64Array {
  const taps = new Float64Array(DECIMATOR_TAP_COUNT);
  const center = (DECIMATOR_TAP_COUNT - 1) / 2;
  const fc = DECIMATOR_CUTOFF_HZ / DECIMATION_SOURCE_RATE;
  let sum = 0;
  for (let k = 0; k < DECIMATOR_TAP_COUNT; k += 1) {
    const x = k - center;
    // N is even, so `x` is never 0 and the removable singularity is never hit;
    // the branch is kept because a future odd tap count would hit it.
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (DECIMATOR_TAP_COUNT - 1));
    taps[k] = sinc * window;
    sum += taps[k];
  }
  // Unity DC gain: without this the filter would quietly change the level, and
  // every downstream dBFS reading (the RMS gate's threshold included) with it.
  for (let k = 0; k < DECIMATOR_TAP_COUNT; k += 1) taps[k] /= sum;
  return taps;
}

const TAPS = decimatorTaps();

/**
 * What has to survive between calls for a stream to decimate the same way it
 * would have in one piece: the filter's input history, and which of the three
 * input samples the next one is.
 *
 * `history[DECIMATOR_TAP_COUNT - 1]` is the newest sample. It starts zeroed, so
 * the first seven outputs ramp in from silence — 0.15 ms at 48 kHz, ahead of
 * the first word of a session.
 */
export interface DecimatorState {
  history: Float64Array;
  /** 0, 1 or 2: the position of the *next* input sample in its group of three. */
  phase: number;
}

export function createDecimatorState(): DecimatorState {
  return { history: new Float64Array(DECIMATOR_TAP_COUNT), phase: 0 };
}

/**
 * Filters and decimates one block, advancing `state` in place. Block sizes are
 * arbitrary and need not be multiples of three — a render quantum is 128
 * samples, which is not — so the phase is carried rather than reset, and
 * feeding a stream in any chunking produces exactly the samples one call over
 * the concatenation would have.
 */
export function decimate48kTo16k(input: Float32Array, state: DecimatorState): Float32Array {
  const { history } = state;
  const firstEmit = (DECIMATION_FACTOR - state.phase) % DECIMATION_FACTOR;
  const outputLength =
    input.length > firstEmit ? Math.ceil((input.length - firstEmit) / DECIMATION_FACTOR) : 0;
  const output = new Float32Array(outputLength);
  let written = 0;

  for (let i = 0; i < input.length; i += 1) {
    for (let k = 0; k < DECIMATOR_TAP_COUNT - 1; k += 1) history[k] = history[k + 1];
    history[DECIMATOR_TAP_COUNT - 1] = input[i];

    if (state.phase === 0) {
      let acc = 0;
      for (let k = 0; k < DECIMATOR_TAP_COUNT; k += 1) acc += TAPS[k] * history[k];
      output[written] = acc;
      written += 1;
    }
    state.phase = (state.phase + 1) % DECIMATION_FACTOR;
  }

  return output;
}

export interface Decimator {
  /** One block in at 48 kHz, its share of the 16 kHz stream out. */
  process(block: Float32Array): Float32Array;
}

/** A decimator that owns its own streaming state — the usual way to hold one. */
export function createDecimator(): Decimator {
  const state = createDecimatorState();
  return {
    process(block: Float32Array): Float32Array {
      return decimate48kTo16k(block, state);
    },
  };
}
