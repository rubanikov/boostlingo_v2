import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeFetchRouter, defaultCapabilitiesBody, jsonResponse } from '../test/mockRealtimeApis';
import { TUNING_CAPABILITIES_ENDPOINT } from './tuningCapabilities';
import { DEFAULT_TUNING_CONFIG, fingerprint, projectMode, type ModeTuningConfig, type TuningMode } from './tuningConfig';
import { TUNING_PRESETS_KEY, TUNING_STATE_KEY } from './tuningPresets';
import { useTuningConfig, type ApplyResult } from './useTuningConfig';

/** A capabilities body whose `defaults` differ from the client-side fallback. */
function serverDefaults() {
  const defaults = structuredClone(DEFAULT_TUNING_CONFIG);
  defaults.cascade.deepgram.endpointingMs = 300;
  defaults.cascade.translationModel = 'gpt-4.1-mini';
  return defaults;
}

describe('useTuningConfig', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', createRealtimeFetchRouter());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts on the built-in defaults with no fingerprint while the capabilities request is in flight', () => {
    const { result } = renderHook(() => useTuningConfig('cascade'));

    expect(result.current.capabilitiesState).toBe('loading');
    expect(result.current.draft).toEqual(DEFAULT_TUNING_CONFIG);
    expect(result.current.pending).toEqual([]);
    // No chip text until we know whose defaults we are showing — a
    // wrong-then-corrected hash is worse than a skeleton.
    expect(result.current.activeFingerprint).toBeNull();
    expect(result.current.draftFingerprint).toBeNull();
  });

  it('adopts the server defaults into both draft and applied once capabilities land (S13)', async () => {
    const defaults = serverDefaults();
    vi.stubGlobal(
      'fetch',
      createRealtimeFetchRouter({
        capabilitiesResponse: jsonResponse({ ...defaultCapabilitiesBody(), defaults }),
      }),
    );
    const { result } = renderHook(() => useTuningConfig('cascade'));

    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));

    expect(result.current.draft.cascade.deepgram.endpointingMs).toBe(300);
    expect(result.current.applied.cascade).toEqual(projectMode(defaults, 'cascade'));
    expect(result.current.applied.realtime).toEqual(projectMode(defaults, 'realtime'));
    expect(result.current.pending).toEqual([]);
    expect(result.current.activeFingerprint).toBe(fingerprint(projectMode(defaults, 'cascade')));
    expect(result.current.lastAppliedAt).toBeInstanceOf(Date);
  });

  it('falls back to the built-in defaults and reports the fallback state when capabilities fail (F13)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      createRealtimeFetchRouter({
        capabilitiesResponse: { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' },
      }),
    );
    const { result } = renderHook(() => useTuningConfig('cascade'));

    await waitFor(() => expect(result.current.capabilitiesState).toBe('fallback'));

    expect(result.current.capabilities).toBeNull();
    expect(result.current.draft).toEqual(DEFAULT_TUNING_CONFIG);
    expect(result.current.activeFingerprint).toBe(fingerprint(projectMode(DEFAULT_TUNING_CONFIG, 'cascade')));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('setKnob marks exactly the edited path pending and leaves the applied config alone', async () => {
    const { result } = renderHook(() => useTuningConfig('cascade'));
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));
    const appliedBefore = result.current.activeFingerprint;

    act(() => result.current.setKnob('cascade.transcriptCheck.mode', 'flag'));

    expect(result.current.pending).toEqual(['cascade.transcriptCheck.mode']);
    expect(result.current.draft.cascade.transcriptCheck.mode).toBe('flag');
    expect(result.current.applied.cascade).toEqual(projectMode(DEFAULT_TUNING_CONFIG, 'cascade'));
    expect(result.current.activeFingerprint).toBe(appliedBefore);
    expect(result.current.draftFingerprint).not.toBe(appliedBefore);
  });

  it('scopes pending to the active mode: a Cascade edit is invisible to Realtime (S14)', async () => {
    const { result, rerender } = renderHook(({ mode }: { mode: TuningMode }) => useTuningConfig(mode), {
      initialProps: { mode: 'cascade' } as { mode: TuningMode },
    });
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));

    act(() => result.current.setKnob('cascade.transcriptCheck.mode', 'correct'));
    expect(result.current.pending).toEqual(['cascade.transcriptCheck.mode']);

    rerender({ mode: 'realtime' });

    expect(result.current.pending).toEqual([]);
    expect(result.current.draft.realtime.transcriptCheck.mode).toBe('off');

    // ...and it is still there when you come back. Nothing is discarded by a
    // mode switch (Step 5 gate outcome 1).
    rerender({ mode: 'cascade' });
    expect(result.current.pending).toEqual(['cascade.transcriptCheck.mode']);
  });

  it('setProviderDefault removes the key entirely, and restores the provider\'s documented value when unchecked', async () => {
    const { result } = renderHook(() => useTuningConfig('realtime'));
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));

    expect(result.current.draft.realtime.turnDetection.threshold).toBeUndefined();

    act(() => result.current.setProviderDefault('realtime.turnDetection.threshold', false));
    expect(result.current.draft.realtime.turnDetection.threshold).toBe(0.5);
    expect(result.current.pending).toEqual(['realtime.turnDetection.threshold']);

    act(() => result.current.setProviderDefault('realtime.turnDetection.threshold', true));
    // Absent, not `undefined`-valued: the key must not reach the payload or the hash.
    expect('threshold' in result.current.draft.realtime.turnDetection).toBe(false);
    expect(result.current.pending).toEqual([]);
  });

  it('apply() while disconnected commits the draft locally, clears pending and stamps a new fingerprint (E5)', async () => {
    const { result } = renderHook(() => useTuningConfig('cascade'));
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));
    const before = result.current.activeFingerprint;

    act(() => result.current.setKnob('cascade.deepgram.endpointingMs', 300));
    const draftFingerprint = result.current.draftFingerprint;

    await act(async () => {
      await result.current.apply();
    });

    expect(result.current.pending).toEqual([]);
    expect(result.current.applied.cascade).toEqual(projectMode(result.current.draft, 'cascade'));
    expect(result.current.activeFingerprint).toBe(draftFingerprint);
    expect(result.current.activeFingerprint).not.toBe(before);
    expect(result.current.applyState).toBe('idle');
  });

  it('apply() commits only the active mode: Realtime\'s unapplied edits are untouched by a Cascade apply', async () => {
    const { result, rerender } = renderHook(({ mode }: { mode: TuningMode }) => useTuningConfig(mode), {
      initialProps: { mode: 'realtime' } as { mode: TuningMode },
    });
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));

    act(() => result.current.setKnob('realtime.voice', 'marin'));
    rerender({ mode: 'cascade' });
    act(() => result.current.setKnob('cascade.translationModel', 'gpt-4.1-nano'));

    await act(async () => {
      await result.current.apply();
    });

    expect(result.current.applied.cascade.mode).toBe('cascade');
    expect(result.current.pending).toEqual([]);
    rerender({ mode: 'realtime' });
    expect(result.current.pending).toEqual(['realtime.voice']);
  });

  it('apply(applyTuning) hands the transport the projected mode document and commits when it succeeds', async () => {
    const { result } = renderHook(() => useTuningConfig('cascade'));
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));
    act(() => result.current.setKnob('cascade.deepgram.model', 'nova-2'));

    let seen: ModeTuningConfig | null = null;
    const applyTuning = vi.fn(async (config: ModeTuningConfig): Promise<ApplyResult> => {
      seen = config;
      return { ok: true, fingerprint: 'cfg:deadbeef', reconnectedStt: true, deferred: false };
    });

    await act(async () => {
      await result.current.apply(applyTuning);
    });

    expect(applyTuning).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(projectMode(result.current.draft, 'cascade'));
    expect(result.current.pending).toEqual([]);
    expect(result.current.applyState).toBe('idle');
  });

  it('apply(applyTuning) failing leaves the applied config alone and raises the failure state for the dialog', async () => {
    const { result } = renderHook(() => useTuningConfig('cascade'));
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));
    act(() => result.current.setKnob('cascade.deepgram.model', 'nova-2'));
    const before = result.current.activeFingerprint;

    const applyTuning = vi.fn(
      async (): Promise<ApplyResult> => ({
        ok: false,
        fingerprint: before ?? '',
        attempt: 3,
        maxAttempts: 3,
        message: 'The connection to the provider was lost.',
      }),
    );

    await act(async () => {
      await result.current.apply(applyTuning);
    });

    expect(result.current.applyState).toBe('failed');
    expect(result.current.attempt).toBe(3);
    expect(result.current.activeFingerprint).toBe(before);
    expect(result.current.pending).toEqual(['cascade.deepgram.model']);
  });

  /**
   * Ticket 07. The states a live Cascade apply can be in, and the one that
   * blocks: only an exhausted retry budget is a decision the user has to make.
   */
  describe('connection-level apply states', () => {
    /** An apply whose promise the test settles by hand, so mid-flight state is observable. */
    function pausedTransport() {
      let settle: (result: ApplyResult) => void = () => {};
      const applyTuning = vi.fn(
        () =>
          new Promise<ApplyResult>((resolve) => {
            settle = resolve;
          }),
      );
      return { applyTuning, settle: (result: ApplyResult) => settle(result) };
    }

    async function mounted(mode: TuningMode = 'cascade') {
      const rendered = renderHook(() => useTuningConfig(mode));
      await waitFor(() => expect(rendered.result.current.capabilitiesState).toBe('ready'));
      return rendered.result;
    }

    it('reports "reconnecting" while a Deepgram connection-level apply is in flight', async () => {
      const result = await mounted();
      const transport = pausedTransport();
      act(() => result.current.setKnob('cascade.deepgram.endpointingMs', 300));

      act(() => {
        void result.current.apply(transport.applyTuning);
      });

      expect(result.current.applyState).toBe('reconnecting');
      expect(result.current.attempt).toBe(1);
      expect(result.current.maxAttempts).toBe(3);

      await act(async () => {
        transport.settle({ ok: true, fingerprint: 'cfg:1234abcd', reconnectedStt: true, deferred: false });
      });
      expect(result.current.applyState).toBe('idle');
    });

    it('reports plain "applying" for a change that costs no reconnect', async () => {
      const result = await mounted();
      const transport = pausedTransport();
      act(() => result.current.setKnob('cascade.segmentation.mode', 'llm_priority'));

      act(() => {
        void result.current.apply(transport.applyTuning);
      });

      expect(result.current.applyState).toBe('applying');

      await act(async () => {
        transport.settle({ ok: true, fingerprint: 'cfg:1234abcd', reconnectedStt: false, deferred: false });
      });
      expect(result.current.applyState).toBe('idle');
    });

    it('E1 — a deferred apply commits the draft and stays marked deferred until the server confirms it', async () => {
      const result = await mounted();
      act(() => result.current.setKnob('cascade.deepgram.endpointingMs', 300));

      await act(async () => {
        await result.current.apply(async () => ({
          ok: true,
          fingerprint: 'cfg:1234abcd',
          reconnectedStt: false,
          deferred: true,
        }));
      });

      // The transport holds the latest config in one slot and will send exactly
      // it, so showing it as applied is true — it just isn't on the wire yet.
      expect(result.current.applyState).toBe('deferred');
      expect(result.current.pending).toEqual([]);
      expect(result.current.draft.cascade.deepgram.endpointingMs).toBe(300);
      expect(result.current.applied.cascade).toEqual(projectMode(result.current.draft, 'cascade'));

      act(() => result.current.clearDeferred());
      expect(result.current.applyState).toBe('idle');
    });

    it('F7 — an exhausted retry budget raises the blocking failure state and keeps the change pending', async () => {
      const result = await mounted();
      act(() => result.current.setKnob('cascade.deepgram.endpointingMs', 300));
      const before = result.current.activeFingerprint;

      await act(async () => {
        await result.current.apply(async () => ({
          ok: false,
          fingerprint: before ?? '',
          attempt: 3,
          maxAttempts: 3,
          message: 'The connection to the provider was lost.',
        }));
      });

      expect(result.current.applyState).toBe('failed');
      expect(result.current.attempt).toBe(3);
      expect(result.current.maxAttempts).toBe(3);
      expect(result.current.activeFingerprint).toBe(before);
      expect(result.current.pending).toEqual(['cascade.deepgram.endpointingMs']);
    });

    it('does not open the dialog for a failure that arrives before the budget is spent', async () => {
      const result = await mounted();
      act(() => result.current.setKnob('cascade.deepgram.endpointingMs', 300));

      await act(async () => {
        await result.current.apply(async () => ({
          ok: false,
          fingerprint: 'cfg:00000000',
          attempt: 1,
          maxAttempts: 3,
          message: 'The session ended before the new settings were applied.',
        }));
      });

      // The session ending is its own loud UI state; a modal on top of it would
      // be asking the user to choose between two configs of a session that is
      // already gone.
      expect(result.current.applyState).toBe('idle');
      expect(result.current.pending).toEqual(['cascade.deepgram.endpointingMs']);
    });

    it('F7 — Retry re-sends the same draft, and Revert to previous puts the panel back on the applied config', async () => {
      const result = await mounted();
      const applyTuning = vi.fn(
        async (_config: ModeTuningConfig): Promise<ApplyResult> => ({
          ok: false,
          fingerprint: 'cfg:00000000',
          attempt: 3,
          maxAttempts: 3,
          message: 'The connection to the provider was lost.',
        }),
      );
      act(() => result.current.setKnob('cascade.deepgram.endpointingMs', 300));

      await act(async () => {
        await result.current.apply(applyTuning);
      });
      // Retry is the same action as Apply — the draft has not moved, so the
      // second call carries a byte-identical document.
      await act(async () => {
        await result.current.apply(applyTuning);
      });

      expect(applyTuning).toHaveBeenCalledTimes(2);
      expect(applyTuning.mock.calls[1][0]).toEqual(applyTuning.mock.calls[0][0]);
      expect(result.current.applyState).toBe('failed');

      act(() => result.current.revert());

      expect(result.current.draft.cascade.deepgram.endpointingMs).toBe(500);
      expect(result.current.pending).toEqual([]);
      expect(result.current.applyState).toBe('idle');
    });
  });

  it('revert() puts the draft back to the applied config and clears the failure state', async () => {
    const { result } = renderHook(() => useTuningConfig('cascade'));
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));

    act(() => result.current.setKnob('cascade.transcriptCheck.mode', 'flag'));
    const applyTuning = vi.fn(
      async (): Promise<ApplyResult> => ({ ok: false, fingerprint: 'cfg:00000000', attempt: 3, maxAttempts: 3, message: 'nope' }),
    );
    await act(async () => {
      await result.current.apply(applyTuning);
    });
    expect(result.current.applyState).toBe('failed');

    act(() => result.current.revert());

    expect(result.current.pending).toEqual([]);
    expect(result.current.draft.cascade.transcriptCheck.mode).toBe('off');
    expect(result.current.applyState).toBe('idle');
  });
});

