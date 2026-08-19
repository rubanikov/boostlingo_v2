/**
 * The shared tuning document (ticket 01): types, defaults, per-knob metadata,
 * and the config fingerprint.
 *
 * PURE — no React, no DOM, no fetch. Same idiom as `segmentation.ts` /
 * `latencyTracking.ts`: the logic the panel, the transports and the harnesses
 * all depend on lives here with its own unit test, so none of them has to be
 * running to check it.
 *
 * The fingerprint is a cross-language contract: `backend/app/tuning/
 * fingerprint.py` must produce byte-identical canonical JSON for the same
 * document, and `shared/tuning-fingerprint-cases.json` (read by both test
 * suites) is what proves it. Everything in `canonicalize()` — key order,
 * absent-key handling, number formatting — is therefore load-bearing. Read the
 * brief's "Fingerprint algorithm (exact)" before changing a character of it.
 */

export const TUNING_SCHEMA_VERSION = 1 as const;

export type TuningMode = 'cascade' | 'realtime';

export interface ClientTuning {
  microphone: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
  rmsGate: {
    enabled: boolean;
    thresholdDbfs: number; // -80..0   step 1    default -45
    holdMs: number; //        0..2000  step 10   default 200
    attackMs: number; //      0..500   step 1    default 5
    releaseMs: number; //     0..2000  step 10   default 80
    attenuationDb: number; //  0..60    step 1    default 12
    fullMute: boolean; //                        default false
  };
  rnnoise: { enabled: boolean; voiceProbThreshold: number }; // 0..1 step 0.05, default 0.5
}

export interface RealtimeTuning {
  model: string; // REALTIME_MODELS, default 'gpt-realtime'
  voice: string; // REALTIME_VOICES, default 'alloy'
  turnDetection: {
    type: 'server_vad' | 'semantic_vad'; // required, default 'server_vad'
    threshold?: number; // server_vad only, 0..1 step 0.05
    prefixPaddingMs?: number; // server_vad only, 0..5000
    silenceDurationMs?: number; // server_vad only, 0..10000
    eagerness?: 'low' | 'medium' | 'high' | 'auto'; // semantic_vad only
    interruptResponse?: boolean; // both types
  };
  noiseReduction?: 'off' | 'near_field' | 'far_field';
  transcriptCheck: { mode: 'off' | 'flag'; model: string }; // TEXT_MODELS
}

export interface CascadeTuning {
  deepgram: {
    model: string; //           DEEPGRAM_MODELS, default 'nova-3'
    endpointingMs: number; //   0..5000,     default 500
    utteranceEndMs: number; //  1000..5000,  default 3000
    diarize: boolean; //                     default true
  };
  segmentation: { mode: 'hybrid' | 'llm_priority'; model: string };
  denoise: {
    noisereduce: { enabled: boolean; propDecrease: number; stationary: boolean };
    deepfilternet: { enabled: boolean; attenuationLimitDb: number; postFilterBeta: number };
    offline: { demucs: boolean; dns64: boolean }; // benchmark-only; the live path ignores + logs
  };
  transcriptCheck: { mode: 'off' | 'flag' | 'correct'; model: string };
  translationModel: string; // TEXT_MODELS, default 'gpt-4o-mini'
  ttsVoiceA: string; //        ELEVENLABS_VOICES ids
  ttsVoiceB: string;
}

export interface TuningConfig {
  schemaVersion: typeof TUNING_SCHEMA_VERSION;
  client: ClientTuning;
  realtime: RealtimeTuning;
  cascade: CascadeTuning;
}

/**
 * The wire + hash document. `mode` is part of the hash on purpose: the same
 * knobs in different modes are different runs.
 */
export type ModeTuningConfig =
  | { schemaVersion: 1; mode: 'realtime'; client: ClientTuning; realtime: RealtimeTuning }
  | { schemaVersion: 1; mode: 'cascade'; client: ClientTuning; cascade: CascadeTuning };

