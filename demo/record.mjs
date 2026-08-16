// Records the demo, one browser launch per scene in narration.mjs.
//
// Each scene drives the real app (both dev servers must be up, real keys in
// backend/.env) with Chromium's fake microphone playing recorded clips from
// backend/tests/fixtures/realtime_quality/, so the transcripts and the
// translated speech in the video are the real thing, not mock-ups. Video is
// Playwright's own screencast; the app's audio (what the fake mic hears plus
// everything the page plays back — ElevenLabs TTS in Cascade, the remote
// WebRTC track in Realtime) is captured in-page by tapping Web Audio and
// MediaRecorder, see TAP_INIT below.
//
// Output (all under demo/out/):
//   video/<scene>.webm      screencast of that scene
//   audio/<scene>.webm      what the page heard and played, opus
//   mic/<scene>.wav         the fake-mic file that scene was launched with
//   timeline.json           per scene: video/audio files, audio offset,
//                           and the moment each narration step began
//
//   node demo/record.mjs [--scene cascade,tuning] [--headed]
// Env: BASE_URL (default http://localhost:5173), BACKEND_URL (default
//   http://localhost:8002 — see assertServersUp for why not 8000).

import { chromium } from '../frontend/node_modules/playwright/index.mjs';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCENES } from './narration.mjs';
import { OUT_DIR, REPO_ROOT } from './common.mjs';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8002';
const CORPUS_DIR = path.join(REPO_ROOT, 'backend/tests/fixtures/realtime_quality');
// 16:10 and tall enough that the Tuning panel (header + 560px section box +
// Apply footer) fits under the navbar without scrolling the page.
const VIEWPORT = { width: 1440, height: 900 };
const SAMPLE_RATE = 16000;
// Breathing room after each narration line before the next action fires.
const STEP_PAD_MS = 900;
const CONNECT_TIMEOUT_MS = 25_000;

const args = parseArgs(process.argv.slice(2));
const narration = loadNarrationIndex();

const TAP_INIT = `
(() => {
  const state = { ctx: null, dest: null, recorder: null, chunks: [], startedAt: null, sources: [] };
  function master() {
    if (state.ctx) return state;
    const ctx = new AudioContext({ sampleRate: 48000 });
    const dest = ctx.createMediaStreamDestination();
    // A silent constant source keeps the graph rendering so the recorder is
    // fed continuously from t=0, not only once the app makes a sound.
    const keep = ctx.createConstantSource(); keep.offset.value = 0; keep.connect(dest); keep.start();
    const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
    recorder.start(500);
    state.startedAt = Date.now();
    Object.assign(state, { ctx, dest, recorder });
    ctx.resume();
    return state;
  }
  function addStream(stream, label) {
    try {
      if (!stream || !stream.getAudioTracks || stream.getAudioTracks().length === 0) return;
      const m = master();
      m.ctx.createMediaStreamSource(stream).connect(m.dest);
      state.sources.push(label);
    } catch (e) { console.warn('[demo-tap] addStream failed', e); }
  }
  // 1) Anything the app connects to an AudioContext's destination (Cascade's
  //    gapless TTS player) is also routed into the recorder.
  const origConnect = AudioNode.prototype.connect;
  const taps = new WeakMap();
  AudioNode.prototype.connect = function (target, ...rest) {
    const result = origConnect.call(this, target, ...rest);
    try {
      if (target instanceof AudioDestinationNode && this.context !== state.ctx) {
        let tap = taps.get(this.context);
        if (!tap) {
          tap = this.context.createMediaStreamDestination();
          taps.set(this.context, tap);
          addStream(tap.stream, 'ctx@' + this.context.sampleRate);
        }
        origConnect.call(this, tap);
      }
    } catch (e) { console.warn('[demo-tap] connect hook failed', e); }
    return result;
  };
  // 2) A media element handed a MediaStream (Realtime's remote audio track).
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); if (v instanceof MediaStream) addStream(v, 'media-element'); },
    configurable: true,
  });
  // 3) The microphone itself, i.e. the fake device playing the demo clips.
  const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { const s = await origGUM(c); addStream(s, 'mic'); return s; };
  window.__demoTap = {
    start() { const m = master(); return { startedAt: m.startedAt, state: m.ctx.state }; },
    async stop() {
      const m = master();
      const t0 = Date.now();
      const stopped = new Promise((resolve) => { m.recorder.onstop = resolve; });
      m.recorder.stop();
      // onstop has been seen to lag badly with a live WebRTC track attached;
      // whatever chunks are in hand after a short grace period are enough.
      await Promise.race([stopped, new Promise((r) => setTimeout(r, 3000))]);
      console.log('[demo-tap] stop took ' + (Date.now() - t0) + 'ms, ' + state.chunks.length + ' chunks');
      const bytes = new Uint8Array(await new Blob(state.chunks, { type: 'audio/webm' }).arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { startedAt: state.startedAt, base64: btoa(bin), sources: state.sources, ctxState: m.ctx.state };
    },
  };
})();
`;

