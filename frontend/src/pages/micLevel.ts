/**
 * Structural subsets of the Web Audio interfaces this module needs. Mirrors
 * gaplessPlayer.ts's approach so a real AudioContext/AnalyserNode satisfies
 * these directly, and tests can pass lightweight fakes instead of a full
 * (jsdom-unsupported) Web Audio implementation.
 */
export interface AnalyserLike {
  fftSize: number;
  readonly frequencyBinCount: number;
  getByteTimeDomainData(array: Uint8Array): void;
}

export interface MicLevelSourceLike {
  connect(destination: unknown): unknown;
}

export interface MicLevelAudioContextLike {
  createAnalyser(): AnalyserLike;
}

export interface MicLevelMeter {
  /** Stops sampling and cancels the pending animation frame. */
  stop(): void;
}

/**
 * Converts a Web Audio time-domain byte buffer (values 0-255, centered on
 * 128) into a single 0-1 peak amplitude, for driving a level meter.
 */
export function peakLevel(timeDomainData: Uint8Array): number {
  let maxDeviation = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const deviation = Math.abs(timeDomainData[i] - 128);
    if (deviation > maxDeviation) maxDeviation = deviation;
  }
  return Math.min(maxDeviation / 128, 1);
}

/**
 * Taps an AnalyserNode onto `source` and reports a live 0-1 peak level via
 * `onLevel` once per animation frame, until `stop()` is called. Shared by
 * both session hooks so the level meter behaves identically regardless of
 * transport (WebSocket vs. WebRTC). `schedule`/`cancel` default to the real
 * `requestAnimationFrame`/`cancelAnimationFrame` and only need overriding in
 * tests, which want deterministic, manually-flushed frames.
 */
export function startMicLevelMeter(
  audioContext: MicLevelAudioContextLike,
  source: MicLevelSourceLike,
  onLevel: (level: number) => void,
  schedule: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
  cancel: (handle: number) => void = (handle) => {
    cancelAnimationFrame(handle);
  },
): MicLevelMeter {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  let frameHandle = 0;
  let stopped = false;

  function tick() {
    if (stopped) return;
    analyser.getByteTimeDomainData(data);
    onLevel(peakLevel(data));
    frameHandle = schedule(tick);
  }
  frameHandle = schedule(tick);

  return {
    stop: () => {
      stopped = true;
      cancel(frameHandle);
    },
  };
}
