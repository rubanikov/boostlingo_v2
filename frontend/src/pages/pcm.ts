/**
 * Pure PCM16 <-> Float32 conversion helpers for Cascade mode.
 *
 * `floatSampleToInt16` mirrors the exact scale-and-clamp formula implemented
 * in the AudioWorklet mic-capture processor (public/cascade-pcm-processor.js).
 * That file runs in AudioWorkletGlobalScope, a separate JS realm loaded via
 * `audioContext.audioWorklet.addModule()`, so it can't import this module.
 * This copy is the unit-tested source of truth for the formula; keep the two
 * in sync by hand if it ever changes.
 */
export function floatSampleToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped * 32767);
}

/**
 * Decodes a little-endian PCM16 buffer (as sent in the `tts_audio_meta` +
 * binary frame pair) into Float32 samples in [-1, 1], ready for
 * `AudioBuffer.getChannelData()`.
 */
export function int16BufferToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  const sampleCount = Math.floor(buffer.byteLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}