const SPOT_CSS = `
.demo-spot { outline: 3px solid #f59e0b !important; outline-offset: 4px; border-radius: 10px;
  box-shadow: 0 0 0 8px rgba(245,158,11,.22) !important; transition: box-shadow .25s ease, outline-color .25s ease; }
`;

async function main() {
  await assertServersUp();
  for (const dir of ['video', 'video-raw', 'audio', 'mic']) mkdirSync(path.join(OUT_DIR, dir), { recursive: true });

  const timelinePath = path.join(OUT_DIR, 'timeline.json');
  const timeline = existsSync(timelinePath) ? JSON.parse(readFileSync(timelinePath, 'utf8')) : { scenes: {} };
  const scenes = SCENES.filter((s) => !args.scenes || args.scenes.includes(s.id));
  for (const scene of scenes) {
    console.log(`\n=== scene ${scene.id} (${scene.steps.length} steps)`);
    const result = await recordScene(scene);
    timeline.scenes[scene.id] = result;
    timeline.order = SCENES.map((s) => s.id);
    // Written after every scene so a crash keeps what's done.
    writeFileSync(timelinePath, JSON.stringify(timeline, null, 2) + '\n');
    console.log(`    -> ${result.videoFile} (${result.durationS.toFixed(1)}s), audio sources: ${result.audioSources.join(', ') || 'none'}`);
  }
  console.log(`\nWrote ${timelinePath}. Next: node demo/assemble.mjs`);
}

async function recordScene(scene) {
  const launchArgs = ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  let micFile = null;
  if (scene.mic) {
    micFile = buildMicFile(scene);
    launchArgs.push(`--use-file-for-fake-audio-capture=${micFile}%noloop`);
  } else {
    // A silent mic keeps getUserMedia() honest in scenes that never connect.
    micFile = buildSilence(scene.id, 60);
    launchArgs.push(`--use-file-for-fake-audio-capture=${micFile}%noloop`);
  }
  const browser = await chromium.launch({ headless: !args.headed, args: launchArgs });
  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: path.join(OUT_DIR, 'video-raw'), size: VIEWPORT },
  });
  await context.addInitScript(TAP_INIT);
  const videoStartMs = Date.now();
  const page = await context.newPage();
  // A selector that misses must cost seconds, not the scene's timing.
  page.setDefaultTimeout(4000);
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => {
    if (m.text().startsWith('[demo-tap]')) console.log('    ' + m.text());
  });

  const steps = [];
  let tap = null;
  try {
    await page.goto(BASE_URL);
    await page.addStyleTag({ content: SPOT_CSS });
    const started = await page.evaluate(() => window.__demoTap.start());
    console.log(`    audio tap started (${started.state}), ${started.startedAt - videoStartMs}ms after video`);
    if (scene.mode === 'realtime') await page.getByRole('tab', { name: 'Realtime' }).click();
    await waitForFingerprint(page);

    const h = helpers(page);
    for (const step of scene.steps) {
      const line = step.hold ? null : narration[step.id];
      if (!step.hold && !line) throw new Error(`no narration audio for ${step.id}; run node demo/tts.mjs first`);
      const durationS = step.hold ?? line.durationS;
      const stepStart = Date.now();
      process.stdout.write(`    ${step.id.padEnd(18)} (${durationS.toFixed(1)}s${step.hold ? ', silent' : ''}) … `);
      steps.push({ id: step.id, startS: (stepStart - videoStartMs) / 1000, durationS, narrated: !step.hold });
      const action = ACTIONS[step.id];
      if (action) {
        try {
          await action(h, page);
        } catch (err) {
          console.log(`(action failed: ${err.message.split('\n')[0]}) `);
        }
      }
      const holdUntil = stepStart + durationS * 1000 + (step.hold ? 0 : STEP_PAD_MS);
      const remaining = holdUntil - Date.now();
      if (remaining > 0) await page.waitForTimeout(remaining);
      console.log('done');
    }
    await h.spot(null);
    await page.waitForTimeout(600);
  } finally {
    const stepsEndMs = Date.now();
    try {
      tap = await page.evaluate(() => window.__demoTap.stop());
    } catch (err) {
      console.log(`    (audio tap unavailable: ${err.message})`);
    }
    const videoEndMs = Date.now();
    if (videoEndMs - stepsEndMs > 2000) console.log(`    (tap stop took ${videoEndMs - stepsEndMs}ms)`);
    const rawPath = await page.video()?.path();
    await context.close();
    await browser.close().catch(() => {});
    var durationS = (videoEndMs - videoStartMs) / 1000;
    var videoFile = path.join(OUT_DIR, 'video', `${scene.id}.webm`);
    if (rawPath && existsSync(rawPath)) {
      if (existsSync(videoFile)) renameSync(videoFile, `${videoFile}.old`);
      renameSync(rawPath, videoFile);
    }
  }
  let audioFile = null;
  let audioOffsetS = null;
  if (tap?.base64) {
    audioFile = path.join(OUT_DIR, 'audio', `${scene.id}.webm`);
    writeFileSync(audioFile, Buffer.from(tap.base64, 'base64'));
    audioOffsetS = (tap.startedAt - videoStartMs) / 1000;
  }
  return {
    id: scene.id,
    videoFile: path.relative(OUT_DIR, videoFile),
    audioFile: audioFile ? path.relative(OUT_DIR, audioFile) : null,
    audioOffsetS,
    audioSources: tap?.sources ?? [],
    micFile: micFile ? path.relative(OUT_DIR, micFile) : null,
    durationS,
    steps,
    pageErrors: consoleErrors,
  };
}

