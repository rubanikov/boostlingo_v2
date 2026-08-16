import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING_CONFIG } from './tuningConfig';
import { blockRmsDbfs, createGate, gateFloorGain, isGateOpen, type GateParams } from './rmsGate';

/** The worklet's render quantum, which is what the gate is written against. */
const QUANTUM = 128;
const SAMPLE_RATE = 16000;

function gateParams(overrides: Partial<GateParams> = {}): GateParams {
  return { ...DEFAULT_TUNING_CONFIG.client.rmsGate, enabled: true, ...overrides };
}

/**
 * A `Float32Array` stores what it is given at single precision, so `0.001`
 * comes back as `0.0010000000474974513`. Every "exactly this value" assertion
 * below is therefore written against `Math.fround` of the arithmetic rather
 * than against the decimal literal — the gate is exact, `Float32Array` is what
 * rounds.
 */
const f32 = Math.fround;

/** A constant-amplitude block: its RMS is the amplitude, so dBFS is exact. */
function constantBlock(amplitude: number, length = QUANTUM): Float32Array {
  return new Float32Array(length).fill(amplitude);
}

/** The sample a gate settled on `gain` produces from a constant `amplitude`. */
function gated(amplitude: number, gain: number): number {
  return f32(f32(amplitude) * gain);
}

/**
 * Runs `blocks` quanta of constant `amplitude` through the gate and hands back
 * the last one. Steady state, not the first block: hold and release are
 * measured in milliseconds and one quantum is 8 ms at 16 kHz.
 */
function steadyState(gate: ReturnType<typeof createGate>, amplitude: number, blocks = 100): Float32Array {
  let last = constantBlock(amplitude);
  for (let i = 0; i < blocks; i += 1) {
    last = gate.process(constantBlock(amplitude), SAMPLE_RATE);
  }
  return last;
}

describe('blockRmsDbfs', () => {
  it('reads a constant block as its own amplitude in dBFS', () => {
    expect(blockRmsDbfs(constantBlock(1))).toBeCloseTo(0, 10);
    expect(blockRmsDbfs(constantBlock(0.5))).toBeCloseTo(-6.0206, 4);
    expect(blockRmsDbfs(constantBlock(0.001))).toBeCloseTo(-60, 5);
  });

  it('floors digital silence instead of returning -Infinity', () => {
    const silence = blockRmsDbfs(constantBlock(0));
    expect(Number.isFinite(silence)).toBe(true);
    expect(silence).toBeCloseTo(-200, 10);
  });
});

describe('isGateOpen', () => {
  it('opens at or above the threshold and closes below it', () => {
    expect(isGateOpen(-40, -45)).toBe(true);
    expect(isGateOpen(-45, -45)).toBe(true);
    expect(isGateOpen(-46, -45)).toBe(false);
  });

  it('treats the range ends as absolutes: -80 is always open, 0 is always closed', () => {
    // Silence is -200 dBFS, i.e. *below* -80: read as an ordinary comparison,
    // the leftmost slider position would gate exactly what it exists to pass.
    expect(isGateOpen(-200, -80)).toBe(true);
    expect(isGateOpen(0, 0)).toBe(false);
  });
});