/**
 * The offline fallback for what the server publishes at
 * `GET /api/tuning/capabilities`. Values mirror today's hardcoded behaviour:
 * `getUserMedia`'s constraints, `deepgram_stt.py`'s module constants, and
 * `realtime.py`'s model/voice constants. Every client-side DSP stage is off,
 * so the default document reproduces the app exactly as it behaves with no
 * tuning at all.
 *
 * The optional Realtime keys (`turnDetection.threshold` and friends,
 * `noiseReduction`) are deliberately *absent*, not set: absent means "omit the
 * key from the outbound provider payload entirely", which is not the same as
 * sending the provider's documented default value.
 */
export const DEFAULT_TUNING_CONFIG: TuningConfig = {
  schemaVersion: TUNING_SCHEMA_VERSION,
  client: {
    microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    rmsGate: {
      enabled: false,
      thresholdDbfs: -45,
      holdMs: 200,
      attackMs: 5,
      releaseMs: 80,
      attenuationDb: 12,
      fullMute: false,
    },
    rnnoise: { enabled: false, voiceProbThreshold: 0.5 },
  },
  realtime: {
    model: 'gpt-realtime',
    voice: 'alloy',
    turnDetection: { type: 'server_vad' },
    transcriptCheck: { mode: 'off', model: 'gpt-4o-mini' },
  },
  cascade: {
    deepgram: { model: 'nova-3', endpointingMs: 500, utteranceEndMs: 3000, diarize: true },
    segmentation: { mode: 'hybrid', model: 'gpt-4o-mini' },
    denoise: {
      noisereduce: { enabled: false, propDecrease: 1.0, stationary: false },
      deepfilternet: { enabled: false, attenuationLimitDb: 30, postFilterBeta: 0.02 },
      offline: { demucs: false, dns64: false },
    },
    transcriptCheck: { mode: 'off', model: 'gpt-4o-mini' },
    translationModel: 'gpt-4o-mini',
    ttsVoiceA: '21m00Tcm4TlvDq8ikWAM',
    ttsVoiceB: 'ErXwobaYiN019PkySvjV',
  },
};

/**
 * Offline copies of `backend/app/tuning/allowlists.py`. The panel reads the
 * live lists from `/api/tuning/capabilities`; these are only used when that
 * fetch fails, so a picker still renders something rather than going blank
 * (wireframe §3 rule 5). They are a fallback, never the source of truth — the
 * server validates against its own copy.
 */
export const REALTIME_MODELS = ['gpt-realtime', 'gpt-realtime-mini'] as const;
export const REALTIME_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;
export const DEEPGRAM_MODELS = ['nova-3', 'nova-2'] as const;
export const TEXT_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'] as const;
export const TURN_DETECTION_TYPES = ['server_vad', 'semantic_vad'] as const;
export const EAGERNESS_LEVELS = ['low', 'medium', 'high', 'auto'] as const;
export const NOISE_REDUCTION_MODES = ['off', 'near_field', 'far_field'] as const;

export interface ElevenLabsVoiceOption {
  id: string;
  label: string;
}

/** The two ids `backend/app/config.py` ships as defaults; the server may add more. */
export const ELEVENLABS_VOICES: ElevenLabsVoiceOption[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel (voice A default)' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni (voice B default)' },
];

/**
 * Cascade knobs that live on the Deepgram *connection* rather than in
 * per-segment processing: applying one mid-session reopens the STT socket
 * (ticket 07). Mirrored server-side as `DEEPGRAM_CONNECTION_LEVEL_FIELDS` so
 * the backend decides the reconnect independently of what the client claims.
 */
export const DEEPGRAM_CONNECTION_LEVEL_PATHS = [
  'cascade.deepgram.endpointingMs',
  'cascade.deepgram.utteranceEndMs',
  'cascade.deepgram.diarize',
  'cascade.deepgram.model',
] as const;

/** Panel section a knob is rendered in — matches the `tuning-section-*` testids. */
export type KnobSection = 'microphone' | 'denoise' | 'turn' | 'segmentation' | 'transcript-check' | 'models';

