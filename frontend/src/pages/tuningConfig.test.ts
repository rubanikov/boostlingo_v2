import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalize,
  clampGateParams,
  DEFAULT_TUNING_CONFIG,
  diff,
  fingerprint,
  migrate,
  parseImported,
  projectMode,
  sha256Hex,
  TUNING_SCHEMA_VERSION,
  type ImportAllowLists,
  type TuningConfig,
  type TuningMode,
} from './tuningConfig';

interface FixtureCase {
  name: string;
  mode: TuningMode;
  config: TuningConfig;
  expectedFingerprint: string;
}

/**
 * The cross-language parity fixture, read from the repo root rather than
 * copied into `src/`: `backend/tests/test_tuning_config.py` reads the same
 * bytes, and a fixture that isn't literally the same file on both sides
 * proves nothing (brief test S1). Vitest's cwd is the Vite root, `frontend/`.
 */
const FIXTURE_PATH = resolve(process.cwd(), '../shared/tuning-fingerprint-cases.json');
const CASES: FixtureCase[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureCase[];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 "abc" vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches the published vector for the empty string and for a multi-block input', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });

  it('encodes as UTF-8, not UTF-16 code units', () => {
    // sha256 over the two UTF-8 bytes of "é" (0xc3 0xa9), matching what
    // Python hashes for the same string.
    expect(sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
  });
});

describe('S1 — fingerprint parity fixture', () => {
  it('covers the cases the brief calls out', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(6);
    const names = CASES.map((entry) => entry.name);
    expect(names).toContain('defaults-realtime');
    expect(names).toContain('defaults-cascade');
    expect(names).toContain('defaults-cascade-key-reordered');
    expect(names).toContain('cascade-float-knobs');
    expect(names).toContain('cascade-schema-version-2');
  });

  it.each(CASES.map((entry) => [entry.name, entry] as const))(
    'reproduces the committed fingerprint for %s',
    (_name, entry) => {
      expect(fingerprint(entry.config, entry.mode)).toBe(entry.expectedFingerprint);
      // The projected-document overload must agree with the (config, mode) one.
      expect(fingerprint(projectMode(entry.config, entry.mode))).toBe(entry.expectedFingerprint);
    },
  );

  it('produces a `cfg:` prefix and exactly 8 lowercase hex digits', () => {
    for (const entry of CASES) {
      expect(entry.expectedFingerprint).toMatch(/^cfg:[0-9a-f]{8}$/);
    }
  });

  it('hashes two configs that differ only in key order identically', () => {
    const reordered = CASES.find((entry) => entry.name === 'defaults-cascade-key-reordered');
    const baseline = CASES.find((entry) => entry.name === 'defaults-cascade');
    if (!reordered || !baseline) throw new Error('fixture is missing the key-order pair');
    expect(reordered.expectedFingerprint).toBe(baseline.expectedFingerprint);
    expect(fingerprint(reordered.config, 'cascade')).toBe(fingerprint(baseline.config, 'cascade'));
  });

  it('gives each distinct config in the fixture a distinct fingerprint (key-order pair aside)', () => {
    const distinct = CASES.filter((entry) => entry.name !== 'defaults-cascade-key-reordered');
    expect(new Set(distinct.map((entry) => entry.expectedFingerprint)).size).toBe(distinct.length);
  });
});