/**
 * Ticket 03. `renderHook` twice with the same `window.localStorage` is the
 * simulated reload: the second mount is a browser that has been closed and
 * reopened, and it must come back to the same knobs.
 */
describe('useTuningConfig — persistence, presets, import/export', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', createRealtimeFetchRouter());
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  async function mount(mode: TuningMode = 'cascade') {
    const rendered = renderHook(() => useTuningConfig(mode));
    await waitFor(() => expect(rendered.result.current.capabilitiesState).not.toBe('loading'));
    return rendered;
  }

  it('S10 — the draft and the applied config survive a reload, and nothing goes to a server', async () => {
    const first = await mount();
    act(() => first.result.current.setKnob('cascade.deepgram.endpointingMs', 800));
    await act(async () => {
      await first.result.current.apply();
    });
    act(() => first.result.current.setKnob('cascade.translationModel', 'gpt-4.1-nano'));
    const draftBefore = first.result.current.draft;
    const appliedBefore = first.result.current.applied;
    first.unmount();

    const second = await mount();

    expect(second.result.current.draft).toEqual(draftBefore);
    expect(second.result.current.applied).toEqual(appliedBefore);
    expect(second.result.current.pending).toEqual(['cascade.translationModel']);
    expect(second.result.current.activeFingerprint).toBe(fingerprint(appliedBefore.cascade));

    // Config is client-only (story AC 1.8): the capabilities read is the only
    // request either mount made, and nothing was ever written back.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    for (const [url, init] of fetchMock.mock.calls as [string, RequestInit | undefined][]) {
      expect(url).toBe(TUNING_CAPABILITIES_ENDPOINT);
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });

  it('S10 — stores under the two documented keys and nothing about the panel being open', async () => {
    const { result } = await mount();
    act(() => result.current.setKnob('cascade.translationModel', 'gpt-4.1-nano'));
    act(() => result.current.savePresetAs('gate-only'));

    expect(Object.keys(window.localStorage).sort()).toEqual([TUNING_PRESETS_KEY, TUNING_STATE_KEY].sort());
    // Builder decision 8: the panel opens closed, every time.
    expect(window.localStorage.getItem(TUNING_STATE_KEY)).not.toMatch(/open/i);
  });

  it('falls back to the server defaults when the stored entry is from another schema version', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.localStorage.setItem(
      TUNING_STATE_KEY,
      JSON.stringify({ schemaVersion: 2, draft: { ...DEFAULT_TUNING_CONFIG, schemaVersion: 2 }, applied: null }),
    );

    const { result } = await mount();

    expect(result.current.draft).toEqual(DEFAULT_TUNING_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsupported schemaVersion 2'));
    warn.mockRestore();
  });

  it('fills a knob the stored draft is missing from the *server* defaults, not the client fallback', async () => {
    const defaults = serverDefaults();
    vi.stubGlobal(
      'fetch',
      createRealtimeFetchRouter({ capabilitiesResponse: jsonResponse({ ...defaultCapabilitiesBody(), defaults }) }),
    );
    const stored = structuredClone(DEFAULT_TUNING_CONFIG) as unknown as Record<string, Record<string, unknown>>;
    delete stored.cascade.endpointingMs;
    delete (stored.cascade.deepgram as Record<string, unknown>).endpointingMs;
    window.localStorage.setItem(TUNING_STATE_KEY, JSON.stringify({ schemaVersion: 1, draft: stored, applied: null }));

    const { result } = await mount();

    expect(result.current.draft.cascade.deepgram.endpointingMs).toBe(300);
  });

  it('S11 — every built-in preset sets the whole document in one action, without applying it', async () => {
    const { result } = await mount();
    const appliedBefore = result.current.applied;

    expect(result.current.presets.map((preset) => preset.name)).toEqual([
      'Provider defaults',
      'Tuned turn-taking',
      'Max denoise',
    ]);

    for (const preset of result.current.presets) {
      act(() => result.current.applyPreset(preset.name));

      expect(result.current.draft).toEqual(preset.config);
      expect(result.current.selectedPreset).toBe(preset.name);
      expect(result.current.presetModified).toBe(false);
      // A preset is something to look at and then Apply — never a live change.
      expect(result.current.applied).toEqual(appliedBefore);
    }
  });

  it('S11 — "Tuned turn-taking" leaves both modes pending in one action', async () => {
    const { result } = await mount('realtime');

    act(() => result.current.applyPreset('Tuned turn-taking'));

    expect(result.current.pending).toEqual([
      'realtime.turnDetection.silenceDurationMs',
      'realtime.turnDetection.prefixPaddingMs',
      'realtime.turnDetection.interruptResponse',
    ]);
    expect(result.current.draft.cascade.deepgram.endpointingMs).toBe(800);
  });

  it('E13 — "Max denoise" produces a valid config with a fingerprint of its own', async () => {
    const { result } = await mount();
    const before = result.current.draftFingerprint;

    act(() => result.current.applyPreset('Max denoise'));

    expect(result.current.draft.client.rnnoise.enabled).toBe(true);
    expect(result.current.draft.cascade.denoise.deepfilternet.enabled).toBe(true);
    expect(result.current.draftFingerprint).not.toBe(before);
    expect(result.current.draftFingerprint).toMatch(/^cfg:[0-9a-f]{8}$/);
  });

  it('marks a preset modified once a knob diverges, keeping the name', async () => {
    const { result } = await mount();
    act(() => result.current.applyPreset('Max denoise'));

    act(() => result.current.setKnob('client.rmsGate.thresholdDbfs', -50));

    // "Max denoise, but with the gate at −50" is the normal working state in a
    // lab, so the name stays and the marker appears (wireframe §4).
    expect(result.current.selectedPreset).toBe('Max denoise');
    expect(result.current.presetModified).toBe(true);
  });

  it('S11 — a user preset survives a reload and can be deleted again', async () => {
    const first = await mount();
    act(() => first.result.current.setKnob('cascade.deepgram.utteranceEndMs', 1500));
    act(() => first.result.current.savePresetAs('babble-5db-v3'));
    const saved = first.result.current.draft;
    first.unmount();

    const second = await mount();
    expect(second.result.current.presets.map((preset) => preset.name)).toContain('babble-5db-v3');

    act(() => second.result.current.resetToDefaults());
    act(() => second.result.current.applyPreset('babble-5db-v3'));
    expect(second.result.current.draft).toEqual(saved);

    act(() => second.result.current.deletePreset('babble-5db-v3'));
    expect(second.result.current.presets.map((preset) => preset.name)).not.toContain('babble-5db-v3');
    expect(second.result.current.selectedPreset).toBeNull();
  });

  it('refuses to save a preset over a built-in name or with no name at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await mount();

    act(() => result.current.savePresetAs('Max denoise'));
    act(() => result.current.savePresetAs('   '));

    expect(result.current.presets).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('S12 — export → import round-trips to an identical config and fingerprint', async () => {
    const first = await mount();
    act(() => first.result.current.applyPreset('Max denoise'));
    act(() => first.result.current.setKnob('cascade.deepgram.endpointingMs', 250));
    const exported = first.result.current.exportConfig();
    const originalDraft = first.result.current.draft;
    const originalFingerprint = first.result.current.draftFingerprint;
    first.unmount();
    window.localStorage.clear();

    const second = await mount();
    let outcome = { ok: false, message: '' };
    act(() => {
      outcome = second.result.current.importConfig(exported);
    });

    expect(outcome).toEqual({ ok: true, message: 'Imported.' });
    expect(second.result.current.draft).toEqual(originalDraft);
    expect(second.result.current.draftFingerprint).toBe(originalFingerprint);
    expect(second.result.current.selectedPreset).toBeNull();
  });

  it('exports the whole document, pretty-printed, with absent keys still absent', async () => {
    const { result } = await mount('realtime');

    const exported = JSON.parse(result.current.exportConfig()) as Record<string, unknown>;

    expect(result.current.exportConfig()).toContain('\n  "schemaVersion": 1');
    expect(Object.keys(exported).sort()).toEqual(['cascade', 'client', 'realtime', 'schemaVersion']);
    expect('noiseReduction' in (exported.realtime as Record<string, unknown>)).toBe(false);
  });

  it('F10 — malformed JSON leaves the draft untouched and reports it inline', async () => {
    const { result } = await mount();
    act(() => result.current.setKnob('cascade.translationModel', 'gpt-4.1-nano'));
    const draftBefore = result.current.draft;

    let outcome = { ok: true, message: '' };
    act(() => {
      outcome = result.current.importConfig('{ not a config');
    });

    expect(outcome).toEqual({ ok: false, message: "That file isn't a valid tuning config." });
    expect(result.current.importMessage).toBe("That file isn't a valid tuning config.");
    expect(result.current.draft).toEqual(draftBefore);
  });

  it('F11 — unknown keys are dropped, the known ones land, and the message names them', async () => {
    const { result } = await mount();
    const document = structuredClone(DEFAULT_TUNING_CONFIG) as unknown as Record<string, unknown>;
    document.somethingNew = 42;
    (document.cascade as Record<string, unknown>).translationModel = 'gpt-4.1-nano';

    act(() => {
      result.current.importConfig(JSON.stringify(document));
    });

    expect(result.current.importMessage).toBe('Imported. Ignored 1 unknown field(s): somethingNew.');
    expect(result.current.draft.cascade.translationModel).toBe('gpt-4.1-nano');
  });

  it('F12 — a retired model id falls back to the picker default and says so', async () => {
    const { result } = await mount();
    const document = structuredClone(DEFAULT_TUNING_CONFIG);
    document.cascade.deepgram.model = 'nova-1';

    act(() => {
      result.current.importConfig(JSON.stringify(document));
    });

    expect(result.current.importMessage).toBe('nova-1 is no longer available — using nova-3.');
    expect(result.current.draft.cascade.deepgram.model).toBe('nova-3');
  });

  it('resetToDefaults restores the server defaults and claims no preset', async () => {
    const defaults = serverDefaults();
    vi.stubGlobal(
      'fetch',
      createRealtimeFetchRouter({ capabilitiesResponse: jsonResponse({ ...defaultCapabilitiesBody(), defaults }) }),
    );
    const { result } = await mount();
    act(() => result.current.applyPreset('Max denoise'));

    act(() => result.current.resetToDefaults());

    expect(result.current.draft).toEqual(defaults);
    // The *server's* defaults, which is a different claim from "the Provider
    // defaults preset is selected".
    expect(result.current.selectedPreset).toBeNull();
    expect(result.current.presetModified).toBe(false);
  });
});