export interface KnobMeta {
  /** `'both'` = the shared `client` block, which is projected into either mode. */
  mode: TuningMode | 'both';
  section: KnobSection;
  /** True only for the Deepgram connection-level set above. */
  connectionLevel: boolean;
  /** Range + step for numeric knobs; also drives fingerprint quantisation. */
  min?: number;
  max?: number;
  step?: number;
  /** The provider's own field name, shown in muted mono beside the row. */
  wireField: string;
}

/**
 * Keyed by dotted path inside `TuningConfig`. Because `projectMode()` keeps
 * each block under its own key, the same path also addresses the knob inside a
 * `ModeTuningConfig` — which is what lets `canonicalize()` look ranges up while
 * it walks the projected document.
 *
 * **`cascade.denoise.deepfilternet.postFilterBeta` uses step 0.01, not the
 * brief's 0.05.** The brief's own documented default for that knob is 0.02,
 * which is not on a 0.05 grid: quantising to 0.05 would silently rewrite the
 * default to 0 and hash a config nobody chose. `fingerprint.py` carries the
 * same 0.01 step, so the two sides agree.
 */
export const KNOB_METADATA: Record<string, KnobMeta> = {
  'client.microphone.echoCancellation': { mode: 'both', section: 'microphone', connectionLevel: false, wireField: 'echoCancellation' },
  'client.microphone.noiseSuppression': { mode: 'both', section: 'microphone', connectionLevel: false, wireField: 'noiseSuppression' },
  'client.microphone.autoGainControl': { mode: 'both', section: 'microphone', connectionLevel: false, wireField: 'autoGainControl' },

  'client.rmsGate.enabled': { mode: 'both', section: 'denoise', connectionLevel: false, wireField: 'rmsGate.enabled' },
  'client.rmsGate.thresholdDbfs': { mode: 'both', section: 'denoise', connectionLevel: false, min: -80, max: 0, step: 1, wireField: 'thresholdDbfs' },
  'client.rmsGate.holdMs': { mode: 'both', section: 'denoise', connectionLevel: false, min: 0, max: 2000, step: 10, wireField: 'holdMs' },
  'client.rmsGate.attackMs': { mode: 'both', section: 'denoise', connectionLevel: false, min: 0, max: 500, step: 1, wireField: 'attackMs' },
  'client.rmsGate.releaseMs': { mode: 'both', section: 'denoise', connectionLevel: false, min: 0, max: 2000, step: 10, wireField: 'releaseMs' },
  'client.rmsGate.attenuationDb': { mode: 'both', section: 'denoise', connectionLevel: false, min: 0, max: 60, step: 1, wireField: 'attenuationDb' },
  'client.rmsGate.fullMute': { mode: 'both', section: 'denoise', connectionLevel: false, wireField: 'fullMute' },

  'client.rnnoise.enabled': { mode: 'both', section: 'denoise', connectionLevel: false, wireField: 'rnnoise.enabled' },
  'client.rnnoise.voiceProbThreshold': { mode: 'both', section: 'denoise', connectionLevel: false, min: 0, max: 1, step: 0.05, wireField: 'voiceProbThreshold' },

  'realtime.model': { mode: 'realtime', section: 'models', connectionLevel: false, wireField: 'session.model' },
  'realtime.voice': { mode: 'realtime', section: 'models', connectionLevel: false, wireField: 'session.audio.output.voice' },
  'realtime.turnDetection.type': { mode: 'realtime', section: 'turn', connectionLevel: false, wireField: 'turn_detection.type' },
  'realtime.turnDetection.threshold': { mode: 'realtime', section: 'turn', connectionLevel: false, min: 0, max: 1, step: 0.05, wireField: 'threshold' },
  'realtime.turnDetection.prefixPaddingMs': { mode: 'realtime', section: 'turn', connectionLevel: false, min: 0, max: 5000, step: 1, wireField: 'prefix_padding_ms' },
  'realtime.turnDetection.silenceDurationMs': { mode: 'realtime', section: 'turn', connectionLevel: false, min: 0, max: 10000, step: 1, wireField: 'silence_duration_ms' },
  'realtime.turnDetection.eagerness': { mode: 'realtime', section: 'turn', connectionLevel: false, wireField: 'eagerness' },
  'realtime.turnDetection.interruptResponse': { mode: 'realtime', section: 'turn', connectionLevel: false, wireField: 'interrupt_response' },
  'realtime.noiseReduction': { mode: 'realtime', section: 'denoise', connectionLevel: false, wireField: 'noise_reduction' },
  'realtime.transcriptCheck.mode': { mode: 'realtime', section: 'transcript-check', connectionLevel: false, wireField: 'transcriptCheck.mode' },
  'realtime.transcriptCheck.model': { mode: 'realtime', section: 'transcript-check', connectionLevel: false, wireField: 'transcriptCheck.model' },

  'cascade.deepgram.model': { mode: 'cascade', section: 'models', connectionLevel: true, wireField: 'model' },
  'cascade.deepgram.endpointingMs': { mode: 'cascade', section: 'turn', connectionLevel: true, min: 0, max: 5000, step: 1, wireField: 'endpointing' },
  'cascade.deepgram.utteranceEndMs': { mode: 'cascade', section: 'turn', connectionLevel: true, min: 1000, max: 5000, step: 1, wireField: 'utterance_end_ms' },
  'cascade.deepgram.diarize': { mode: 'cascade', section: 'turn', connectionLevel: true, wireField: 'diarize' },
  'cascade.segmentation.mode': { mode: 'cascade', section: 'segmentation', connectionLevel: false, wireField: 'segmentationMode' },
  'cascade.segmentation.model': { mode: 'cascade', section: 'segmentation', connectionLevel: false, wireField: 'segmentation.model' },
  'cascade.denoise.noisereduce.enabled': { mode: 'cascade', section: 'denoise', connectionLevel: false, wireField: 'noisereduce.enabled' },
  'cascade.denoise.noisereduce.propDecrease': { mode: 'cascade', section: 'denoise', connectionLevel: false, min: 0, max: 1, step: 0.05, wireField: 'prop_decrease' },
  'cascade.denoise.noisereduce.stationary': { mode: 'cascade', section: 'denoise', connectionLevel: false, wireField: 'stationary' },
  'cascade.denoise.deepfilternet.enabled': { mode: 'cascade', section: 'denoise', connectionLevel: false, wireField: 'deepfilternet.enabled' },
  'cascade.denoise.deepfilternet.attenuationLimitDb': { mode: 'cascade', section: 'denoise', connectionLevel: false, min: 0, max: 100, step: 1, wireField: 'attenuation_limit_db' },
  'cascade.denoise.deepfilternet.postFilterBeta': { mode: 'cascade', section: 'denoise', connectionLevel: false, min: 0, max: 1, step: 0.01, wireField: 'post_filter_beta' },
  'cascade.denoise.offline.demucs': { mode: 'cascade', section: 'denoise', connectionLevel: false, wireField: 'demucs' },
  'cascade.denoise.offline.dns64': { mode: 'cascade', section: 'denoise', connectionLevel: false, wireField: 'dns64' },
  'cascade.transcriptCheck.mode': { mode: 'cascade', section: 'transcript-check', connectionLevel: false, wireField: 'transcriptCheck.mode' },
  'cascade.transcriptCheck.model': { mode: 'cascade', section: 'transcript-check', connectionLevel: false, wireField: 'transcriptCheck.model' },
  'cascade.translationModel': { mode: 'cascade', section: 'models', connectionLevel: false, wireField: 'translationModel' },
  'cascade.ttsVoiceA': { mode: 'cascade', section: 'models', connectionLevel: false, wireField: 'ttsVoiceA' },
  'cascade.ttsVoiceB': { mode: 'cascade', section: 'models', connectionLevel: false, wireField: 'ttsVoiceB' },
};