// What the page does at the start of each narration line. Everything else
// is the app itself reacting to the fake mic.
const ACTIONS = {
  'intro-1': async (h) => h.spot(null),
  'intro-2': async (h, page) => {
    await h.spot('[role=tab]:has-text("Cascade")');
    await page.waitForTimeout(8000);
    await h.spot('[role=tab]:has-text("Realtime")');
  },

  'cascade-1': async (h, page) => {
    await h.spot('select[aria-label="Language pair"]');
    await page.waitForTimeout(2000);
    await h.spot('button[aria-label="Connect microphone"]');
    await page.getByRole('button', { name: 'Connect microphone' }).click();
    const status = await waitForSettledStatus(page, CONNECT_TIMEOUT_MS);
    if (status !== 'Connected') console.log(`(status ${status}) `);
    await h.spot(null);
  },
  'cascade-listen-1': async (h) => h.spot(null),
  'cascade-2': async (h, page) => {
    await h.spot('[data-testid=source-transcript]');
    await page.waitForTimeout(6000);
    await h.spot('[data-testid=target-transcript]');
    await page.waitForTimeout(5000);
    await h.spot(null);
  },
  'cascade-listen-2': async (h) => h.spot(null),
  'cascade-3': async (h, page) => {
    await page.waitForTimeout(1500);
    await h.spot('[data-testid=source-transcript]');
    await page.waitForTimeout(4000);
    await h.spot(null);
  },
  'cascade-listen-3': async (h) => h.spot(null),
  'cascade-4': async (h, page) => {
    await h.spot('[data-testid=cascade-latency-strip]');
    await page.waitForTimeout(11000);
    await h.spot('[data-testid=tuning-fingerprint-latency]');
  },

  'realtime-1': async (h, page) => {
    await h.spot('[role=tab]:has-text("Realtime")');
    await page.waitForTimeout(800);
    await h.spot('button[aria-label="Connect microphone"]');
    await page.getByRole('button', { name: 'Connect microphone' }).click();
    const status = await waitForSettledStatus(page, CONNECT_TIMEOUT_MS);
    if (status !== 'Connected') console.log(`(status ${status}) `);
    await h.spot(null);
  },
  'realtime-listen-1': async (h) => h.spot(null),
  'realtime-2': async (h, page) => {
    await page.waitForTimeout(1000);
    await h.spot('[data-testid=realtime-latency-badge]');
    await page.waitForTimeout(6000);
    await h.spot('[data-testid=source-transcript]');
    await page.waitForTimeout(3500);
    await h.spot(null);
  },
  'realtime-listen-2': async (h) => h.spot(null),
  'realtime-3': async (h, page) => {
    await h.spot(null);
    await page.getByTestId('tuning-toggle').click();
    await page.waitForTimeout(800);
    await h.reveal('[data-testid=tuning-section-turn]');
    await h.spot('[data-testid=tuning-section-turn]');
    await page.waitForTimeout(5000);
    await h.spot('[data-testid=tuning-vad-silence-duration]');
  },
  'realtime-4': async (h, page) => {
    await h.reveal('[data-testid=tuning-openai-noise-reduction-near]');
    await h.spot('[data-testid=tuning-openai-noise-reduction-near]', 'closest-card');
    await page.waitForTimeout(800);
    // The segmented control is disabled while "Provider default" is ticked.
    await page.getByTestId('tuning-openai-noise-reduction-default').uncheck().catch(() => {});
    await page.waitForTimeout(500);
    await page.getByTestId('tuning-openai-noise-reduction-near').click().catch(() => {});
    await page.waitForTimeout(1200);
    await h.spot('[data-testid=tuning-apply]');
    await page.waitForTimeout(500);
    await page.getByTestId('tuning-apply').click().catch(() => {});
    await page.waitForTimeout(1500);
    await h.spot('[data-testid=tuning-fingerprint]');
  },

  'tuning-1': async (h, page) => {
    // Connect first so the panel is demonstrated against a live session.
    await page.getByRole('button', { name: 'Connect microphone' }).click();
    const status = await waitForSettledStatus(page, CONNECT_TIMEOUT_MS);
    if (status !== 'Connected') console.log(`(status ${status}) `);
    await h.spot('[data-testid=tuning-toggle]');
    await page.waitForTimeout(1000);
    await page.getByTestId('tuning-toggle').click();
    await page.waitForTimeout(600);
    await h.spot('[data-testid=tuning-sections]');
  },
  'tuning-2': async (h) => {
    await h.reveal('[data-testid=tuning-section-microphone]');
    await h.spot('[data-testid=tuning-section-microphone]');
  },
  'tuning-3': async (h, page) => {
    await h.reveal('[data-testid=tuning-rms-enabled]');
    await h.spot('[data-testid=tuning-rms-enabled]', 'closest-card');
    await page.waitForTimeout(2000);
    await page.getByTestId('tuning-rms-enabled').click().catch(() => {});
    await page.waitForTimeout(3000);
    await h.reveal('[data-testid=tuning-rms-threshold]');
    await h.spot('[data-testid=tuning-rms-threshold]');
    await h.slide('tuning-rms-threshold', '-38');
  },
  'tuning-4': async (h, page) => {
    await h.reveal('[data-testid=tuning-rnnoise-enabled]');
    await h.spot('[data-testid=tuning-rnnoise-enabled]', 'closest-card');
    await page.waitForTimeout(2500);
    await page.getByTestId('tuning-rnnoise-enabled').click().catch(() => {});
  },
  'tuning-5': async (h, page) => {
    await h.reveal('[data-testid=tuning-dfn-enabled]');
    await h.spot('[data-testid=tuning-dfn-enabled]', 'closest-card');
    await page.waitForTimeout(4500);
    await h.reveal('[data-testid=tuning-noisereduce-enabled]');
    await h.spot('[data-testid=tuning-noisereduce-enabled]', 'closest-card');
  },
  'tuning-6': async (h, page) => {
    await h.reveal('[data-testid=tuning-section-turn]');
    await h.spot('[data-testid=tuning-section-turn]');
    await page.waitForTimeout(4000);
    await h.spot('[data-testid=tuning-dg-endpointing]');
  },
  'tuning-7': async (h, page) => {
    await h.open('[data-testid=tuning-section-segmentation]');
    await h.reveal('[data-testid=tuning-section-segmentation]');
    await h.spot('[data-testid=tuning-section-segmentation]');
    await page.waitForTimeout(4000);
    await h.reveal('[data-testid=tuning-section-transcript-check]');
    await h.spot('[data-testid=tuning-section-transcript-check]');
    await page.waitForTimeout(1500);
    await page.getByTestId('tuning-transcript-check-flag').click().catch(() => {});
  },
  'tuning-8': async (h, page) => {
    await h.open('[data-testid=tuning-section-models]');
    await h.reveal('[data-testid=tuning-section-models]');
    await h.spot('[data-testid=tuning-section-models]');
    await page.waitForTimeout(3500);
    await h.spot('[data-testid=tuning-voice-b]');
  },
  'tuning-9': async (h, page) => {
    await h.spot('[data-testid=tuning-apply]');
    await page.waitForTimeout(6500);
    await h.spot('[data-testid=tuning-preset]');
    await page.waitForTimeout(1000);
    await page.getByTestId('tuning-preset').selectOption({ label: 'Max denoise' }).catch((e) => console.log(`(preset: ${e.message}) `));
    await page.waitForTimeout(1500);
    await h.spot('[data-testid=tuning-apply]');
    await page.waitForTimeout(800);
    await page.getByTestId('tuning-apply').click().catch(() => {});
  },
  'tuning-10': async (h, page) => {
    await h.spot('[data-testid=tuning-fingerprint]');
    await page.waitForTimeout(8000);
    await h.spot('[data-testid=tuning-export]');
    await page.waitForTimeout(800);
    const download = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await page.getByTestId('tuning-export').click().catch(() => {});
    const file = await download;
    if (file) await file.saveAs(path.join(OUT_DIR, 'exported-tuning-config.json')).catch(() => {});
  },

  'outro-1': async (h) => h.spot(null),
};