describe('S2 — canonicalisation', () => {
  it('sorts object keys ascending, with no whitespace anywhere', () => {
    const canonical = canonicalize(projectMode(DEFAULT_TUNING_CONFIG, 'realtime'));
    expect(canonical).not.toMatch(/\s/);
    // `client` < `mode` < `realtime` < `schemaVersion` at the top level, and
    // the same ascending order inside every nested object.
    expect(canonical.startsWith('{"client":')).toBe(true);
    expect(canonical.endsWith('"schemaVersion":1}')).toBe(true);
    expect(canonical).toContain('"microphone":{"autoGainControl":true,"echoCancellation":true,"noiseSuppression":true}');
    expect(canonical).toContain(
      '"rmsGate":{"attackMs":5,"attenuationDb":12,"enabled":false,"fullMute":false,"holdMs":200,"releaseMs":80,"thresholdDbfs":-45}',
    );
  });

  it('omits absent optional keys entirely, and keeps explicitly-set ones', () => {
    const absent = canonicalize(projectMode(DEFAULT_TUNING_CONFIG, 'realtime'));
    expect(absent).toContain('"turnDetection":{"type":"server_vad"}');
    expect(absent).not.toContain('noiseReduction');
    expect(absent).not.toContain('"threshold":');

    const explicit = clone(DEFAULT_TUNING_CONFIG);
    explicit.realtime.turnDetection = { type: 'server_vad', silenceDurationMs: 300 };
    explicit.realtime.noiseReduction = 'off';
    const canonical = canonicalize(projectMode(explicit, 'realtime'));
    expect(canonical).toContain('"turnDetection":{"silenceDurationMs":300,"type":"server_vad"}');
    expect(canonical).toContain('"noiseReduction":"off"');
  });

  it('keeps false, 0 and "" — only `undefined` is dropped', () => {
    const canonical = canonicalize({ a: false, b: 0, c: '', d: undefined, e: null });
    expect(canonical).toBe('{"a":false,"b":0,"c":"","e":null}');
  });

  it('emits an integral float as an integer and a fractional one as its shortest decimal', () => {
    expect(canonicalize({ v: 30.0 })).toBe('{"v":30}');
    expect(canonicalize({ v: 1.0 })).toBe('{"v":1}');
    expect(canonicalize({ v: -0 })).toBe('{"v":0}');
    expect(canonicalize({ v: 0.35 })).toBe('{"v":0.35}');
    expect(canonicalize({ v: 0.02 })).toBe('{"v":0.02}');
  });

  it('clamps and step-quantises float knobs before serialising them', () => {
    const config = clone(DEFAULT_TUNING_CONFIG);
    config.client.rnnoise.voiceProbThreshold = 0.37; // step 0.05 -> 0.35
    config.cascade.denoise.noisereduce.propDecrease = 2.5; // clamped to 1 -> "1", not "1.0"
    config.cascade.deepgram.endpointingMs = 9000; // clamped to 5000
    const canonical = canonicalize(projectMode(config, 'cascade'));
    expect(canonical).toContain('"voiceProbThreshold":0.35');
    expect(canonical).toContain('"propDecrease":1');
    expect(canonical).toContain('"endpointingMs":5000');
  });

  it('escapes strings the way Python\'s json.dumps(ensure_ascii=False) does', () => {
    expect(canonicalize({ s: 'a"b\\c\nd' })).toBe('{"s":"a\\"b\\\\c\\nd"}');
    expect(canonicalize({ s: 'café' })).toBe('{"s":"café"}');
  });
});

describe('E11 — the schema version is inside the hash', () => {
  it('changes every fingerprint when the version is bumped', () => {
    const v2 = clone(DEFAULT_TUNING_CONFIG) as unknown as { schemaVersion: number };
    v2.schemaVersion = 2;
    for (const mode of ['cascade', 'realtime'] as const) {
      expect(fingerprint(v2 as unknown as TuningConfig, mode)).not.toBe(fingerprint(DEFAULT_TUNING_CONFIG, mode));
    }
    expect(canonicalize(projectMode(v2 as unknown as TuningConfig, 'cascade'))).toContain('"schemaVersion":2');
  });

  it('ships schema version 1 as the current version', () => {
    expect(TUNING_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_TUNING_CONFIG.schemaVersion).toBe(1);
  });
});

describe('projectMode', () => {
  it('carries only the active mode\'s block, plus the shared client block and the mode itself', () => {
    const realtime = projectMode(DEFAULT_TUNING_CONFIG, 'realtime');
    expect(realtime.mode).toBe('realtime');
    expect(Object.keys(realtime).sort()).toEqual(['client', 'mode', 'realtime', 'schemaVersion']);

    const cascade = projectMode(DEFAULT_TUNING_CONFIG, 'cascade');
    expect(Object.keys(cascade).sort()).toEqual(['cascade', 'client', 'mode', 'schemaVersion']);
  });

  it('gives the same knobs in different modes different fingerprints', () => {
    expect(fingerprint(DEFAULT_TUNING_CONFIG, 'cascade')).not.toBe(fingerprint(DEFAULT_TUNING_CONFIG, 'realtime'));
  });
});

describe('diff', () => {
  it('lists the dotted path of every changed knob and nothing else', () => {
    const before = projectMode(DEFAULT_TUNING_CONFIG, 'cascade');
    const edited = clone(DEFAULT_TUNING_CONFIG);
    edited.cascade.deepgram.endpointingMs = 300;
    edited.client.rmsGate.enabled = true;
    expect(diff(before, projectMode(edited, 'cascade'))).toEqual([
      'client.rmsGate.enabled',
      'cascade.deepgram.endpointingMs',
    ]);
  });

  it('counts a key going from absent to present as a change', () => {
    const before = projectMode(DEFAULT_TUNING_CONFIG, 'realtime');
    const edited = clone(DEFAULT_TUNING_CONFIG);
    edited.realtime.turnDetection.threshold = 0.6;
    expect(diff(before, projectMode(edited, 'realtime'))).toEqual(['realtime.turnDetection.threshold']);
    expect(diff(projectMode(edited, 'realtime'), before)).toEqual(['realtime.turnDetection.threshold']);
  });

  it('is empty for two equal documents', () => {
    expect(diff(projectMode(DEFAULT_TUNING_CONFIG, 'cascade'), projectMode(clone(DEFAULT_TUNING_CONFIG), 'cascade'))).toEqual(
      [],
    );
  });
});

