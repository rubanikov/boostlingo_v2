/**
 * Presets and localStorage for the tuning panel (ticket 03).
 *
 * PURE apart from `window.localStorage` — no React, no fetch. There is
 * deliberately **no server-side storage of any config** (story AC 1.8, locked
 * decision 10): this file is the whole persistence layer, and everything it
 * writes stays in the browser it was typed in.
 *
 * Both stored entries are versioned and read defensively. A missing or
 * unrecognised `schemaVersion` discards that entry with a `console.warn` and
 * falls back to the server defaults, because a half-understood config is worse
 * than a fresh one: you would be reading benchmark numbers off knobs you never
 * set.
 */
import {
  DEFAULT_TUNING_CONFIG,
  migrate,
  projectMode,
  TUNING_SCHEMA_VERSION,
  type ImportAllowLists,
  type ModeTuningConfig,
  type TuningConfig,
} from './tuningConfig';

export const TUNING_STATE_KEY = 'boostlingo.tuning.v1';
export const TUNING_PRESETS_KEY = 'boostlingo.tuning.presets.v1';

export interface TuningPreset {
  name: string;
  config: TuningConfig;
}

/** What one browser remembers between reloads. */
export interface StoredTuningState {
  draft: TuningConfig;
  /** `null` when nothing has been applied yet — the caller uses server defaults. */
  applied: { cascade: ModeTuningConfig; realtime: ModeTuningConfig } | null;
}

/**
 * A built-in preset is a set of **overrides on the server defaults**, not a
 * frozen document. Anything the preset has no opinion about (models, voices,
 * the ids that come from `.env`) must keep the value the server published, or
 * picking "Max denoise" would quietly reset your voice ids to client-side
 * constants the backend might not even accept. `Provider defaults` is the
 * empty override set — that is what makes it "the server defaults at runtime".
 */
export interface BuiltInPresetSpec {
  name: string;
  /** Dotted `TuningConfig` paths → value. */
  overrides: Record<string, unknown>;
}

export const BUILT_IN_PRESETS: BuiltInPresetSpec[] = [
  { name: 'Provider defaults', overrides: {} },
  {
    name: 'Tuned turn-taking',
    overrides: {
      'realtime.turnDetection.silenceDurationMs': 800,
      'realtime.turnDetection.prefixPaddingMs': 300,
      'realtime.turnDetection.interruptResponse': false,
      'cascade.deepgram.endpointingMs': 800,
      'cascade.deepgram.utteranceEndMs': 3000,
    },
  },
  {
    // Every denoise stage in the chain at once, in both modes. The panel keeps
    // the stages the server hasn't got installed disabled, but the config
    // still records them — so the same file replays in an environment that
    // does have them, and the fingerprint says which run it was.
    name: 'Max denoise',
    overrides: {
      'client.microphone.echoCancellation': true,
      'client.microphone.noiseSuppression': true,
      'client.microphone.autoGainControl': true,
      'client.rmsGate.enabled': true,
      'client.rnnoise.enabled': true,
      'realtime.noiseReduction': 'far_field',
      'cascade.denoise.noisereduce.enabled': true,
      'cascade.denoise.deepfilternet.enabled': true,
    },
  },
];

function withOverrides(config: TuningConfig, overrides: Record<string, unknown>): TuningConfig {
  const next = structuredClone(config) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.');
    let node = next;
    for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
    node[keys[keys.length - 1]] = value;
  }
  return next as unknown as TuningConfig;
}

/** The built-ins as complete documents, resolved against the live server defaults. */
export function builtInPresets(serverDefaults: TuningConfig): TuningPreset[] {
  return BUILT_IN_PRESETS.map((spec) => ({ name: spec.name, config: withOverrides(serverDefaults, spec.overrides) }));
}

export function isBuiltInPreset(name: string): boolean {
  return BUILT_IN_PRESETS.some((preset) => preset.name === name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `null` for "no storage in this environment". Read off `window` rather than
 * the bare global: under Node the bare `localStorage` binding resolves to
 * Node's own experimental one, which is not the browser's (nor jsdom's).
 */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage can throw outright when the browser blocks it (private mode,
    // third-party-cookie policies). The panel still works; it just forgets.
    return null;
  }
}

function readEntry(key: string): Record<string, unknown> | null {
  const raw = storage()?.getItem(key);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    console.warn(`Discarding ${key}: it is not valid JSON.`);
    return null;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== TUNING_SCHEMA_VERSION) {
    console.warn(`Discarding ${key}: unsupported schemaVersion ${String((parsed as Record<string, unknown>)?.schemaVersion)}.`);
    return null;
  }
  return parsed;
}

function writeEntry(key: string, body: Record<string, unknown>): void {
  try {
    storage()?.setItem(key, JSON.stringify({ schemaVersion: TUNING_SCHEMA_VERSION, ...body }));
  } catch (error) {
    // A full quota must not take the panel down with it.
    console.warn(`Could not persist ${key}.`, error);
  }
}

/**
 * A stored `ModeTuningConfig` is validated by completing it as a full document
 * (so a missing key still comes from the server defaults) and re-projecting.
 * The stored `mode` is not trusted — the key it was filed under is.
 */
function migrateMode(
  stored: unknown,
  mode: 'cascade' | 'realtime',
  serverDefaults: TuningConfig,
  allowLists: ImportAllowLists | null,
): ModeTuningConfig | null {
  const config = migrate(stored, serverDefaults, allowLists);
  return config ? projectMode(config, mode) : null;
}

/**
 * Reads `boostlingo.tuning.v1`. Called **after** the capabilities response has
 * settled, so "missing keys are filled from the server defaults" means the
 * server's, not the client's fallback copy.
 */
export function loadTuningState(
  serverDefaults: TuningConfig,
  allowLists: ImportAllowLists | null = null,
): StoredTuningState | null {
  const entry = readEntry(TUNING_STATE_KEY);
  if (!entry) return null;

  const draft = migrate(entry.draft, serverDefaults, allowLists);
  if (!draft) return null;

  const storedApplied = isRecord(entry.applied) ? entry.applied : null;
  const cascade = storedApplied ? migrateMode(storedApplied.cascade, 'cascade', serverDefaults, allowLists) : null;
  const realtime = storedApplied ? migrateMode(storedApplied.realtime, 'realtime', serverDefaults, allowLists) : null;

  return { draft, applied: cascade && realtime ? { cascade, realtime } : null };
}

export function saveTuningState(state: StoredTuningState): void {
  writeEntry(TUNING_STATE_KEY, { draft: state.draft, applied: state.applied });
}

/** Reads `boostlingo.tuning.presets.v1`. Built-ins are not stored — they are code. */
export function loadPresets(
  serverDefaults: TuningConfig = DEFAULT_TUNING_CONFIG,
  allowLists: ImportAllowLists | null = null,
): TuningPreset[] {
  const entry = readEntry(TUNING_PRESETS_KEY);
  if (!entry || !Array.isArray(entry.presets)) return [];

  const presets: TuningPreset[] = [];
  for (const stored of entry.presets) {
    if (!isRecord(stored) || typeof stored.name !== 'string') continue;
    const config = migrate(stored.config, serverDefaults, allowLists);
    if (!config) {
      console.warn(`Discarding stored preset "${stored.name}": unsupported schemaVersion.`);
      continue;
    }
    presets.push({ name: stored.name, config });
  }
  return presets;
}

export function savePresets(presets: TuningPreset[]): void {
  writeEntry(TUNING_PRESETS_KEY, { presets });
}