/**
 * The race ticket 10's capture harness hit: `/api/tuning/capabilities` is slow
 * enough that a config can be imported and applied before it answers, and the
 * hydration that follows used to overwrite both documents with the server's
 * defaults — silently running a benchmark on knobs nobody set.
 */
describe('useTuningConfig — late capabilities hydration', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  /** Capabilities that stay in flight until the returned `release()` is called. */
  function heldCapabilities(defaults = serverDefaults()) {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url !== TUNING_CAPABILITIES_ENDPOINT) throw new Error(`Unexpected fetch to ${url}`);
        await held;
        return jsonResponse({ ...defaultCapabilitiesBody(), defaults });
      }),
    );
    return { release };
  }

  it('keeps a config imported before capabilities land, and its fingerprint (ticket 10 race)', async () => {
    const { release } = heldCapabilities();
    const imported = structuredClone(DEFAULT_TUNING_CONFIG);
    imported.cascade.deepgram.endpointingMs = 900;
    imported.client.microphone.echoCancellation = false;

    const { result } = renderHook(() => useTuningConfig('cascade'));
    expect(result.current.capabilitiesState).toBe('loading');

    act(() => {
      result.current.importConfig(JSON.stringify(imported));
    });
    await act(async () => {
      await result.current.apply();
    });

    await act(async () => {
      release();
    });
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));

    // The server's own default for this knob is 300; the imported document
    // asked for 900, and it is what the next connect() must carry.
    expect(result.current.draft.cascade.deepgram.endpointingMs).toBe(900);
    expect(result.current.draft.client.microphone.echoCancellation).toBe(false);
    expect(result.current.applied.cascade).toEqual(projectMode(imported, 'cascade'));
    expect(result.current.activeFingerprint).toBe(fingerprint(projectMode(imported, 'cascade')));
    expect(result.current.pending).toEqual([]);
    // The response is not discarded — only the documents it would have
    // overwritten are: the allow-lists and stage availability still land.
    expect(result.current.capabilities?.stages.deepfilternet.installed).toBe(false);
  });

  it('keeps a knob turned before capabilities land, still pending against the config it was turned on', async () => {
    const { release } = heldCapabilities();

    const { result } = renderHook(() => useTuningConfig('cascade'));
    act(() => result.current.setKnob('cascade.translationModel', 'gpt-4.1-nano'));

    await act(async () => {
      release();
    });
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));

    expect(result.current.draft.cascade.translationModel).toBe('gpt-4.1-nano');
    expect(result.current.pending).toEqual(['cascade.translationModel']);
    // Untouched knobs are still the ones the panel started on, not the server's
    // — the whole draft is the user's now.
    expect(result.current.draft.cascade.deepgram.endpointingMs).toBe(
      DEFAULT_TUNING_CONFIG.cascade.deepgram.endpointingMs,
    );
  });

  it('still adopts the server defaults when nothing has been touched', async () => {
    const defaults = serverDefaults();
    const { release } = heldCapabilities(defaults);

    const { result } = renderHook(() => useTuningConfig('cascade'));
    await act(async () => {
      release();
    });
    await waitFor(() => expect(result.current.capabilitiesState).toBe('ready'));

    expect(result.current.draft).toEqual(defaults);
    expect(result.current.applied.cascade).toEqual(projectMode(defaults, 'cascade'));
  });
});