function helpers(page) {
  return {
    /** Highlight one element (CSS selector) or clear with null. `closest-card` walks up to the stage card. */
    spot: async (selector, mode) => {
      await page.evaluate(() => document.querySelectorAll('.demo-spot').forEach((el) => el.classList.remove('demo-spot')));
      if (!selector) return;
      await page
        .locator(selector)
        .first()
        .evaluate((el, mode) => {
          if (mode === 'closest-card') el = el.closest('.rounded-box') ?? el;
          el.classList.add('demo-spot');
        }, mode)
        .catch((err) => console.log(`(spot ${selector}: ${err.message.split('\n')[0]}) `));
    },
    /**
     * Smooth-scroll an element to the middle of its nearest scrollable
     * ancestor (the Tuning panel's section box) without moving the page
     * itself, so the navbar and transcripts stay on screen while the panel
     * scrolls.
     */
    reveal: async (selector) => {
      await page
        .locator(selector)
        .first()
        .evaluate((el) => {
          let box = el.parentElement;
          while (box && !(getComputedStyle(box).overflowY.match(/auto|scroll/) && box.scrollHeight > box.clientHeight)) {
            box = box.parentElement;
          }
          if (!box) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
          const elRect = el.getBoundingClientRect();
          const boxRect = box.getBoundingClientRect();
          const target = box.scrollTop + (elRect.top - boxRect.top) - (box.clientHeight - elRect.height) / 2;
          box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
        })
        .catch((err) => console.log(`(reveal ${selector}: ${err.message.split('\n')[0]}) `));
      await page.waitForTimeout(700);
    },
    /** Open a closed <details> section by clicking its summary. */
    open: async (selector) => {
      const isOpen = await page
        .locator(selector)
        .first()
        .evaluate((el) => el.open ?? true)
        .catch(() => true);
      if (!isOpen) {
        await page.locator(`${selector} > summary`).click();
        await page.waitForTimeout(400);
      }
    },
    /** Move a range/number knob to a value the way React sees it (fires input+change). */
    slide: async (testId, value) => {
      await page
        .getByTestId(testId)
        .evaluate((el, value) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, value)
        .catch(() => {});
    },
  };
}