/** Narrows the full document to the mode that is about to run (or be hashed). */
export function projectMode(config: TuningConfig, mode: TuningMode): ModeTuningConfig {
  return mode === 'realtime'
    ? { schemaVersion: config.schemaVersion, mode: 'realtime', client: config.client, realtime: config.realtime }
    : { schemaVersion: config.schemaVersion, mode: 'cascade', client: config.client, cascade: config.cascade };
}

/**
 * Dotted paths whose value differs between two projected documents, in the
 * order they appear in the document. A key present in one and absent in the
 * other counts as changed — that is the "Provider default" toggle, and it is a
 * real change to the outbound payload.
 */
export function diff(before: ModeTuningConfig, after: ModeTuningConfig): string[] {
  const paths: string[] = [];
  walkDiff(before as unknown as JsonLike, after as unknown as JsonLike, '', paths);
  return paths;
}

function walkDiff(before: JsonLike, after: JsonLike, path: string, out: string[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      walkDiff(before[key], after[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  if (before === after) return;
  if (before === undefined && after === undefined) return;
  out.push(path);
}

/**
 * Clamps the gate parameters to their documented ranges on the main thread
 * before they are posted to the worklet. The worklet clamps again defensively
 * — it can be sent anything — but a value clamped here is also the value that
 * gets hashed, so the two can never disagree about what is running.
 */
export function clampGateParams(gate: ClientTuning['rmsGate']): ClientTuning['rmsGate'] {
  return {
    enabled: gate.enabled,
    thresholdDbfs: quantise(gate.thresholdDbfs, 'client.rmsGate.thresholdDbfs'),
    holdMs: quantise(gate.holdMs, 'client.rmsGate.holdMs'),
    attackMs: quantise(gate.attackMs, 'client.rmsGate.attackMs'),
    releaseMs: quantise(gate.releaseMs, 'client.rmsGate.releaseMs'),
    attenuationDb: quantise(gate.attenuationDb, 'client.rmsGate.attenuationDb'),
    fullMute: gate.fullMute,
  };
}

/**
 * The knobs whose *absence* is a value: absent means "omit the key from the
 * outbound provider payload entirely", which is not the same as sending the
 * provider's own default. An imported document that carries the parent block
 * but not the key is therefore taken at its word — the key stays absent rather
 * than being filled from the server defaults, or export → import would not
 * round-trip (story AC 1.10).
 */
const OPTIONAL_KNOB_PATHS = new Set([
  'realtime.turnDetection.threshold',
  'realtime.turnDetection.prefixPaddingMs',
  'realtime.turnDetection.silenceDurationMs',
  'realtime.turnDetection.eagerness',
  'realtime.turnDetection.interruptResponse',
  'realtime.noiseReduction',
]);

/** Those keys have no value in `DEFAULT_TUNING_CONFIG` to read a type off. */
const OPTIONAL_KNOB_TYPES: Record<string, 'string' | 'number' | 'boolean'> = {
  'realtime.turnDetection.threshold': 'number',
  'realtime.turnDetection.prefixPaddingMs': 'number',
  'realtime.turnDetection.silenceDurationMs': 'number',
  'realtime.turnDetection.eagerness': 'string',
  'realtime.turnDetection.interruptResponse': 'boolean',
  'realtime.noiseReduction': 'string',
};

/**
 * Closed sets that come from the provider SDKs rather than from our curated
 * allow-lists, so they are checked against the constants above instead of
 * against the capabilities response.
 */
const ENUM_KNOB_VALUES: Record<string, readonly string[]> = {
  'realtime.turnDetection.type': TURN_DETECTION_TYPES,
  'realtime.turnDetection.eagerness': EAGERNESS_LEVELS,
  'realtime.noiseReduction': NOISE_REDUCTION_MODES,
  'realtime.transcriptCheck.mode': ['off', 'flag'],
  'cascade.transcriptCheck.mode': ['off', 'flag', 'correct'],
  'cascade.segmentation.mode': ['hybrid', 'llm_priority'],
};

/** Which curated list each model/voice picker validates against. */
const ALLOW_LIST_KNOBS: Record<string, keyof ImportAllowLists> = {
  'realtime.model': 'realtimeModels',
  'realtime.voice': 'realtimeVoices',
  'realtime.transcriptCheck.model': 'textModels',
  'cascade.deepgram.model': 'deepgramModels',
  'cascade.segmentation.model': 'textModels',
  'cascade.transcriptCheck.model': 'textModels',
  'cascade.translationModel': 'textModels',
  'cascade.ttsVoiceA': 'elevenLabsVoices',
  'cascade.ttsVoiceB': 'elevenLabsVoices',
};

/**
 * Top-level keys that are part of the document but not knobs. `mode` is here
 * so a mode-scoped export (what the transports and the capture harness carry)
 * imports without being reported as junk — it is dropped, because the full
 * document always carries both modes.
 */
const NON_KNOB_KEYS = new Set(['schemaVersion', 'mode']);

const KNOB_PATHS = Object.keys(KNOB_METADATA);

/**
 * The curated lists `parseImported()` validates ids against. Structurally a
 * subset of `TuningCapabilities['allowLists']`, declared here rather than
 * imported so this module stays free of `tuningCapabilities.ts` (which imports
 * *this* one).
 */
export interface ImportAllowLists {
  realtimeModels: string[];
  realtimeVoices: string[];
  deepgramModels: string[];
  textModels: string[];
  elevenLabsVoices: { id: string }[];
}

export type ImportResult =
  | { ok: true; config: TuningConfig; warnings: string[] }
  | { ok: false; error: string };

/** wireframe §7, verbatim — all three of them. */
const IMPORT_INVALID_MESSAGE = "That file isn't a valid tuning config.";

function unknownFieldsMessage(names: string[]): string {
  return `Imported. Ignored ${names.length} unknown field(s): ${names.join(', ')}.`;
}

function retiredIdMessage(value: string, fallback: string): string {
  return `${value} is no longer available — using ${fallback}.`;
}

function readValue(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (!isPlainObject(node as JsonLike)) return undefined;
    return (node as Record<string, unknown>)[key];
  }, root);
}

function hasValue(root: unknown, path: string): boolean {
  const keys = path.split('.');
  let node: unknown = root;
  for (const key of keys) {
    if (!isPlainObject(node as JsonLike) || !(key in (node as Record<string, unknown>))) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}

/** Mutating set on a document we already own (a fresh clone of the defaults). */
function assignValue(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = root;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key] as JsonLike)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

/** Mutating delete: the key is *gone*, which is what "absent" has to mean. */
function removeValue(root: Record<string, unknown>, path: string): void {
  const keys = path.split('.');
  let node: Record<string, unknown> | undefined = root;
  for (const key of keys.slice(0, -1)) {
    node = isPlainObject(node[key] as JsonLike) ? (node[key] as Record<string, unknown>) : undefined;
    if (!node) return;
  }
  delete node[keys[keys.length - 1]];
}

/** Dotted paths in `incoming` that this schema version knows nothing about. */
function collectUnknownPaths(incoming: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const [key, value] of Object.entries(incoming)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (NON_KNOB_KEYS.has(path)) continue;
    if (KNOB_METADATA[path]) {
      // A knob whose value arrived as an object is as unusable as a key we
      // have never heard of, and saying so is more useful than silence.
      if (isPlainObject(value as JsonLike)) out.push(path);
      continue;
    }
    const isBranch = KNOB_PATHS.some((knob) => knob.startsWith(`${path}.`));
    if (isBranch && isPlainObject(value as JsonLike)) {
      collectUnknownPaths(value as Record<string, unknown>, path, out);
      continue;
    }
    out.push(path);
  }
}

