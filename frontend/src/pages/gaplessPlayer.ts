/**
 * Structural subsets of the Web Audio interfaces this module needs. A real
 * `AudioContext` satisfies these directly, and tests can pass a lightweight
 * fake instead of a full (jsdom-unsupported) Web Audio implementation.
 */
export interface AudioBufferLike {
  duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  connect(destination: unknown): unknown;
  start(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
}

export interface GaplessPlayer {
  /** Decode one PCM segment and schedule it to play immediately after whatever's already queued. */
  schedule(samples: Float32Array, sampleRate: number): AudioBufferSourceLike;
  /** audioContext.currentTime at which everything currently queued will have finished playing. */
  queuedUntil(): number;
}

/**
 * Schedules successive raw-PCM TTS segments back-to-back with no gap or
 * overlap: each segment starts at `max(audioContext.currentTime, nextStartTime)`,
 * and `nextStartTime` advances by that segment's duration: the standard
 * Web Audio buffer-queueing pattern for gapless playback.
 */
export function createGaplessPlayer(audioContext: AudioContextLike): GaplessPlayer {
  let nextStartTime = 0;

  function schedule(samples: Float32Array, sampleRate: number): AudioBufferSourceLike {
    const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const startTime = Math.max(audioContext.currentTime, nextStartTime);
    source.start(startTime);
    nextStartTime = startTime + buffer.duration;

    return source;
  }

  return { schedule, queuedUntil: () => nextStartTime };
}
