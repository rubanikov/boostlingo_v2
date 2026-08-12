import { vi } from 'vitest';

/**
 * Manually-flushable stand-in for requestAnimationFrame/cancelAnimationFrame,
 * letting tests advance mic-level sampling deterministically instead of
 * waiting on real frame timing.
 */
export function installManualAnimationFrame() {
  let queued: Array<{ id: number; callback: FrameRequestCallback }> = [];
  const cancelled = new Set<number>();
  let nextId = 1;

  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      queued.push({ id, callback });
      return id;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      cancelled.add(id);
    }),
  );

  return {
    /** Runs every callback currently queued (one "frame"), skipping any cancelled since being queued. */
    flush() {
      const pending = queued;
      queued = [];
      for (const { id, callback } of pending) {
        if (!cancelled.has(id)) callback(0);
      }
    },
  };
}

/** Stand-in for AnalyserNode — tests control what getByteTimeDomainData() reports. */
export class FakeAnalyserNode {
  fftSize = 2048;
  frequencyBinCount = 1024;
  connect = vi.fn();
  private nextData: Uint8Array | null = null;

  getByteTimeDomainData = vi.fn((array: Uint8Array) => {
    if (this.nextData) {
      array.set(this.nextData.subarray(0, array.length));
    } else {
      array.fill(128); // silence baseline
    }
  });

  /** Test helper: the bytes the next getByteTimeDomainData() call should report. */
  setNextData(data: Uint8Array) {
    this.nextData = data;
  }
}
