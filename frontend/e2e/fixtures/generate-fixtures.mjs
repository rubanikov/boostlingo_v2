// Generates the placeholder .wav fixtures Chrome's
// `--use-file-for-fake-audio-capture` flag reads from (see
// frontend/e2e/README.md and frontend/playwright.config.ts).
//
// These are NOT speech. They exist only to prove the fake-mic Playwright
// harness works mechanically (browser launches, mic permission is
// auto-granted, the fake device "speaks" audio into getUserMedia()). Once
// the backend's TTS-generated speech fixtures exist (see
// .scratch/ai-interpreter-workbench/tickets/08-quality-validation-suite.md),
// swap the file paths in playwright.config.ts to point at those instead —
// no other harness change needed.
//
// Deliberately dependency-free (plain node:fs + PCM math) since neither a
// real TTS key nor an audio library is available in this environment. Run
// with `node e2e/fixtures/generate-fixtures.mjs` from frontend/ to
// regenerate.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 48000; // common getUserMedia default; Chrome resamples the fake device output as needed.
const DURATION_SECONDS = 3;
const TONE_HZ = 440; // A4 — arbitrary, audible, not speech.
const TONE_AMPLITUDE = 0.3; // fraction of full-scale int16, well clear of clipping.

/** Builds a mono 16-bit PCM WAV file's bytes for the given samples. */
function encodeWav(samples, sampleRate) {
  const blockAlign = 2; // 16-bit mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');

  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample

  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

function silenceSamples(sampleRate, seconds) {
  return new Int16Array(sampleRate * seconds); // zero-filled by default
}

function toneSamples(sampleRate, seconds, hz, amplitude) {
  const count = sampleRate * seconds;
  const samples = new Int16Array(count);
  const peak = Math.round(amplitude * 32767);
  for (let i = 0; i < count; i++) {
    samples[i] = Math.round(peak * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  }
  return samples;
}

const fixturesDir = fileURLToPath(new URL('.', import.meta.url));

writeFileSync(
  `${fixturesDir}placeholder-tone.wav`,
  encodeWav(toneSamples(SAMPLE_RATE, DURATION_SECONDS, TONE_HZ, TONE_AMPLITUDE), SAMPLE_RATE),
);
writeFileSync(`${fixturesDir}silence.wav`, encodeWav(silenceSamples(SAMPLE_RATE, DURATION_SECONDS), SAMPLE_RATE));

console.log(`Wrote placeholder-tone.wav and silence.wav (${DURATION_SECONDS}s @ ${SAMPLE_RATE}Hz) to ${fixturesDir}`);
