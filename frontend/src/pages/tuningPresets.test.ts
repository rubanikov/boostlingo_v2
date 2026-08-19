import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TUNING_CONFIG, fingerprint, projectMode, type ImportAllowLists, type TuningConfig } from './tuningConfig';
import {
  BUILT_IN_PRESETS,
  builtInPresets,
  isBuiltInPreset,
  loadPresets,
  loadTuningState,
  savePresets,
  saveTuningState,
  TUNING_PRESETS_KEY,
  TUNING_STATE_KEY,
} from './tuningPresets';

const ALLOW_LISTS: ImportAllowLists = {
  realtimeModels: ['gpt-realtime', 'gpt-realtime-mini'],
  realtimeVoices: ['alloy', 'marin'],
  deepgramModels: ['nova-3', 'nova-2'],
  textModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'],
  elevenLabsVoices: [{ id: '21m00Tcm4TlvDq8ikWAM' }, { id: 'ErXwobaYiN019PkySvjV' }],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A server whose `.env` differs from the client fallback in two places. */
function serverDefaults(): TuningConfig {
  const defaults = clone(DEFAULT_TUNING_CONFIG);
  defaults.cascade.deepgram.endpointingMs = 300;
  defaults.cascade.ttsVoiceA = 'ErXwobaYiN019PkySvjV';
  return defaults;
}

function presetNamed(name: string, defaults = serverDefaults()): TuningConfig {
  const preset = builtInPresets(defaults).find((candidate) => candidate.name === name);
  if (!preset) throw new Error(`no built-in preset called ${name}`);
  return preset.config;
}

describe('BUILT_IN_PRESETS', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('offers exactly the three the wireframe names, in order', () => {
    expect(BUILT_IN_PRESETS.map((preset) => preset.name)).toEqual([
      'Provider defaults',
      'Tuned turn-taking',
      'Max denoise',
    ]);
    expect(isBuiltInPreset('Max denoise')).toBe(true);
    expect(isBuiltInPreset('babble-5db-v3')).toBe(false);
  });

  it('resolves "Provider defaults" against the server defaults in force right now', () => {
    expect(presetNamed('Provider defaults')).toEqual(serverDefaults());
    expect(presetNamed('Provider defaults', DEFAULT_TUNING_CONFIG)).toEqual(DEFAULT_TUNING_CONFIG);
  });

  it('S11 — "Tuned turn-taking" sets both modes\' turn-taking knobs and touches nothing else', () => {
    const config = presetNamed('Tuned turn-taking');

    expect(config.realtime.turnDetection.silenceDurationMs).toBe(800);
    expect(config.realtime.turnDetection.prefixPaddingMs).toBe(300);
    expect(config.realtime.turnDetection.interruptResponse).toBe(false);
    expect(config.cascade.deepgram.endpointingMs).toBe(800);
    expect(config.cascade.deepgram.utteranceEndMs).toBe(3000);
    // Knobs the preset has no opinion about keep the *server's* value.
    expect(config.cascade.ttsVoiceA).toBe('ErXwobaYiN019PkySvjV');
  });

  it('E13 — "Max denoise" turns on every stage in the chain and hashes differently from the defaults', () => {
    const config = presetNamed('Max denoise');

    expect(config.client.microphone).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    expect(config.client.rmsGate.enabled).toBe(true);
    expect(config.client.rnnoise.enabled).toBe(true);
    expect(config.realtime.noiseReduction).toBe('far_field');
    // Recorded even though the panel keeps an uninstalled stage disabled: the
    // same file has to replay where the stage *is* installed.
    expect(config.cascade.denoise.noisereduce.enabled).toBe(true);
    expect(config.cascade.denoise.deepfilternet.enabled).toBe(true);

    for (const mode of ['cascade', 'realtime'] as const) {
      expect(fingerprint(config, mode)).not.toBe(fingerprint(serverDefaults(), mode));
    }
  });

  it('leaves the offline benchmark-only stages off — they are ignored by the live path', () => {
    expect(presetNamed('Max denoise').cascade.denoise.offline).toEqual({ demucs: false, dns64: false });
  });
});