/**
 * Builds a complete `TuningConfig` from a parsed document: every knob the
 * document sets (and that survives its range / allow-list) is taken from it,
 * everything else comes from `serverDefaults`, and the six absent-key knobs
 * stay absent when the document carries their parent block.
 */
function buildConfig(
  incoming: Record<string, unknown>,
  serverDefaults: TuningConfig,
  allowLists: ImportAllowLists | null,
  warnings: string[],
): TuningConfig {
  const config = structuredClone(serverDefaults) as unknown as Record<string, unknown>;
  config.schemaVersion = TUNING_SCHEMA_VERSION;

  for (const path of KNOB_PATHS) {
    const optional = OPTIONAL_KNOB_PATHS.has(path);
    if (!hasValue(incoming, path)) {
      // The document is authoritative about an absent optional key only if it
      // actually carries the block that key lives in.
      const parent = path.slice(0, path.lastIndexOf('.'));
      if (optional && hasValue(incoming, parent)) removeValue(config, path);
      continue;
    }

    const value = readValue(incoming, path);
    const expected = optional ? OPTIONAL_KNOB_TYPES[path] : typeof readValue(serverDefaults, path);
    if (typeof value !== expected) {
      console.warn(`Ignoring tuning field ${path}: expected a ${expected}, got ${typeof value}.`);
      continue;
    }

    if (typeof value === 'number') {
      assignValue(config, path, quantise(value, path));
      continue;
    }

    if (typeof value === 'string') {
      const allowListKey = ALLOW_LIST_KNOBS[path];
      if (allowListKey && allowLists) {
        const allowed =
          allowListKey === 'elevenLabsVoices'
            ? allowLists.elevenLabsVoices.some((voice) => voice.id === value)
            : (allowLists[allowListKey] as string[]).includes(value);
        if (!allowed) {
          // Never silently keep an id the backend will reject: fall back to
          // the picker's default and say so (wireframe §4).
          warnings.push(retiredIdMessage(value, String(readValue(serverDefaults, path))));
          continue;
        }
      }
      const enumValues = ENUM_KNOB_VALUES[path];
      if (enumValues && !enumValues.includes(value)) {
        console.warn(`Ignoring tuning field ${path}: ${value} is not one of ${enumValues.join(', ')}.`);
        continue;
      }
    }

    assignValue(config, path, value);
  }

  return config as unknown as TuningConfig;
}

