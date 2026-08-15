// Plays each recorded clip of the Realtime quality corpus into a live
// Realtime session and captures what `gpt-realtime` said back.
//
// This is the "Realtime half" of the quality comparison in COMPARISON.md
// section 2. Cascade has an independently callable translate() step, so its
// LLM-judge run reads the dataset text directly. Realtime's translation
// happens inside the model, so the only way to get a translation out is to
// actually run an audio session and read the output transcript. That is what
// this does, one browser launch per clip, using Chromium's fake-mic device
// (the same mechanism as the Playwright e2e specs, see playwright.config.ts).
//
// Input:  backend/tests/fixtures/realtime_quality/manifest.json + *.wav
//         (written by backend/tests/fixtures/real_audio/recorder.html's
//         "Realtime quality corpus" prompt set; SCRIPT.md there says what to
//         record).
// Output: backend/tests/fixtures/realtime_quality/captures.json, one entry
//         per clip: the input-side transcript (gpt-4o-transcribe's caption of
//         the clip), the model's spoken-output transcript, and the end-to-end
//         latency the UI measured for that turn.
//
// Then:   cd backend && uv run python -m tests.fixtures.run_realtime_quality_report
//         judges every capture and writes realtime_quality_report.json.
//
// Needs both dev servers running with real keys in backend/.env (dev.ps1 from
// the repo root starts both). Costs a few dollars of gpt-realtime audio
// tokens for the whole corpus.
//
// Usage (from frontend/):
//   node e2e/realtime-quality-capture.mjs                # all clips
//   node e2e/realtime-quality-capture.mjs --only short-en-01,short-es-03
//   node e2e/realtime-quality-capture.mjs --limit 2 --headed
//   node e2e/realtime-quality-capture.mjs --manifest other/manifest.json --out other/captures.json
// Env: BASE_URL (default http://localhost:5173), BACKEND_URL (default
//   http://localhost:8000).

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A problem with how the script was invoked or what it found, as opposed to
// a bug: reported as a one-line message and a non-zero exit, no stack trace.
class UsageError extends Error {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_CORPUS_DIR = path.join(REPO_ROOT, 'backend/tests/fixtures/realtime_quality');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8000';

const args = parseArgs(process.argv.slice(2));
const MANIFEST_PATH = args.manifest ?? path.join(DEFAULT_CORPUS_DIR, 'manifest.json');
const CORPUS_DIR = path.dirname(MANIFEST_PATH);
const CAPTURES_PATH = args.out ?? path.join(CORPUS_DIR, 'captures.json');
const PADDED_DIR = path.join(CORPUS_DIR, '.padded');

// The fake mic starts producing audio the moment getUserMedia() resolves,
// which is before the ephemeral-token fetch and WebRTC handshake finish, so
// the first couple of seconds of any clip would be lost. Each clip is
// re-written with this much leading silence so speech starts only once the
// session is up, plus trailing silence so server VAD sees a clean end.
const LEAD_SILENCE_S = 4;
const TAIL_SILENCE_S = 3;
const SAMPLE_RATE = 16000;

// How long to keep waiting for the model's reply after the clip has fully
// played, and how long the reply transcript must sit unchanged before it's
// considered complete.
const REPLY_GRACE_MS = 15_000;
const STABLE_MS = 3_000;
const CONNECT_TIMEOUT_MS = 20_000;

async function main() {
  await assertServersUp();

  if (!existsSync(MANIFEST_PATH)) {
    throw new UsageError(`No manifest at ${MANIFEST_PATH}. Record the corpus first: see ${path.join(CORPUS_DIR, 'SCRIPT.md')}.`);
  }
  let items = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).items;
  if (args.only) items = items.filter((item) => args.only.includes(item.id));
  if (args.limit) items = items.slice(0, args.limit);
  if (items.length === 0) {
    throw new UsageError('Nothing to capture after filtering.');
  }

  mkdirSync(PADDED_DIR, { recursive: true });
  const previous = existsSync(CAPTURES_PATH) ? JSON.parse(readFileSync(CAPTURES_PATH, 'utf8')).items ?? [] : [];
  const byId = new Map(previous.map((c) => [c.id, c]));