describe('tuning state storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('S10 — round-trips the draft and both applied documents through localStorage', () => {
    const draft = clone(serverDefaults());
    draft.cascade.deepgram.endpointingMs = 800;
    draft.realtime.voice = 'marin';
    const applied = {
      cascade: projectMode(draft, 'cascade'),
      realtime: projectMode(serverDefaults(), 'realtime'),
    };

    saveTuningState({ draft, applied });
    const reloaded = loadTuningState(serverDefaults(), ALLOW_LISTS);

    expect(reloaded?.draft).toEqual(draft);
    expect(reloaded?.applied).toEqual(applied);
    expect(fingerprint(reloaded?.applied?.cascade ?? applied.cascade)).toBe(fingerprint(applied.cascade));
  });

  it('writes exactly one versioned entry, and nothing about the panel itself', () => {
    saveTuningState({ draft: serverDefaults(), applied: null });

    expect(Object.keys(window.localStorage)).toEqual([TUNING_STATE_KEY]);
    const stored = JSON.parse(window.localStorage.getItem(TUNING_STATE_KEY) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['applied', 'draft', 'schemaVersion']);
    expect(stored.schemaVersion).toBe(1);
  });

  it('returns null when nothing is stored', () => {
    expect(loadTuningState(serverDefaults(), ALLOW_LISTS)).toBeNull();
  });

  it('discards an entry from another schema version, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.localStorage.setItem(TUNING_STATE_KEY, JSON.stringify({ schemaVersion: 2, draft: serverDefaults(), applied: null }));

    expect(loadTuningState(serverDefaults(), ALLOW_LISTS)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsupported schemaVersion 2'));
    warn.mockRestore();
  });

  it('discards an unparseable entry rather than throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.localStorage.setItem(TUNING_STATE_KEY, '{ half a config');

    expect(loadTuningState(serverDefaults(), ALLOW_LISTS)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fills a knob the stored draft predates from the server defaults', () => {
    const stored = clone(serverDefaults()) as unknown as Record<string, Record<string, unknown>>;
    delete stored.cascade.translationModel;
    window.localStorage.setItem(TUNING_STATE_KEY, JSON.stringify({ schemaVersion: 1, draft: stored, applied: null }));

    const reloaded = loadTuningState(serverDefaults(), ALLOW_LISTS);

    expect(reloaded?.draft.cascade.translationModel).toBe(serverDefaults().cascade.translationModel);
    expect(reloaded?.applied).toBeNull();
  });

  it('F12 — repairs a retired id in the stored draft on the way in', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const draft = clone(serverDefaults());
    draft.realtime.voice = 'sage-retired';
    window.localStorage.setItem(TUNING_STATE_KEY, JSON.stringify({ schemaVersion: 1, draft, applied: null }));

    const reloaded = loadTuningState(serverDefaults(), ALLOW_LISTS);

    expect(reloaded?.draft.realtime.voice).toBe('alloy');
    expect(warn).toHaveBeenCalledWith('sage-retired is no longer available — using alloy.');
    warn.mockRestore();
  });
});

describe('user preset storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('S11 — a saved preset survives a reload', () => {
    const config = clone(serverDefaults());
    config.cascade.deepgram.endpointingMs = 120;

    savePresets([{ name: 'babble-5db-v3', config }]);

    expect(loadPresets(serverDefaults(), ALLOW_LISTS)).toEqual([{ name: 'babble-5db-v3', config }]);
    expect(Object.keys(window.localStorage)).toEqual([TUNING_PRESETS_KEY]);
  });

  it('reads an empty list when nothing has been saved', () => {
    expect(loadPresets(serverDefaults())).toEqual([]);
  });

  it('discards the whole entry when its schemaVersion is not this build\'s', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.localStorage.setItem(
      TUNING_PRESETS_KEY,
      JSON.stringify({ schemaVersion: 99, presets: [{ name: 'gate-only', config: serverDefaults() }] }),
    );

    expect(loadPresets(serverDefaults())).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops only the presets it cannot read, keeping the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = clone(serverDefaults());
    window.localStorage.setItem(
      TUNING_PRESETS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        presets: [
          { name: 'stale', config: { ...good, schemaVersion: 0 } },
          { name: 'good', config: good },
        ],
      }),
    );

    expect(loadPresets(serverDefaults(), ALLOW_LISTS).map((preset) => preset.name)).toEqual(['good']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale'));
    warn.mockRestore();
  });
});
