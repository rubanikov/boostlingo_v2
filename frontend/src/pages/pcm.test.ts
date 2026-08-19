import { describe, expect, it } from 'vitest';
import { floatSampleToInt16, int16BufferToFloat32 } from './pcm';

describe('floatSampleToInt16', () => {
  it('scales a mid-range sample into the int16 range', () => {
    expect(floatSampleToInt16(0.5)).toBe(16384);
    // Math.round rounds half-way values toward +Infinity, so -16383.5 -> -16383.
    expect(floatSampleToInt16(-0.5)).toBe(-16383);
  });

  it('maps silence to zero', () => {
    expect(floatSampleToInt16(0)).toBe(0);
  });

  it('clamps out-of-range samples instead of overflowing', () => {
    expect(floatSampleToInt16(1.5)).toBe(32767);
    expect(floatSampleToInt16(-1.5)).toBe(-32767);
  });

  it('maps full-scale samples to the edges of the int16 range', () => {
    expect(floatSampleToInt16(1)).toBe(32767);
    expect(floatSampleToInt16(-1)).toBe(-32767);
  });
});

describe('int16BufferToFloat32', () => {
  it('decodes little-endian int16 samples back into [-1, 1] floats', () => {
    const buffer = new ArrayBuffer(6);
    const view = new DataView(buffer);
    view.setInt16(0, 0, true);
    view.setInt16(2, 16384, true);
    view.setInt16(4, -32768, true);

    const samples = int16BufferToFloat32(buffer);

    expect(samples).toHaveLength(3);
    expect(samples[0]).toBeCloseTo(0);
    expect(samples[1]).toBeCloseTo(0.5);
    expect(samples[2]).toBeCloseTo(-1);
  });

  it('round-trips a value produced by floatSampleToInt16', () => {
    const original = 0.25;
    const buffer = new ArrayBuffer(2);
    new DataView(buffer).setInt16(0, floatSampleToInt16(original), true);

    expect(int16BufferToFloat32(buffer)[0]).toBeCloseTo(original, 3);
  });
});