describe('clampGateParams', () => {
  it('clamps every parameter into its documented range', () => {
    const clamped = clampGateParams({
      enabled: true,
      thresholdDbfs: -200,
      holdMs: 99_999,
      attackMs: -5,
      releaseMs: 99_999,
      attenuationDb: 900,
      fullMute: true,
    });
    expect(clamped).toEqual({
      enabled: true,
      thresholdDbfs: -80,
      holdMs: 2000,
      attackMs: 0,
      releaseMs: 2000,
      attenuationDb: 60,
      fullMute: true,
    });
  });

  it('snaps to the documented step so the hashed value is the value that runs', () => {
    const clamped = clampGateParams({ ...DEFAULT_TUNING_CONFIG.client.rmsGate, holdMs: 204, releaseMs: 76 });
    expect(clamped.holdMs).toBe(200);
    expect(clamped.releaseMs).toBe(80);
  });

  it('leaves an already-valid gate untouched', () => {
    expect(clampGateParams(DEFAULT_TUNING_CONFIG.client.rmsGate)).toEqual(DEFAULT_TUNING_CONFIG.client.rmsGate);
  });
});

// The import/migration fixtures (ticket 03).
const ALLOW_LISTS: ImportAllowLists = {
  realtimeModels: ['gpt-realtime', 'gpt-realtime-mini'],
  realtimeVoices: ['alloy', 'marin'],
  deepgramModels: ['nova-3', 'nova-2'],
  textModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'],
  elevenLabsVoices: [{ id: '21m00Tcm4TlvDq8ikWAM' }, { id: 'ErXwobaYiN019PkySvjV' }],
};

/** Deliberately *not* the client fallback: two knobs differ from it. */
function serverDefaults(): TuningConfig {
  const defaults = clone(DEFAULT_TUNING_CONFIG);
  defaults.cascade.deepgram.endpointingMs = 300;
  defaults.cascade.translationModel = 'gpt-4.1-mini';
  return defaults;
}

function importOf(document: unknown) {
  const result = parseImported(JSON.stringify(document), ALLOW_LISTS, serverDefaults());
  if (!result.ok) throw new Error(`expected a successful import, got: ${result.error}`);
  return result;
}

