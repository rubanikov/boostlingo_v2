import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { floatSampleToInt16 } from './pcm';
import {
  DECIMATION_FACTOR,
  DECIMATION_SOURCE_RATE,
  DECIMATION_TARGET_RATE,
  DECIMATOR_TAP_COUNT,
  createDecimator,
  createDecimatorState,
  decimate48kTo16k,
  decimatorTaps,
} from './resample';

/** A pure tone, `samples` long, at the 48 kHz source rate. */
function tone(hz: number, samples: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / DECIMATION_SOURCE_RATE);
  }
  return out;
}

/** RMS over a slice, skipping the head while the filter's history fills. */
function rms(samples: Float32Array, from = 0): number {
  let sum = 0;
  for (let i = from; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length - from));
}

describe('decimatorTaps', () => {
  const taps = decimatorTaps();

  it('is an 8-tap filter with unity DC gain', () => {
    expect(taps).toHaveLength(DECIMATOR_TAP_COUNT);
    expect([...taps].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('is symmetric, which is what makes the phase linear', () => {
    for (let k = 0; k < DECIMATOR_TAP_COUNT / 2; k += 1) {
      expect(taps[k]).toBeCloseTo(taps[DECIMATOR_TAP_COUNT - 1 - k], 15);
    }
  });
});

describe('decimate48kTo16k', () => {
  it('emits one sample in three', () => {
    expect(DECIMATION_FACTOR).toBe(3);
    expect(DECIMATION_SOURCE_RATE / DECIMATION_TARGET_RATE).toBe(3);
    // 1440 samples is exactly the 30 ms chunk the worklet buffers at 48 kHz;
    // 480 is exactly the 30 ms chunk the backend's frame contract expects.
    expect(decimate48kTo16k(tone(1000, 1440), createDecimatorState())).toHaveLength(480);
    expect(decimate48kTo16k(new Float32Array(300), createDecimatorState())).toHaveLength(100);
  });

  it('passes a 1 kHz tone through essentially untouched', () => {
    const input = tone(1000, 4800);
    const output = decimate48kTo16k(input, createDecimatorState());
    // -0.09 dB by design at 1 kHz. Anything worse than 2% would mean the
    // coefficients are no longer normalised to unity DC gain.
    expect(rms(output, 16) / rms(input)).toBeCloseTo(0.9897, 2);
  });

  it('attenuates content above the 8 kHz output Nyquist, which would otherwise alias', () => {
    const passband = rms(decimate48kTo16k(tone(1000, 4800), createDecimatorState()), 16);
    const measure = (hz: number) => rms(decimate48kTo16k(tone(hz, 4800), createDecimatorState()), 16) / passband;

    // The designed skirt of an 8-tap Hamming-windowed sinc at fc = 7 kHz. It is
    // a gentle one on purpose (cheap filter, brief's choice), so these are the
    // real numbers rather than aspirational ones: content just above the corner
    // is reduced, not removed, and only well past it does it disappear.
    expect(measure(8000)).toBeLessThan(0.55); // ~-6 dB, at the output Nyquist
    expect(measure(10000)).toBeLessThan(0.35); // ~-10 dB
    expect(measure(14000)).toBeLessThan(0.1); // ~-21 dB
    expect(measure(18000)).toBeLessThan(0.02); // ~-47 dB
  });

  it('streams: any chunking of the input produces the same samples as one call', () => {
    const input = tone(3000, 4096);
    const oneShot = decimate48kTo16k(input, createDecimatorState());

    // 128 is the render quantum and is *not* a multiple of 3, so the phase has
    // to survive the call boundary; the ragged sizes cover the other two
    // phases and a block shorter than the decimation factor.
    for (const sizes of [[128], [1, 2, 5, 128, 333], [3], [1000, 1, 1, 1]]) {
      const decimator = createDecimator();
      const pieces: number[] = [];
      let offset = 0;
      let i = 0;
      while (offset < input.length) {
        const size = Math.min(sizes[i % sizes.length], input.length - offset);
        pieces.push(...decimator.process(input.subarray(offset, offset + size)));
        offset += size;
        i += 1;
      }
      expect(pieces).toEqual([...oneShot]);
    }
  });

  it('starts from silence rather than from whatever the last session left behind', () => {
    const first = createDecimator();
    const second = createDecimator();
    const block = tone(1000, 480);
    expect([...second.process(block)]).toEqual([...first.process(block)]);
  });
});

/**
 * The worklet is a hand-mirror of this module (it runs in a realm that cannot
 * import TypeScript), so the failure to watch for is a copy that has quietly
 * drifted. Rather than trusting the header comment, load the real
 * `public/cascade-pcm-processor.js`, run it, and require it to produce the same
 * samples — the same arrangement `rmsGate.test.ts` uses for
 * `gate-processor.js`.
 *
 * This is brief test E9: the 48 kHz context plus the 3:1 decimator still
 * yields 960-byte / 30 ms frames, and `resample.ts`'s output matches the
 * worklet's.
 */
describe('public/cascade-pcm-processor.js — parity with resample.ts (E9)', () => {
  const WORKLET_SOURCE = readFileSync(resolve(process.cwd(), 'public/cascade-pcm-processor.js'), 'utf8');
  const RENDER_QUANTUM = 128;

  interface WorkletProcessor {
    posted: ArrayBuffer[];
    process(inputs: Float32Array[][]): boolean;
  }

  /**
   * Evaluates the worklet under stand-ins for the three things
   * AudioWorkletGlobalScope gives it: the base class, the registration hook,
   * and the context's `sampleRate` global.
   */
  function loadWorklet(contextSampleRate: number, processorOptions?: Record<string, unknown>): WorkletProcessor {
    const posted: ArrayBuffer[] = [];
    class FakeAudioWorkletProcessor {
      posted = posted;
      port = {
        onmessage: null,
        postMessage: (buffer: ArrayBuffer) => posted.push(buffer),
      };
    }
    let Processor: (new (options: unknown) => WorkletProcessor) | undefined;
    const register = (_name: string, processor: new (options: unknown) => WorkletProcessor) => {
      Processor = processor;
    };
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WORKLET_SOURCE)(
      FakeAudioWorkletProcessor,
      register,
      contextSampleRate,
    );
    if (!Processor) throw new Error('the worklet registered no processor');
    return new Processor({ processorOptions });
  }

  /**
   * The expected Int16 stream, normalised through an Int16Array so a `-0`
   * (which `Math.round(-0 * 32767)` genuinely produces) compares equal to the
   * `0` the worklet's own Int16Array stored.
   */
  function toInt16(samples: Float32Array | number[]): number[] {
    return [...Int16Array.from([...samples].map(floatSampleToInt16))];
  }

  /** Feeds a signal in render quanta, the way the audio thread actually would. */
  function run(processor: WorkletProcessor, input: Float32Array): Int16Array[] {
    for (let offset = 0; offset < input.length; offset += RENDER_QUANTUM) {
      processor.process([[input.subarray(offset, Math.min(offset + RENDER_QUANTUM, input.length))]]);
    }
    return processor.posted.map((buffer) => new Int16Array(buffer));
  }

  it('still posts 960-byte / 30 ms frames from a 48 kHz context', () => {
    const processor = loadWorklet(48000, { targetSampleRate: 16000 });
    // 10 chunks' worth of 48 kHz audio: 10 * 30 ms * 48 samples/ms.
    const chunks = run(processor, tone(440, 10 * 1440));

    expect(chunks).toHaveLength(10);
    for (const chunk of chunks) {
      expect(chunk.byteLength).toBe(960);
      expect(chunk).toHaveLength(480);
    }
  });

  it('produces exactly the samples resample.ts does, all the way to Int16', () => {
    const input = tone(1200, 6 * 1440, 0.8);
    const fromWorklet = run(loadWorklet(48000, { targetSampleRate: 16000 }), input);

    expect(fromWorklet.flatMap((chunk) => [...chunk])).toEqual(
      toInt16(decimate48kTo16k(input, createDecimatorState())),
    );
  });

  it('leaves a 16 kHz context exactly as it was — same rate in, same 960-byte frames out', () => {
    const input = tone(440, 3 * 480);
    const chunks = run(loadWorklet(16000, { targetSampleRate: 16000 }), input);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].byteLength).toBe(960);
    expect(chunks.flatMap((chunk) => [...chunk])).toEqual(toInt16(input));
  });

  it('decimates only when it was told the target rate, never on a guess', () => {
    // A 48 kHz context with no processorOptions at all (how the node was
    // constructed before ticket 13): pass-through, 1440-sample frames.
    const chunks = run(loadWorklet(48000), tone(440, 1440));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1440);
  });
});
