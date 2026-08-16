import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

export const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(DEMO_DIR, '..');
export const OUT_DIR = path.join(DEMO_DIR, 'out');

/** KEY=value lines from backend/.env (comments and blanks skipped). */
export function readBackendEnv() {
  const file = path.join(REPO_ROOT, 'backend', '.env');
  const env = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * ffmpeg: FFMPEG env var, else `ffmpeg` on PATH, else the `ffmpeg-static`
 * package if it is installed anywhere up the tree from here.
 */
export function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const onPath = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (onPath.status === 0) return 'ffmpeg';
  for (const dir of [DEMO_DIR, REPO_ROOT, path.join(REPO_ROOT, 'frontend'), ...(process.env.FFMPEG_STATIC_DIR ? [process.env.FFMPEG_STATIC_DIR] : [])]) {
    const candidate = path.join(dir, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('ffmpeg not found: set FFMPEG=<path>, put ffmpeg on PATH, or `npm i ffmpeg-static` in demo/');
}

/** Media duration in seconds, parsed from `ffmpeg -i` (no ffprobe needed). */
export function probeDuration(file) {
  const res = spawnSync(ffmpegPath(), ['-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const text = `${res.stderr}\n${res.stdout}`;
  // The last `time=HH:MM:SS.xx` on the progress line is the decoded length,
  // which for webm (whose header duration can be missing) is the honest one.
  const times = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (times.length) {
    const [, h, m, s] = times[times.length - 1];
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  const m = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`could not read duration of ${file}:\n${text.slice(-500)}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}