describe('createGate — S22, gate math', () => {
  it('attenuates a below-threshold signal by exactly attenuationDb at steady state', () => {
    const gate = createGate(gateParams({ thresholdDbfs: -45, attenuationDb: 12 }));

    // -60 dBFS, comfortably under the -45 threshold.
    const output = steadyState(gate, 0.001);

    const expected = gated(0.001, 10 ** (-12 / 20));
    for (const sample of output) expect(sample).toBe(expected);
  });

  it('honours a different attenuation exactly, not approximately', () => {
    for (const attenuationDb of [3, 24, 60]) {
      const gate = createGate(gateParams({ attenuationDb }));
      const output = steadyState(gate, 0.001);
      expect(output[QUANTUM - 1]).toBe(gated(0.001, 10 ** (-attenuationDb / 20)));
    }
  });

  it('passes an above-threshold signal at unity — bit for bit, not merely close', () => {
    const gate = createGate(gateParams({ thresholdDbfs: -45 }));

    // -6 dBFS, well above the threshold.
    const output = steadyState(gate, 0.5);

    for (const sample of output) expect(sample).toBe(0.5);
  });

  it('silences a below-threshold signal completely under fullMute', () => {
    const gate = createGate(gateParams({ fullMute: true }));

    const output = steadyState(gate, 0.001);

    for (const sample of output) expect(sample).toBe(0);
  });

  it('leaves the signal untouched while the gate is disabled', () => {
    const gate = createGate(gateParams({ enabled: false, fullMute: true }));

    const output = steadyState(gate, 0.001);

    for (const sample of output) expect(sample).toBe(f32(0.001));
  });

  it('holds the gate open for holdMs after the signal drops, then releases', () => {
    // 200 ms hold, 0 ms release: the close is instant once hold expires, so the
    // boundary is readable in the output rather than smeared across a ramp.
    const gate = createGate(gateParams({ holdMs: 200, releaseMs: 0, attenuationDb: 60 }));
    gate.process(constantBlock(0.5), SAMPLE_RATE); // opens, arms the hold

    // 200 ms at 16 kHz = 3200 samples = exactly 25 quanta, all of which are
    // still inside the hold window and still pass at unity.
    for (let i = 0; i < 25; i += 1) {
      const block = gate.process(constantBlock(0.001), SAMPLE_RATE);
      expect(block[QUANTUM - 1]).toBe(f32(0.001));
    }

    const afterHold = gate.process(constantBlock(0.001), SAMPLE_RATE);
    expect(afterHold[QUANTUM - 1]).toBe(gated(0.001, 10 ** (-60 / 20)));
  });

  it('ramps up over attackMs rather than jumping to unity', () => {
    // Closed first, then a loud block: 500 ms of attack is 8000 samples, so a
    // single 128-sample quantum can only cover a fraction of the way back up.
    const gate = createGate(gateParams({ attackMs: 500, releaseMs: 0, holdMs: 0, attenuationDb: 12 }));
    steadyState(gate, 0.001, 5);

    const rising = gate.process(constantBlock(0.5), SAMPLE_RATE);

    const floor = 10 ** (-12 / 20);
    expect(rising[0] / 0.5).toBeGreaterThan(floor);
    expect(rising[QUANTUM - 1] / 0.5).toBeLessThan(1);
    // Monotonic: a ramp, not a step.
    expect(rising[QUANTUM - 1]).toBeGreaterThan(rising[0]);
  });

  it('applies a live setParams without being rebuilt (AC 3.3)', () => {
    const gate = createGate(gateParams({ thresholdDbfs: -45, releaseMs: 0, holdMs: 0 }));
    expect(steadyState(gate, 0.001)[0]).toBe(gated(0.001, 10 ** (-12 / 20)));

    // Drop the threshold under the signal: the same input now reads as open.
    gate.setParams(gateParams({ thresholdDbfs: -70, releaseMs: 0, holdMs: 0, attackMs: 0 }));

    expect(steadyState(gate, 0.001)[0]).toBe(f32(0.001));
  });
});

describe('createGate — E7, threshold boundaries', () => {
  it('passes everything at thresholdDbfs = -80, including near-silence', () => {
    const gate = createGate(gateParams({ thresholdDbfs: -80, attenuationDb: 60 }));

    // -100 dBFS: below -80 as a number, but -80 means "always open".
    const output = steadyState(gate, 1e-5);

    for (const sample of output) expect(sample).toBe(f32(1e-5));
  });

  it('closes on everything at thresholdDbfs = 0 without producing a NaN', () => {
    const gate = createGate(gateParams({ thresholdDbfs: 0, attenuationDb: 12 }));

    const output = steadyState(gate, 0.5);

    for (const sample of output) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(sample).toBe(gated(0.5, 10 ** (-12 / 20)));
    }
  });

  it('produces finite samples at either boundary even for a silent input', () => {
    for (const thresholdDbfs of [-80, 0]) {
      const gate = createGate(gateParams({ thresholdDbfs }));
      const output = steadyState(gate, 0);
      for (const sample of output) expect(Number.isFinite(sample)).toBe(true);
    }
  });

  it('clamps an out-of-range threshold to the boundary rather than trusting it', () => {
    const gate = createGate(gateParams({ thresholdDbfs: -500, attenuationDb: 60 }));

    // -500 clamps to -80, which is always open.
    expect(steadyState(gate, 1e-5)[0]).toBe(f32(1e-5));
  });

  it('never divides by zero for zero-length ramps or an empty block', () => {
    const gate = createGate(gateParams({ attackMs: 0, releaseMs: 0, holdMs: 0 }));

    expect(gate.process(new Float32Array(0), SAMPLE_RATE)).toHaveLength(0);
    const output = steadyState(gate, 0.001, 3);
    for (const sample of output) expect(Number.isFinite(sample)).toBe(true);
  });
});

