// Renders every narration line in narration.mjs to out/narration/<id>.mp3 with
// ElevenLabs, using ELEVENLABS_VOICE_ID_VIDEO from backend/.env, and writes
// out/narration/index.json with each line's measured duration.
//
// Lines whose text is unchanged since the last render are skipped (unless
// --force), so a script tweak only re-renders the lines it touched.
//
//   node demo/tts.mjs [--force] [--only id1,id2]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ALL_STEPS } from './narration.mjs';
import { DEMO_DIR, probeDuration, readBackendEnv } from './common.mjs';

const OUT_DIR = path.join(DEMO_DIR, 'out', 'narration');
const MODEL_ID = 'eleven_multilingual_v2';

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;

const env = readBackendEnv();
const apiKey = env.ELEVENLABS_API_KEY;
const voiceId = env.ELEVENLABS_VOICE_ID_VIDEO;
if (!apiKey) throw new Error('ELEVENLABS_API_KEY missing from backend/.env');
if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID_VIDEO missing from backend/.env');

mkdirSync(OUT_DIR, { recursive: true });

// What each line said when it was last rendered, so an edited line re-renders
// without --force while untouched ones are left alone.
const indexPath = path.join(OUT_DIR, 'index.json');
const previousText = new Map(
  existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')).map((l) => [l.id, l.text]) : [],
);

const index = [];
for (const step of ALL_STEPS) {
  const file = path.join(OUT_DIR, `${step.id}.mp3`);
  const wanted = only ? only.has(step.id) : true;
  const stale = !existsSync(file) || previousText.get(step.id) !== step.text;
  if (wanted && (force || stale)) {
    process.stdout.write(`rendering ${step.id} … `);
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: step.text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status} for ${step.id}: ${await res.text()}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log('ok');
  }
  const durationS = existsSync(file) ? probeDuration(file) : null;
  index.push({ id: step.id, scene: step.scene, file: path.relative(DEMO_DIR, file), durationS, text: step.text });
}
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
const total = index.reduce((s, i) => s + (i.durationS ?? 0), 0);
console.log(`\n${index.length} lines, ${total.toFixed(1)}s of narration -> ${path.relative(process.cwd(), OUT_DIR)}`);
for (const i of index) console.log(`  ${i.id.padEnd(12)} ${i.durationS?.toFixed(1).padStart(5)}s`);
