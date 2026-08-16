// Turns demo/out/{video,audio,narration,timeline.json} into one MP4:
//
//   video   scenes concatenated in narration.mjs order, re-encoded to H.264
//   audio   every narration line placed at the moment its step began, mixed
//           over the app's own audio (mic clips + translated speech), which
//           is ducked while the narrator speaks
//   subs    a soft mov_text track carrying the narration, one cue per line
//
//   node demo/assemble.mjs [--out demo/out/ai-interpreter-workbench-demo.mp4]
//        [--app-gain 0.5] [--nar-gain 2.0] [--duck 0.35]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT_DIR, ffmpegPath, probeDuration, run } from './common.mjs';

// Must match record.mjs's VIEWPORT.
const [W, H] = [1440, 900];

const args = parseArgs(process.argv.slice(2));
const timeline = JSON.parse(readFileSync(path.join(OUT_DIR, 'timeline.json'), 'utf8'));
const narration = Object.fromEntries(
  JSON.parse(readFileSync(path.join(OUT_DIR, 'narration', 'index.json'), 'utf8')).map((l) => [l.id, l]),
);

const scenes = timeline.order.map((id) => timeline.scenes[id]).filter(Boolean);
if (scenes.length === 0) throw new Error('timeline.json has no scenes; run node demo/record.mjs first');

// Scene offsets on the final timeline come from the *actual* video lengths,
// not the wall-clock the recorder measured, so concatenation and audio agree.
let cursor = 0;
const placed = [];
for (const scene of scenes) {
  const videoFile = path.join(OUT_DIR, scene.videoFile);
  const durationS = probeDuration(videoFile);
  placed.push({ ...scene, videoFile, offsetS: cursor, videoDurationS: durationS });
  cursor += durationS;
}
const totalS = cursor;

// ---- inputs & filter graph -------------------------------------------------
const inputs = [];
const filters = [];
const addInput = (file, extra = []) => {
  inputs.push(...extra, '-i', file);
  return inputs.filter((a) => a === '-i').length - 1;
};

// Video: one input per scene, scaled to a common size and concatenated.
const videoIdx = placed.map((s) => addInput(s.videoFile));
const vLabels = videoIdx.map((idx, i) => {
  filters.push(`[${idx}:v]fps=30,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);
  return `[v${i}]`;
});
filters.push(`${vLabels.join('')}concat=n=${vLabels.length}:v=1:a=0[vout]`);

// App audio: each scene's tap, delayed to its scene offset + in-scene offset.
const appLabels = [];
placed.forEach((s, i) => {
  if (!s.audioFile || !existsSync(path.join(OUT_DIR, s.audioFile))) return;
  const idx = addInput(path.join(OUT_DIR, s.audioFile));
  const delayMs = Math.max(0, Math.round((s.offsetS + (s.audioOffsetS ?? 0)) * 1000));
  // Trim to the scene so a tap that ran a hair long never bleeds into the next scene.
  filters.push(`[${idx}:a]aresample=48000,atrim=0:${s.videoDurationS.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},volume=${args.appGain}[app${i}]`);
  appLabels.push(`[app${i}]`);
});

// Narration: every line at its recorded moment.
const narLabels = [];
const cues = [];
placed.forEach((s) => {
  for (const step of s.steps) {
    const line = narration[step.id];
    if (!line) continue;
    const file = path.join(OUT_DIR, 'narration', `${step.id}.mp3`);
    const idx = addInput(file);
    const startS = s.offsetS + step.startS;
    const delayMs = Math.round(startS * 1000);
    filters.push(`[${idx}:a]aresample=48000,volume=${args.narGain},adelay=${delayMs}|${delayMs}[nar${narLabels.length}]`);
    narLabels.push(`[nar${narLabels.length}]`);
    cues.push({ startS, endS: startS + line.durationS, text: line.text });
  }
});

filters.push(`${narLabels.join('')}amix=inputs=${narLabels.length}:duration=longest:normalize=0[narmix]`);
if (appLabels.length) {
  filters.push(`${appLabels.join('')}amix=inputs=${appLabels.length}:duration=longest:normalize=0[appmix]`);
  // Duck the app audio under the narrator: sidechaincompress needs the
  // narration twice (once as sidechain, once to hear), hence asplit.
  filters.push(`[narmix]asplit=2[narA][narB]`);
  // The narrator sits ~24 dB above the -34 dBFS threshold, so pick the ratio
  // that turns that overshoot into `duck` (a linear gain, 0.35 ≈ -9 dB).
  const duckDb = -20 * Math.log10(args.duck);
  const ratio = 1 / (1 - duckDb / 24);
  filters.push(`[appmix][narA]sidechaincompress=threshold=0.02:ratio=${ratio.toFixed(2)}:attack=40:release=500:makeup=1[ducked]`);
  filters.push(`[ducked][narB]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[aout]`);
} else {
  filters.push(`[narmix]alimiter=limit=0.95[aout]`);
}

// Subtitles (soft track).
const srtPath = path.join(OUT_DIR, 'narration.srt');
writeFileSync(srtPath, toSrt(cues));
const srtIdx = addInput(srtPath);

const outFile = args.out;
const ffArgs = [
  '-y',
  '-hide_banner',
  '-loglevel', 'warning',
  '-stats',
  ...inputs,
  '-filter_complex', filters.join(';\n'),
  '-map', '[vout]',
  '-map', '[aout]',
  '-map', `${srtIdx}:s`,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
  '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
  '-metadata', 'title=AI Interpreter Workbench demo',
  '-t', totalS.toFixed(3),
  '-movflags', '+faststart',
  outFile,
];
writeFileSync(path.join(OUT_DIR, 'ffmpeg-args.json'), JSON.stringify(ffArgs, null, 2));
console.log(`Assembling ${placed.length} scenes, ${totalS.toFixed(1)}s, ${narLabels.length} narration lines, ${appLabels.length} app-audio tracks`);
run(ffmpegPath(), ffArgs);
console.log(`\nWrote ${outFile} (${probeDuration(outFile).toFixed(1)}s)`);

function toSrt(cues) {
  const ts = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.startS)} --> ${ts(c.endS)}\n${wrap(c.text)}\n`).join('\n') + '\n';
}

function wrap(text, width = 70) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { lines.push(line.trim()); line = w; } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}

function parseArgs(argv) {
  // Defaults measured on the first full render: the ElevenLabs narration
  // peaks around -10 dBFS while the mic clips peak near 0 dBFS, so the
  // narrator comes up 6 dB and the app comes down 6 dB before ducking.
  const out = { out: path.join(OUT_DIR, 'ai-interpreter-workbench-demo.mp4'), appGain: 0.5, narGain: 2.0, duck: 0.35 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--app-gain') out.appGain = Number(argv[++i]);
    else if (argv[i] === '--nar-gain') out.narGain = Number(argv[++i]);
    else if (argv[i] === '--duck') out.duck = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}