describe('createGate — E8, attenuation and full mute', () => {
  it('is a no-op at attenuationDb = 0, even fully closed', () => {
    expect(gateFloorGain(gateParams({ attenuationDb: 0 }))).toBe(1);

    const gate = createGate(gateParams({ attenuationDb: 0, thresholdDbfs: 0 }));
    const output = steadyState(gate, 0.001);

    for (const sample of output) expect(sample).toBe(f32(0.001));
  });

  it('lets fullMute override attenuationDb entirely', () => {
    expect(gateFloorGain(gateParams({ attenuationDb: 0, fullMute: true }))).toBe(0);
    expect(gateFloorGain(gateParams({ attenuationDb: 60, fullMute: true }))).toBe(0);

    // attenuationDb 0 would otherwise be a no-op; fullMute wins.
    const gate = createGate(gateParams({ attenuationDb: 0, fullMute: true }));
    const output = steadyState(gate, 0.001);

    for (const sample of output) expect(sample).toBe(0);
  });

  it('reads floorGain straight off the attenuation everywhere else', () => {
    expect(gateFloorGain(gateParams({ attenuationDb: 6 }))).toBeCloseTo(0.5011872, 6);
    expect(gateFloorGain(gateParams({ attenuationDb: 20 }))).toBeCloseTo(0.1, 12);
  });
});

/**
 * The worklet is a hand-mirror of this module (it runs in a realm that cannot
 * import TypeScript), so the failure to watch for is a copy that has quietly
 * drifted. Rather than trusting the header comment, load the real
 * `public/gate-processor.js`, run it, and require it to produce the same
 * samples as `createGate` — the same idea as `pcm.test.ts`'s
 * `floatSampleToInt16` check, one level up.
 */