describe('parseImported', () => {
  it('S12 — round-trips an exported document to an identical config and fingerprint', () => {
    const exported = clone(DEFAULT_TUNING_CONFIG);
    exported.cascade.deepgram.endpointingMs = 800;
    exported.realtime.turnDetection.silenceDurationMs = 800;
    exported.client.rmsGate.enabled = true;

    const { config, warnings } = importOf(exported);

    expect(warnings).toEqual([]);
    expect(config).toEqual(exported);
    expect(fingerprint(config, 'cascade')).toBe(fingerprint(exported, 'cascade'));
    expect(fingerprint(config, 'realtime')).toBe(fingerprint(exported, 'realtime'));
  });

  it('keeps an absent optional key absent when the document carries its block', () => {
    const { config } = importOf(clone(DEFAULT_TUNING_CONFIG));

    // Absent means "omit the key from the provider payload", so filling it in
    // from the defaults would change what gets sent.
    expect('threshold' in config.realtime.turnDetection).toBe(false);
    expect('noiseReduction' in config.realtime).toBe(false);
  });

  it('F10 — rejects malformed JSON, a non-object, and a schemaVersion it cannot read', () => {
    for (const text of ['{not json', '"a string"', '[]', 'null']) {
      expect(parseImported(text, ALLOW_LISTS, serverDefaults())).toEqual({
        ok: false,
        error: "That file isn't a valid tuning config.",
      });
    }
    const wrongVersion = JSON.stringify({ ...clone(DEFAULT_TUNING_CONFIG), schemaVersion: 2 });
    expect(parseImported(wrongVersion, ALLOW_LISTS, serverDefaults())).toEqual({
      ok: false,
      error: "That file isn't a valid tuning config.",
    });
  });

  it('F11 — imports the known keys and names the unknown ones it dropped', () => {
    const document = clone(DEFAULT_TUNING_CONFIG) as unknown as Record<string, unknown>;
    document.futureKnob = 'nope';
    (document.cascade as Record<string, unknown>).warpDrive = true;
    (document.realtime as Record<string, unknown>).voice = 'marin';

    const { config, warnings } = importOf(document);

    expect(warnings).toEqual(['Imported. Ignored 2 unknown field(s): cascade.warpDrive, futureKnob.']);
    expect(config.realtime.voice).toBe('marin');
    expect('futureKnob' in config).toBe(false);
    expect('warpDrive' in config.cascade).toBe(false);
  });

  it('F12 — falls back to the picker default when an id has left the allow-list', () => {
    const document = clone(DEFAULT_TUNING_CONFIG);
    document.realtime.model = 'gpt-realtime-2024';
    document.cascade.translationModel = 'gpt-3.5-turbo';

    const { config, warnings } = importOf(document);

    expect(warnings).toEqual([
      'gpt-realtime-2024 is no longer available — using gpt-realtime.',
      'gpt-3.5-turbo is no longer available — using gpt-4.1-mini.',
    ]);
    expect(config.realtime.model).toBe('gpt-realtime');
    // The *server's* default for that picker, not the client's fallback copy.
    expect(config.cascade.translationModel).toBe('gpt-4.1-mini');
  });

  it('fills a key the document is missing from the server defaults', () => {
    const partial = { schemaVersion: 1, cascade: { deepgram: { utteranceEndMs: 2000 } } };

    const { config } = importOf(partial);

    expect(config.cascade.deepgram.utteranceEndMs).toBe(2000);
    expect(config.cascade.deepgram.endpointingMs).toBe(300);
    expect(config.client).toEqual(DEFAULT_TUNING_CONFIG.client);
  });

  it('accepts a mode-scoped document without calling `mode` an unknown field', () => {
    const document = projectMode(clone(DEFAULT_TUNING_CONFIG), 'cascade');

    const { config, warnings } = importOf(document);

    expect(warnings).toEqual([]);
    expect(config.cascade).toEqual(DEFAULT_TUNING_CONFIG.cascade);
    expect(config.realtime).toEqual(serverDefaults().realtime);
  });

  it('clamps and step-quantises an out-of-range number rather than importing it', () => {
    const document = clone(DEFAULT_TUNING_CONFIG);
    document.cascade.deepgram.endpointingMs = 99_999;
    document.client.rnnoise.voiceProbThreshold = 0.37;

    const { config } = importOf(document);

    expect(config.cascade.deepgram.endpointingMs).toBe(5000);
    expect(config.client.rnnoise.voiceProbThreshold).toBe(0.35);
  });

  it('keeps the server default when a knob arrives with the wrong JSON type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const document = clone(DEFAULT_TUNING_CONFIG) as unknown as Record<string, Record<string, Record<string, unknown>>>;
    document.cascade.deepgram.diarize = 'yes please';

    const { config } = importOf(document);

    expect(config.cascade.deepgram.diarize).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('migrate', () => {
  it('discards a stored document with a missing or unsupported schemaVersion', () => {
    expect(migrate({ ...clone(DEFAULT_TUNING_CONFIG), schemaVersion: 2 })).toBeNull();
    expect(migrate({ cascade: {} })).toBeNull();
    expect(migrate(null)).toBeNull();
    expect(migrate('{}')).toBeNull();
  });

  it('completes a stored document against the server defaults', () => {
    const stored = { schemaVersion: 1, cascade: { segmentation: { mode: 'llm_priority' } } };

    const config = migrate(stored, serverDefaults());

    expect(config?.cascade.segmentation.mode).toBe('llm_priority');
    expect(config?.cascade.deepgram.endpointingMs).toBe(300);
  });

  it('applies the retired-id fallback to stored state, logging it rather than showing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stored = clone(DEFAULT_TUNING_CONFIG);
    stored.cascade.deepgram.model = 'nova-1';

    const config = migrate(stored, serverDefaults(), ALLOW_LISTS);

    expect(config?.cascade.deepgram.model).toBe('nova-3');
    expect(warn).toHaveBeenCalledWith('nova-1 is no longer available — using nova-3.');
    warn.mockRestore();
  });

  it('leaves ids alone when no allow-list is supplied', () => {
    const stored = clone(DEFAULT_TUNING_CONFIG);
    stored.cascade.deepgram.model = 'nova-1';

    expect(migrate(stored, serverDefaults())?.cascade.deepgram.model).toBe('nova-1');
  });
});