/**
 * Parses an exported/pasted tuning document into a complete `TuningConfig`
 * (ticket 03).
 *
 * Wholesale rejection is reserved for a document that is not one of ours at
 * all (unparseable, not an object, or a schema version this build cannot
 * read). Everything else is repaired and reported: unknown keys are dropped
 * and named, missing keys are filled from the server defaults, and a model or
 * voice id that has left the curated allow-list falls back to that picker's
 * default. The alternative — rejecting the whole file — makes every schema
 * bump break every config anyone saved.
 */
export function parseImported(
  text: string,
  allowLists: ImportAllowLists,
  serverDefaults: TuningConfig,
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: IMPORT_INVALID_MESSAGE };
  }
  if (!isPlainObject(parsed as JsonLike)) return { ok: false, error: IMPORT_INVALID_MESSAGE };

  const incoming = parsed as Record<string, unknown>;
  if (incoming.schemaVersion !== TUNING_SCHEMA_VERSION) return { ok: false, error: IMPORT_INVALID_MESSAGE };

  const warnings: string[] = [];
  const unknownPaths: string[] = [];
  collectUnknownPaths(incoming, '', unknownPaths);
  if (unknownPaths.length > 0) warnings.push(unknownFieldsMessage(unknownPaths));

  return { ok: true, config: buildConfig(incoming, serverDefaults, allowLists, warnings), warnings };
}