describe('public/gate-processor.js — parity with rmsGate.ts', () => {
  // Read off disk, the same way tuningConfig.test.ts reads the cross-language
  // fingerprint fixture: the point is to run the bytes that ship, not a copy.
  const WORKLET_SOURCE = readFileSync(resolve(process.cwd(), 'public/gate-processor.js'), 'utf8');

  interface WorkletProcessor {
    port: { onmessage: ((event: { data: unknown }) => void) | null };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  }

  /**
   * Evaluates the worklet under stand-ins for the three things
   * AudioWorkletGlobalScope gives it: the base class, the registration hook,
   * and the context's `sampleRate` global.
   */
  function loadWorklet(gate: GateParams, sampleRate = SAMPLE_RATE): WorkletProcessor {
    class FakeAudioWorkletProcessor {
      port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: () => void } = {
        onmessage: null,
        postMessage: () => {},
      };
    }
    let Processor: (new (options: unknown) => WorkletProcessor) | undefined;
    const register = (_name: string, processor: new (options: unknown) => WorkletProcessor) => {
      Processor = processor;
    };
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WORKLET_SOURCE)(
      FakeAudioWorkletProcessor,
      register,
      sampleRate,
    );
    if (!Processor) throw new Error('the worklet registered no processor');
    return new Processor({ processorOptions: { gate } });
  }

  /** One block through the worklet, out of its separate output buffer. */
  function workletBlock(processor: WorkletProcessor, block: Float32Array): Float32Array {
    const output = new Float32Array(block.length);
    processor.process([[block]], [[output]]);
    return output;
  }

  /**
   * Asserts parity on every block, not only the last: a divergence that later
   * converges again is still a divergence.
   */
  function expectParity(gate: GateParams, amplitudes: number[]): void {
    const processor = loadWorklet(gate);
    const reference = createGate(gate);
    for (const amplitude of amplitudes) {
      const fromWorklet = workletBlock(processor, constantBlock(amplitude));
      const fromModule = reference.process(constantBlock(amplitude), SAMPLE_RATE);
      expect([...fromWorklet]).toEqual([...fromModule]);
    }
  }

  it('matches sample for sample through open, hold, release and steady state', () => {
    // Loud, then 40 quanta of near-silence: crosses the threshold, exhausts the
    // 200 ms hold, rides the 80 ms release ramp down, and settles on the floor.
    expectParity(gateParams(), [0.5, ...Array<number>(40).fill(0.001)]);
  });

  it('matches on every block of a sweep that straddles the threshold', () => {
    // A sweep that only ever sits far from the threshold would agree with a
    // worklet whose comparison had drifted by several dB. These amplitudes
    // bracket -45 dBFS (0.005623) at ±0.5 dB, so a drift of even 1 dB flips a
    // block from open to closed in one implementation and not the other — and
    // the hold is off, because a hold long enough to span the sweep would keep
    // the gate open through every one of those flips and hide the drift again.
    expectParity(gateParams({ holdMs: 0 }), [
      0.5, 0.0053, 0.006, 0.0056, 0.0057, 0.0055, 0.001, 0.0059, 0.0054, 0.0058, 0.0052,
    ]);
  });

  it('matches at both threshold boundaries and under full mute', () => {
    // The two ends are only *absolutes* rather than comparisons for inputs that
    // sit outside them, so the sweep has to visit both: 1e-5 is -100 dBFS,
    // under the -80 end, and a full-scale block is 0 dBFS, at the 0 end.
    const crossing = [0.5, 1e-5, 0.001, 1, 1e-5, 1, 0.5, 1e-5];
    for (const gate of [
      gateParams({ thresholdDbfs: -80, holdMs: 0 }),
      gateParams({ thresholdDbfs: 0, holdMs: 0 }),
      gateParams({ fullMute: true, holdMs: 0, releaseMs: 0 }),
      gateParams({ attenuationDb: 0 }),
      gateParams({ enabled: false }),
    ]) {
      expectParity(gate, crossing);
    }
  });

  it('takes live parameters over its port and matches setParams afterwards', () => {
    const processor = loadWorklet(gateParams({ thresholdDbfs: -45 }));
    const reference = createGate(gateParams({ thresholdDbfs: -45 }));
    workletBlock(processor, constantBlock(0.001));
    reference.process(constantBlock(0.001), SAMPLE_RATE);

    const next = gateParams({ thresholdDbfs: -70, attackMs: 0 });
    processor.port.onmessage?.({ data: { type: 'gateParams', gate: next } });
    reference.setParams(next);

    expect([...workletBlock(processor, constantBlock(0.001))]).toEqual([
      ...reference.process(constantBlock(0.001), SAMPLE_RATE),
    ]);
  });

  it('clamps a hostile parameter message rather than trusting the port', () => {
    const processor = loadWorklet(gateParams());
    processor.port.onmessage?.({
      data: {
        type: 'gateParams',
        gate: { enabled: true, thresholdDbfs: NaN, holdMs: 4, attackMs: 6.4, attenuationDb: 900, fullMute: false },
      },
    });

    // NaN falls back to the documented default (-45), 900 dB clamps to 60, and
    // the two off-grid durations snap to their steps (10 ms and 1 ms) — exactly
    // what `clampGateParams` would have produced on the main thread.
    const reference = createGate(
      gateParams({ thresholdDbfs: -45, attenuationDb: 60, holdMs: 0, attackMs: 6, releaseMs: 80 }),
    );
    for (const amplitude of [0.5, ...Array<number>(40).fill(0.001)]) {
      const fromWorklet = workletBlock(processor, constantBlock(amplitude));
      const fromModule = reference.process(constantBlock(amplitude), SAMPLE_RATE);
      expect([...fromWorklet]).toEqual([...fromModule]);
    }
  });

  it('ignores a message type it does not know', () => {
    const processor = loadWorklet(gateParams({ fullMute: true, holdMs: 0, releaseMs: 0 }));
    processor.port.onmessage?.({ data: { type: 'somethingElse', gate: { enabled: false } } });

    // Still the gate it was constructed with: silence, not pass-through.
    expect([...workletBlock(processor, constantBlock(0.001))]).toEqual([...new Float32Array(QUANTUM)]);
  });
});