// Mirrors the e2e helpers: the connection badge is the role="status" element
// whose whole text is one of the connection labels.
async function waitForSettledStatus(page, timeoutMs) {
  const badge = page.getByRole('status').filter({ hasText: /^(Not connected|Connecting…|Connected|Reconnecting…|Error)$/ });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = (await badge.first().textContent().catch(() => ''))?.trim();
    if (text && text !== 'Connecting…' && text !== 'Not connected') return text;
    await page.waitForTimeout(200);
  }
  return 'timeout';
}

async function waitForFingerprint(page) {
  const chip = page.getByTestId('tuning-fingerprint');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const text = (await chip.first().textContent().catch(() => ''))?.trim();
    if (text && /^cfg:[0-9a-f]{8}$/.test(text)) return text;
    await page.waitForTimeout(200);
  }
  throw new Error('the tuning fingerprint chip never settled — is the backend reachable from the frontend?');
}

/**
 * One 16 kHz mono WAV: lead "silence", then each clip separated by gapS,
 * then tail "silence". The quiet parts are a real mic's noise floor (about
 * -60 dBFS of white noise), not digital zeros, and each clip gets a short
 * fade in/out: a hard cut from speech to absolute zero is a discontinuity no
 * microphone produces, and server-side VAD/transcription has been seen to
 * turn exactly that edge into a phantom "utterance".
 */