/**
 * The localStorage read path: a stored document whose `schemaVersion` is
 * missing or not this build's is discarded outright (`null`, and the caller
 * falls back to the server defaults); anything else is completed against those
 * defaults and repaired the same way an import is.
 *
 * Separate from `parseImported()` because storage holds an already-parsed
 * value and has nowhere to show warnings at hydration time — a retired id in a
 * *stored* config is a console line, not a message in the header.
 */
export function migrate(
  stored: unknown,
  serverDefaults: TuningConfig = DEFAULT_TUNING_CONFIG,
  allowLists: ImportAllowLists | null = null,
): TuningConfig | null {
  if (!isPlainObject(stored as JsonLike)) return null;
  const incoming = stored as Record<string, unknown>;
  if (incoming.schemaVersion !== TUNING_SCHEMA_VERSION) return null;
  const warnings: string[] = [];
  const config = buildConfig(incoming, serverDefaults, allowLists, warnings);
  for (const warning of warnings) console.warn(warning);
  return config;
}

type JsonLike = string | number | boolean | null | undefined | JsonLike[] | { [key: string]: JsonLike };

function isPlainObject(value: JsonLike): value is { [key: string]: JsonLike } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Clamp to the knob's documented range, then round to its documented step,
 * then to 2 decimal places (the step grid never needs more, and the extra
 * rounding is what removes binary-float dust like 0.30000000000000004 before
 * it can reach the hash). Knobs with no documented range pass through
 * untouched.
 */