  console.log(`Capturing ${items.length} clip(s) against ${BASE_URL}\n`);
  for (const [index, item] of items.entries()) {
    const wavPath = path.join(CORPUS_DIR, item.audioFile);
    if (!existsSync(wavPath)) {
      console.log(`[${index + 1}/${items.length}] ${item.id}: SKIP missing ${item.audioFile}`);
      continue;
    }
    const { paddedPath, clipDurationS } = padClip(wavPath, path.join(PADDED_DIR, item.audioFile));
    process.stdout.write(`[${index + 1}/${items.length}] ${item.id} (${item.sourceLang}→${item.targetLang}, ${clipDurationS.toFixed(1)}s) … `);
    const capture = await captureOne(item, paddedPath, clipDurationS);
    byId.set(item.id, capture);
    // Written after every clip so a crash or Ctrl+C partway keeps what's done.
    writeCaptures([...byId.values()]);
    if (capture.error) {
      console.log(`ERROR ${capture.error}`);
    } else {
      console.log(`ok${capture.endToEndLatencyMs != null ? ` (${capture.endToEndLatencyMs}ms)` : ''}`);
      console.log(`      heard: ${JSON.stringify(capture.inputTranscript)}`);
      console.log(`      said:  ${JSON.stringify(capture.outputTranscript)}`);
    }
  }
  console.log(`\nWrote ${CAPTURES_PATH}`);
  console.log('Next: cd backend && uv run python -m tests.fixtures.run_realtime_quality_report');
}

async function captureOne(item, paddedPath, clipDurationS) {
  const base = {
    id: item.id,
    sourceLang: item.sourceLang,
    targetLang: item.targetLang,
    referenceText: item.referenceText,
    referenceTranslation: item.referenceTranslation ?? null,
    conditions: item.conditions ?? null,
    capturedAt: new Date().toISOString(),
  };
  // `%noloop`: play the file once, then silence, instead of Chromium's
  // default of looping it (which would make the model hear the line again
  // and produce a second turn).
  const browser = await chromium.launch({
    headless: !args.headed,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${paddedPath}%noloop`,
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await page.goto(BASE_URL);
    await page.getByRole('tab', { name: 'Realtime' }).click();
    // The fake mic starts playing here (getUserMedia resolves inside
    // connect()), so the lead silence budget starts now.
    await page.getByRole('button', { name: 'Connect microphone' }).click();

    const status = await waitForSettledStatus(page, CONNECT_TIMEOUT_MS);
    if (status !== 'Connected') {
      const alert = await page.getByRole('alert').textContent().catch(() => null);
      return { ...base, error: `session settled to '${status}'${alert ? `: ${alert.trim()}` : ''}` };
    }

    const target = page.getByTestId('target-transcript');
    const source = page.getByTestId('source-transcript');
    const clipEndsInMs = (LEAD_SILENCE_S + clipDurationS) * 1000;
    const firstReplyDeadline = Date.now() + clipEndsInMs + REPLY_GRACE_MS;

    let outputTranscript = '';
    while (Date.now() < firstReplyDeadline) {
      outputTranscript = (await target.innerText()).trim();
      if (outputTranscript) break;
      await page.waitForTimeout(250);
    }
    if (outputTranscript) {
      // Keep reading until the reply has stopped growing for STABLE_MS.
      let lastChange = Date.now();
      while (Date.now() - lastChange < STABLE_MS) {
        await page.waitForTimeout(250);
        const now = (await target.innerText()).trim();
        if (now !== outputTranscript) {
          outputTranscript = now;
          lastChange = Date.now();
        }
      }
    }
    // The caption side channel can lag the reply; give it a moment.
    let inputTranscript = (await source.innerText()).trim();
    for (let i = 0; i < 12 && !inputTranscript; i++) {
      await page.waitForTimeout(250);
      inputTranscript = (await source.innerText()).trim();
    }
    const badge = await page.getByTestId('realtime-latency-badge').textContent().catch(() => null);
    const latencyMatch = badge?.match(/(\d+)\s*ms/);

    return {
      ...base,
      inputTranscript,
      outputTranscript,
      endToEndLatencyMs: latencyMatch ? Number(latencyMatch[1]) : null,
      pageErrors,
      error: outputTranscript ? null : 'no reply transcript arrived before the deadline',
    };
  } catch (err) {
    return { ...base, error: `capture threw: ${err.message}`, pageErrors };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Mirrors e2e/support/workbench.ts's connectionBadge(): the badge is the
// role="status" element whose whole text is one of the connection labels.
async function waitForSettledStatus(page, timeoutMs) {
  const badge = page
    .getByRole('status')
    .filter({ hasText: /^(Not connected|Connecting…|Connected|Reconnecting…|Error)$/ });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = (await badge.first().textContent().catch(() => ''))?.trim();
    if (text && text !== 'Connecting…' && text !== 'Not connected') return text;
    await page.waitForTimeout(200);
  }
  return 'timeout';
}

// Rewrites a mono 16-bit 16kHz PCM WAV with leading/trailing silence. Plain
// buffer math, no audio library: the header layout is fixed by the recorder
// (recorder.html's encodeWav) and checked here.
function padClip(srcPath, dstPath) {
  const wav = readFileSync(srcPath);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${srcPath} is not a WAV file`);
  }
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);
  if (channels !== 1 || sampleRate !== SAMPLE_RATE || bitsPerSample !== 16) {
    throw new Error(`${srcPath}: expected mono 16-bit ${SAMPLE_RATE}Hz, got ${channels}ch ${bitsPerSample}-bit ${sampleRate}Hz`);
  }
  // Locate the data chunk rather than assuming offset 44.
  let offset = 12;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      dataStart = offset + 8;
      dataSize = Math.min(chunkSize, wav.length - dataStart);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataStart < 0) throw new Error(`${srcPath}: no data chunk`);

  const bytesPerSecond = SAMPLE_RATE * 2;
  const lead = Buffer.alloc(LEAD_SILENCE_S * bytesPerSecond);
  const tail = Buffer.alloc(TAIL_SILENCE_S * bytesPerSecond);
  const data = wav.subarray(dataStart, dataStart + dataSize);
  const newDataSize = lead.length + data.length + tail.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + newDataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(bytesPerSecond, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(newDataSize, 40);

  writeFileSync(dstPath, Buffer.concat([header, lead, data, tail]));
  return { paddedPath: dstPath, clipDurationS: data.length / bytesPerSecond };
}

