/**
 * `GET /api/tuning/capabilities` (ticket 01): the server's `.env`-derived
 * tuning defaults, the curated allow-lists, and which optional denoise stages
 * are installed. Read-only, no auth, no body — this is how the panel shows
 * *server* defaults instead of blanks (story AC 1.11) and how it learns
 * anything at all about backend capabilities, which it could not before.
 *
 * The base URL constant is duplicated rather than imported from
 * `cascadeConfig.ts` / `realtimeConfig.ts`, following the comment at
 * `cascadeConfig.ts:1-4`: each page module keeps its own so their module
 * graphs stay independent.
 */
import {
  DEEPGRAM_MODELS,
  DEFAULT_TUNING_CONFIG,
  EAGERNESS_LEVELS,
  ELEVENLABS_VOICES,
  NOISE_REDUCTION_MODES,
  REALTIME_MODELS,
  REALTIME_VOICES,
  TEXT_MODELS,
  TURN_DETECTION_TYPES,
  type ElevenLabsVoiceOption,
  type TuningConfig,
} from './tuningConfig';

const DEFAULT_API_BASE_URL = 'http://localhost:8000';

const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_API_BASE_URL;

export const TUNING_CAPABILITIES_ENDPOINT = `${API_BASE_URL}/api/tuning/capabilities`;

/** The four optional server-side denoise stages the panel can gate on. */
export type DenoiseStageName = 'deepfilternet' | 'noisereduce' | 'demucs' | 'dns64';

export interface StageAvailability {
  installed: boolean;
  /** False for the benchmark-only stages (Demucs, DNS64) — never in the live path. */
  liveCapable: boolean;
  /** Present when the stage is unusable: what to install, or why it failed to load. */
  reason?: string;
}

export interface TuningAllowLists {
  realtimeModels: string[];
  realtimeVoices: string[];
  deepgramModels: string[];
  textModels: string[];
  elevenLabsVoices: ElevenLabsVoiceOption[];
  turnDetectionTypes: string[];
  eagerness: string[];
  noiseReduction: string[];
}

export interface TuningCapabilities {
  schemaVersion: number;
  /** The full `TuningConfig` the server would apply with no client input. */
  defaults: TuningConfig;
  allowLists: TuningAllowLists;
  stages: Record<DenoiseStageName, StageAvailability>;
}

const STAGE_NAMES: DenoiseStageName[] = ['deepfilternet', 'noisereduce', 'demucs', 'dns64'];

const UNREPORTED_STAGE: StageAvailability = {
  installed: false,
  liveCapable: false,
  reason: 'This server did not report the stage.',
};

/** Exported so the panel can still populate its pickers when the fetch failed. */
export const FALLBACK_ALLOW_LISTS: TuningAllowLists = {
  realtimeModels: [...REALTIME_MODELS],
  realtimeVoices: [...REALTIME_VOICES],
  deepgramModels: [...DEEPGRAM_MODELS],
  textModels: [...TEXT_MODELS],
  elevenLabsVoices: ELEVENLABS_VOICES,
  turnDetectionTypes: [...TURN_DETECTION_TYPES],
  eagerness: [...EAGERNESS_LEVELS],
  noiseReduction: [...NOISE_REDUCTION_MODES],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : fallback;
}

function voiceList(value: unknown, fallback: ElevenLabsVoiceOption[]): ElevenLabsVoiceOption[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter(
    (item): item is ElevenLabsVoiceOption => isRecord(item) && typeof item.id === 'string' && typeof item.label === 'string',
  );
  return items.length > 0 ? items : fallback;
}

/**
 * Keys the default document deliberately omits (absent = "provider default").
 * If the server sends one, it is copied through untouched.
 */
const OPTIONAL_DEFAULT_KEYS = new Set([
  'threshold',
  'prefixPaddingMs',
  'silenceDurationMs',
  'eagerness',
  'interruptResponse',
  'noiseReduction',
]);