function buildMicFile(scene) {
  const { clips, leadS, gapS, tailS } = scene.mic;
  const parts = [roomTone(leadS)];
  clips.forEach((id, i) => {
    parts.push(faded(pcmData(path.join(CORPUS_DIR, `${id}.wav`))));
    parts.push(roomTone(i === clips.length - 1 ? tailS : gapS));
  });
  const out = path.join(OUT_DIR, 'mic', `${scene.id}.wav`);
  writeFileSync(out, wavFile(Buffer.concat(parts)));
  return out;
}

function roomTone(seconds, amplitude = 30 /* ≈ -60 dBFS on the 16-bit scale */) {
  const buf = Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * 2);
  // Deterministic LCG so the same scene always gets byte-identical audio.
  let seed = 0x2545f491;
  for (let i = 0; i < buf.length; i += 2) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    buf.writeInt16LE(Math.round(((seed / 0xffffffff) * 2 - 1) * amplitude), i);
  }
  return buf;
}

function faded(pcm, fadeMs = 25) {
  const out = Buffer.from(pcm);
  const n = Math.min(Math.round((fadeMs / 1000) * SAMPLE_RATE), Math.floor(out.length / 4));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    out.writeInt16LE(Math.round(out.readInt16LE(i * 2) * g), i * 2);
    const j = out.length / 2 - 1 - i;
    out.writeInt16LE(Math.round(out.readInt16LE(j * 2) * g), j * 2);
  }
  return out;
}

function buildSilence(sceneId, seconds) {
  const out = path.join(OUT_DIR, 'mic', `${sceneId}-silence.wav`);
  writeFileSync(out, wavFile(Buffer.alloc(seconds * SAMPLE_RATE * 2)));
  return out;
}

function pcmData(file) {
  const wav = readFileSync(file);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file} is not a WAV file`);
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  if (channels !== 1 || sampleRate !== SAMPLE_RATE || bits !== 16) {
    throw new Error(`${file}: expected mono 16-bit ${SAMPLE_RATE}Hz, got ${channels}ch ${bits}-bit ${sampleRate}Hz`);
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return wav.subarray(offset + 8, offset + 8 + Math.min(size, wav.length - offset - 8));
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

function wavFile(data) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function loadNarrationIndex() {
  const file = path.join(OUT_DIR, 'narration', 'index.json');
  if (!existsSync(file)) throw new Error(`${file} missing — run node demo/tts.mjs first`);
  return Object.fromEntries(JSON.parse(readFileSync(file, 'utf8')).map((line) => [line.id, line]));
}

async function assertServersUp() {
  const res = await fetch(`${BASE_URL}/`).catch((err) => ({ ok: false, statusText: err.message }));
  if (!res.ok) throw new Error(`frontend not reachable at ${BASE_URL} (${res.statusText}). Start both servers with .\\dev.ps1.`);
  // The realtime session route rejects an unknown language with a specific
  // 400 before touching OpenAI, which is a free "is this our backend" probe
  // (another server on this machine answers /health on 8000 with a 200).
  const probe = await fetch(`${BACKEND_URL}/api/realtime/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceLanguage: 'zz', targetLanguage: 'es' }),
  }).catch((err) => ({ status: 0, json: async () => ({ detail: err.message }) }));
  const body = await probe.json().catch(() => null);
  if (probe.status !== 400 || !String(body?.detail ?? '').includes('Unsupported language code')) {
    throw new Error(`this project's backend is not what answers ${BACKEND_URL} (HTTP ${probe.status}, ${JSON.stringify(body)}); set BACKEND_URL.`);
  }
}

function parseArgs(argv) {
  const out = { scenes: null, headed: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scene') out.scenes = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--headed') out.headed = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

await main();
