import { describe, expect, it, vi } from 'vitest';
import { peakLevel, startMicLevelMeter } from './micLevel';

describe('peakLevel', () => {
  it('returns 0 for silence (all samples at the 128 midpoint)', () => {
    expect(peakLevel(new Uint8Array([128, 128, 128]))).toBe(0);
  });

  it('returns ~1 for a full-scale sample (0 or 255, the extremes of an unsigned byte)', () => {
    expect(peakLevel(new Uint8Array([128, 255, 128]))).toBeCloseTo(1, 1);
    expect(peakLevel(new Uint8Array([128, 0, 128]))).toBe(1);
  });

  it('returns the peak deviation, not the average, across the buffer', () => {
    // A single loud sample among quiet ones should still register as loud.
    expect(peakLevel(new Uint8Array([128, 129, 192, 129]))).toBeCloseTo(64 / 128, 5);
  });
});

describe('startMicLevelMeter', () => {
  function fakeAnalyser(nextData: Uint8Array) {
    return {
      fftSize: 0,
      frequencyBinCount: nextData.length,
      connect: vi.fn(),
      getByteTimeDomainData: vi.fn((array: Uint8Array) => array.set(nextData)),
    };
  }

  function manualScheduler() {
    const queued: Array<() => void> = [];
    const cancelled = new Set<number>();
    let nextId = 1;
    return {
      schedule: vi.fn((callback: () => void) => {
        const id = nextId++;
        queued.push(callback);
        return id;
      }),
      cancel: vi.fn((id: number) => cancelled.add(id)),
      flush() {
        const pending = queued.splice(0, queued.length);
        pending.forEach((callback) => callback());
      },
    };
  }

  it('reports a level derived from the analyser data on each scheduled frame', () => {
    const analyser = fakeAnalyser(new Uint8Array([128, 0]));
    const audioContext = { createAnalyser: () => analyser };
    const source = { connect: vi.fn() };
    const levels: number[] = [];
    const { schedule, cancel, flush } = manualScheduler();

    startMicLevelMeter(audioContext, source, (level) => levels.push(level), schedule, cancel);

    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(levels).toEqual([]); // first frame only scheduled, not yet run

    flush();
    expect(levels).toEqual([1]);

    flush();
    expect(levels).toEqual([1, 1]);
  });

  it('stops sampling once stop() is called', () => {
    const analyser = fakeAnalyser(new Uint8Array([128, 128]));
    const audioContext = { createAnalyser: () => analyser };
    const source = { connect: vi.fn() };
    const levels: number[] = [];
    const { schedule, cancel, flush } = manualScheduler();

    const meter = startMicLevelMeter(audioContext, source, (level) => levels.push(level), schedule, cancel);
    flush();
    expect(levels).toHaveLength(1);

    meter.stop();
    expect(cancel).toHaveBeenCalled();

    flush();
    // The already-cancelled frame shouldn't report another level.
    expect(levels).toHaveLength(1);
  });
});