function quantise(value: number, path: string): number {
  const meta = KNOB_METADATA[path];
  if (!meta || !Number.isFinite(value)) return value;
  let next = value;
  if (meta.min !== undefined) next = Math.max(meta.min, next);
  if (meta.max !== undefined) next = Math.min(meta.max, next);
  if (meta.step !== undefined && meta.step > 0) next = Math.round(next / meta.step) * meta.step;
  return roundTo2(next);
}

function roundTo2(value: number): number {
  // `+` normalises -0 back to 0 so TS and Python both emit "0".
  return Number(value.toFixed(2)) + 0;
}

/**
 * Number text, matching Python exactly:
 *   integral -> integer form, no decimal point   (`30`, `1`, `-45`, `0`)
 *   otherwise -> shortest round-trip decimal      (`0.35`, `0.02`, `0.07`)
 * Both `String(x)` in JS and `repr(x)` in Python emit the shortest decimal
 * that round-trips, so quantised 2-decimal values agree character for
 * character.
 */
function emitNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`cannot canonicalize non-finite number: ${value}`);
  if (Number.isInteger(value)) return String(value + 0);
  return String(value);
}

function emit(value: JsonLike, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    value.forEach((item, index) => {
      if (index > 0) out.push(',');
      emit(item, path, out);
    });
    out.push(']');
    return;
  }
  if (isPlainObject(value)) {
    // Sort ascending by UTF-16 code unit (JS default) == Python's sorted().
    // Every key in the document is ASCII [a-zA-Z0-9], so the two agree.
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    out.push('{');
    keys.forEach((key, index) => {
      if (index > 0) out.push(',');
      out.push(JSON.stringify(key), ':');
      emit(value[key], path ? `${path}.${key}` : key, out);
    });
    out.push('}');
    return;
  }
  if (typeof value === 'number') {
    out.push(emitNumber(quantise(value, path)));
    return;
  }
  if (typeof value === 'boolean') {
    out.push(value ? 'true' : 'false');
    return;
  }
  // JSON.stringify escapes exactly what Python's json.dumps(ensure_ascii=False)
  // escapes for these strings, and leaves non-ASCII characters as themselves.
  out.push(JSON.stringify(value));
}

/**
 * Canonical JSON for a projected document: no whitespace, keys sorted, absent
 * (`undefined`) keys dropped, `false`/`0`/`""` kept, floats clamped and
 * step-quantised. Hand-written rather than `JSON.stringify` because
 * `JSON.stringify` emits keys in insertion order — two configs that differ
 * only in key order have to hash identically (story AC 1.12).
 */
export function canonicalize(doc: ModeTuningConfig | JsonLike): string {
  const out: string[] = [];
  emit(doc as JsonLike, '', out);
  return out.join('');
}

/**
 * `cfg:` + the first 8 hex digits of sha256(utf8(canonical JSON)). Truncated
 * because this is a join key for benchmark rows and a chip you read off the
 * screen, not a security primitive.
 */
export function fingerprint(doc: ModeTuningConfig): string;
export function fingerprint(config: TuningConfig, mode: TuningMode): string;
export function fingerprint(input: TuningConfig | ModeTuningConfig, mode?: TuningMode): string {
  const doc = 'mode' in input ? input : projectMode(input, mode ?? 'cascade');
  return `cfg:${sha256Hex(canonicalize(doc)).slice(0, 8)}`;
}

/**
 * A synchronous sha256, deliberately hand-rolled rather than using Web Crypto:
 * `crypto.subtle.digest` is async, and the fingerprint has to be computable
 * during a React render (and inside a pure, non-async `fingerprint()` the
 * harnesses and tests can call). ~40 lines with no dependency is the cheaper
 * trade. Verified against the FIPS 180-4 "abc" vector in the co-located test.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLength = bytes.length * 8;
  // Pad to a multiple of 64 bytes: 0x80, zeros, then the 64-bit length.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  let hex = '';
  for (const word of hash) hex += word.toString(16).padStart(8, '0');
  return hex;
}