/**
 * Fills in whatever the response left out from `DEFAULT_TUNING_CONFIG`, keyed
 * off the default document's own shape: a key the server doesn't send keeps
 * the client default, a key the server sends with the wrong JSON type is
 * ignored, and a key neither side knows about is dropped. Anything under a
 * knob the client knows to be optional (the Realtime turn-detection keys and
 * `noiseReduction`) is copied through as-is, because *absent* is a meaningful
 * value there and must survive into the fingerprint.
 */
function mergeDefaults(template: unknown, incoming: unknown): unknown {
  if (!isRecord(template) || !isRecord(incoming)) {
    return typeof template === typeof incoming ? incoming : template;
  }
  const merged: Record<string, unknown> = {};
  for (const [key, templateValue] of Object.entries(template)) {
    merged[key] = key in incoming ? mergeDefaults(templateValue, incoming[key]) : templateValue;
  }
  // Optional keys the template omits by design: the server is the authority on
  // whether they are set at all.
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in merged) && OPTIONAL_DEFAULT_KEYS.has(key)) merged[key] = value;
  }
  return merged;
}

/** Applies the tolerances above to a parsed 200 body. */
export function parseCapabilities(body: unknown): TuningCapabilities {
  const payload = isRecord(body) ? body : {};
  const allowLists = isRecord(payload.allowLists) ? payload.allowLists : {};
  const stagesBody = isRecord(payload.stages) ? payload.stages : {};

  const stages = {} as Record<DenoiseStageName, StageAvailability>;
  for (const name of STAGE_NAMES) {
    const reported = stagesBody[name];
    if (!isRecord(reported) || typeof reported.installed !== 'boolean') {
      stages[name] = UNREPORTED_STAGE;
      continue;
    }
    stages[name] = {
      installed: reported.installed,
      liveCapable: typeof reported.liveCapable === 'boolean' ? reported.liveCapable : false,
      ...(typeof reported.reason === 'string' ? { reason: reported.reason } : {}),
    };
  }

  return {
    schemaVersion: typeof payload.schemaVersion === 'number' ? payload.schemaVersion : DEFAULT_TUNING_CONFIG.schemaVersion,
    defaults: mergeDefaults(DEFAULT_TUNING_CONFIG, payload.defaults) as TuningConfig,
    allowLists: {
      realtimeModels: stringList(allowLists.realtimeModels, FALLBACK_ALLOW_LISTS.realtimeModels),
      realtimeVoices: stringList(allowLists.realtimeVoices, FALLBACK_ALLOW_LISTS.realtimeVoices),
      deepgramModels: stringList(allowLists.deepgramModels, FALLBACK_ALLOW_LISTS.deepgramModels),
      textModels: stringList(allowLists.textModels, FALLBACK_ALLOW_LISTS.textModels),
      elevenLabsVoices: voiceList(allowLists.elevenLabsVoices, FALLBACK_ALLOW_LISTS.elevenLabsVoices),
      turnDetectionTypes: stringList(allowLists.turnDetectionTypes, FALLBACK_ALLOW_LISTS.turnDetectionTypes),
      eagerness: stringList(allowLists.eagerness, FALLBACK_ALLOW_LISTS.eagerness),
      noiseReduction: stringList(allowLists.noiseReduction, FALLBACK_ALLOW_LISTS.noiseReduction),
    },
    stages,
  };
}

/**
 * Throws on a transport failure or a non-2xx status — the caller falls back to
 * `DEFAULT_TUNING_CONFIG` and renders the server stages as unavailable
 * (wireframe §3 rule 5). A *200 with fields missing* is tolerated instead of
 * thrown, so an older or partially-configured server still yields a usable
 * panel.
 */
export async function fetchCapabilities(signal?: AbortSignal): Promise<TuningCapabilities> {
  const response = await fetch(TUNING_CAPABILITIES_ENDPOINT, { signal });
  if (!response.ok) {
    throw new Error(`Tuning capabilities request failed with ${response.status}`);
  }
  return parseCapabilities(await response.json());
}