function writeCaptures(items) {
  writeFileSync(
    CAPTURES_PATH,
    JSON.stringify({ baseUrl: BASE_URL, leadSilenceS: LEAD_SILENCE_S, items }, null, 2) + '\n',
  );
}

async function assertServersUp() {
  try {
    const res = await fetch(`${BASE_URL}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new UsageError(
      `frontend dev server not reachable at ${BASE_URL} (${err.message}). Start both servers with .\\dev.ps1 from the repo root.`,
    );
  }
  // Probes this app's own session-mint route rather than /health: an
  // unrelated server on the same port can (and, on this machine, does)
  // answer /health with a plausible 200, and every session would then fail
  // to mint a token. An unsupported language code is rejected with a
  // specific 400 before the backend ever calls OpenAI, so this is free.
  try {
    const res = await fetch(`${BACKEND_URL}/api/realtime/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceLanguage: 'zz', targetLanguage: 'es' }),
    });
    const body = await res.json().catch(() => null);
    if (res.status !== 400 || !String(body?.detail ?? '').includes('Unsupported language code')) {
      throw new Error(`HTTP ${res.status}, body ${JSON.stringify(body)}`);
    }
  } catch (err) {
    throw new UsageError(
      `this project's backend is not what answers ${BACKEND_URL} (${err.message}). ` +
        'Start it with .\\dev.ps1, or set BACKEND_URL (and BASE_URL) to where it actually runs.',
    );
  }
}

function parseArgs(argv) {
  const out = { only: null, limit: 0, headed: false, manifest: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--headed') out.headed = true;
    else if (a === '--manifest') out.manifest = path.resolve(argv[++i]);
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else {
      // Runs at module top-level before anything async is open, so a direct
      // exit is safe here (unlike inside main(), see the bottom of the file).
      console.error(`Unknown argument ${a}`);
      process.exit(2);
    }
  }
  return out;
}

// Exit code via process.exitCode rather than process.exit(): the latter can
// trip a libuv assertion on Windows when a fetch handle is still closing.
try {
  await main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
