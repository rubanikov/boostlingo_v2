/**
 * The RMS noise gate (ticket 12): PURE, and the unit-tested source of truth
 * for the formula that `public/gate-processor.js` runs.
 *
 * That file lives in AudioWorkletGlobalScope, a separate JS realm loaded via
 * `audioContext.audioWorklet.addModule()`, so it cannot import this module —
 * it **hand-mirrors** everything below, exactly as
 * `public/cascade-pcm-processor.js` hand-mirrors `floatSampleToInt16` from
 * `pcm.ts`. Keep the two in sync by hand if any of it changes; its header
 * comment names this file as the source.
 *
 * The gate is a per-render-quantum RMS detector driving a smoothed gain:
 *
 *   rms       = sqrt(mean(x[i]^2))              over the block (128 samples in
 *                                               the worklet's render quantum)
 *   dbfs      = 20 * log10(max(rms, 1e-10))     the floor keeps digital silence
 *                                               off -Infinity
 *   open      = dbfs >= thresholdDbfs
 *   floorGain = fullMute ? 0 : 10 ** (-attenuationDb / 20)
 *   open      -> ramp gain toward 1 over attackMs
 *   closed    -> once holdMs has elapsed below the threshold, ramp gain toward
 *                floorGain over releaseMs
 *
 * Both ramps are linear in gain across the full `floorGain -> 1` span, so a
 * complete open (or close) takes exactly `attackMs` (or `releaseMs`).
 */
import { clampGateParams, type ClientTuning } from './tuningConfig';

export type GateParams = ClientTuning['rmsGate'];

/**
 * Amplitude floor before the log, so a block of digital silence reads as
 * -200 dBFS rather than -Infinity. Nothing downstream has to special-case it.
 */
const RMS_FLOOR = 1e-10;

/**
 * The documented boundaries of `thresholdDbfs`, both of which are treated as
 * absolutes rather than as ordinary comparisons:
 *
 * - **-80 dBFS is always open.** Read literally it would not be: silence sits
 *   at the -200 dBFS floor, *below* -80, so the gate would close on exactly the
 *   signal the panel's leftmost position is meant to let through.
 * - **0 dBFS is always closed.** Read literally it would open only on a
 *   full-scale block, which no real mic input reaches.
 *
 * Neither divides by zero, produces a NaN, or crashes the worklet (brief E7).
 */
export const GATE_ALWAYS_OPEN_DBFS = -80;
export const GATE_ALWAYS_CLOSED_DBFS = 0;

/** RMS of one block, in dBFS. Exported for its own test and for parity checks. */
export function blockRmsDbfs(block: Float32Array): number {
  if (block.length === 0) return 20 * Math.log10(RMS_FLOOR);
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
  return 20 * Math.log10(Math.max(Math.sqrt(sum / block.length), RMS_FLOOR));
}

/**
 * The gain a fully closed gate settles on. `fullMute` overrides
 * `attenuationDb` entirely — it is the far end of the same control, not a
 * second one — and `attenuationDb = 0` gives a floor of 1, which makes the
 * whole gate a no-op (brief E8).
 */
export function gateFloorGain(params: GateParams): number {
  return params.fullMute ? 0 : 10 ** (-params.attenuationDb / 20);
}

export function isGateOpen(dbfs: number, thresholdDbfs: number): boolean {
  if (thresholdDbfs <= GATE_ALWAYS_OPEN_DBFS) return true;
  if (thresholdDbfs >= GATE_ALWAYS_CLOSED_DBFS) return false;
  return dbfs >= thresholdDbfs;
}

/**
 * Per-sample gain increment for a ramp covering the `floorGain -> 1` span in
 * `ms`. A zero (or unusable) duration returns 1, which is at least the whole
 * span and therefore an instant transition — that, rather than an `Infinity`
 * that would poison the first multiply, is how `attackMs: 0` is expressed.
 */
function rampStep(ms: number, sampleRate: number, floorGain: number): number {
  const samples = (ms / 1000) * sampleRate;
  if (!(samples > 0)) return 1;
  return (1 - floorGain) / samples;
}

export interface RmsGate {
  /**
   * Applies the gate to one block **in place** and returns it. `sampleRate` is
   * a parameter rather than construction state because the worklet reads its
   * own context's rate, which the main thread does not choose.
   */
  process(block: Float32Array, sampleRate: number): Float32Array;
  /** Live parameter update. Clamped, so the caller can pass anything. */
  setParams(params: GateParams): void;
}

/**
 * A stateful gate. The envelope (`gain`, and how much hold is left) survives
 * across blocks, which is the whole point — hold and release are measured in
 * milliseconds, and a 128-sample quantum is 8 ms at 16 kHz.
 *
 * It starts **open** (`gain = 1`, no hold armed): the alternative, starting
 * closed, would attenuate the first `attackMs` of the very first thing anyone
 * says. Silence at the head of a session closes it after `releaseMs`, which is
 * the same path every later silence takes.
 */
export function createGate(params: GateParams): RmsGate {
  let current = clampGateParams(params);
  let gain = 1;
  let holdRemainingSamples = 0;

  return {
    setParams(next: GateParams): void {
      current = clampGateParams(next);
    },

    process(block: Float32Array, sampleRate: number): Float32Array {
      if (!current.enabled || block.length === 0) return block;

      const floorGain = gateFloorGain(current);
      // The floor can move under a running envelope (someone dragged the
      // attenuation slider), so the gain is pulled back into the new span
      // before it is used rather than ramping down from an impossible value.
      if (gain > 1) gain = 1;
      if (gain < floorGain) gain = floorGain;

      const open = isGateOpen(blockRmsDbfs(block), current.thresholdDbfs);
      let holding = false;
      if (open) {
        // Re-armed on every open block, so hold measures time since the *last*
        // block above the threshold, not since the first.
        holdRemainingSamples = (current.holdMs / 1000) * sampleRate;
      } else {
        // Read before the decrement, so a hold of N samples covers N samples of
        // audio rather than N minus the last block.
        holding = holdRemainingSamples > 0;
        holdRemainingSamples = Math.max(0, holdRemainingSamples - block.length);
      }

      const target = open || holding ? 1 : floorGain;
      const attackStep = rampStep(current.attackMs, sampleRate, floorGain);
      const releaseStep = rampStep(current.releaseMs, sampleRate, floorGain);

      for (let i = 0; i < block.length; i += 1) {
        if (gain < target) gain = Math.min(target, gain + attackStep);
        else if (gain > target) gain = Math.max(target, gain - releaseStep);
        block[i] *= gain;
      }
      return block;
    },
  };
}
