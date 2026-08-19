/**
 * The tuning panel's state (ticket 02): one editable `draft` document, a
 * per-mode `applied` document, and the derived diff between them.
 *
 * Why per-mode `applied` rather than one: pressing Apply in Cascade must not
 * commit Realtime's unapplied edits, and the fingerprint on screen has to be
 * the one the *current* mode's next `connect()` will use. `draft` stays a
 * single document (Cascade edits live in `draft.cascade`, Realtime's in
 * `draft.realtime`), which is what gives each mode its own draft for free and
 * lets one export round-trip both modes.
 *
 * Nothing here talks to a transport. `apply()` takes the transport as an
 * optional argument (`applyTuning`) so tickets 05/07 can pass
 * `session.applyTuning` in without this hook ever importing a session; with no
 * argument it commits locally, which is exactly the disconnected behaviour the
 * wireframe specifies (§4: Apply stays enabled while disconnected).
 *
 * Persistence (ticket 03) lives in `tuningPresets.ts`: this hook reads the
 * stored state once the capabilities response has settled — so a key the
 * stored document is missing is filled from the *server's* defaults rather
 * than the client's fallback copy — and writes on every draft/applied change.
 * Nothing is ever sent to a server (story AC 1.8, locked decision 10). That
 * read happens **once**, and only while the user has set nothing themselves:
 * a config imported or applied before the capabilities response arrives is the
 * newer document and survives it (ticket 10's race).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApplyResult, ApplyTuning } from './sessionHandle';
import { FALLBACK_ALLOW_LISTS, fetchCapabilities, type TuningCapabilities } from './tuningCapabilities';
import {
  canonicalize,
  DEEPGRAM_CONNECTION_LEVEL_PATHS,
  DEFAULT_TUNING_CONFIG,
  diff,
  fingerprint,
  migrate,
  parseImported,
  projectMode,
  type ImportAllowLists,
  type ModeTuningConfig,
  type TuningConfig,
  type TuningMode,
} from './tuningConfig';
import {
  builtInPresets,
  isBuiltInPreset,
  loadPresets,
  loadTuningState,
  savePresets,
  saveTuningState,
  type TuningPreset,
} from './tuningPresets';

/**
 * `'loading'` renders the skeleton stack; `'fallback'` means the capabilities
 * request failed, so the panel is showing `DEFAULT_TUNING_CONFIG` and knows
 * nothing about the server's optional denoise stages (they all render as
 * unavailable — wireframe §3 rule 5).
 */
export type CapabilitiesState = 'loading' | 'ready' | 'fallback';

/**
 * `'reconnecting'` is `'applying'` for a change the server can only make by
 * reopening the Deepgram socket (ticket 07) — same in-flight button, different
 * status copy, because the user needs to know why the transcript just paused.
 * `'deferred'` is an apply the transport accepted but has not sent yet: it is
 * waiting for the current reply to finish playing (Step 5 gate outcome 2).
 */
export type ApplyState = 'idle' | 'applying' | 'reconnecting' | 'deferred' | 'failed';

/**
 * What a transport reports back from a live apply, and the seam tickets 05/07
 * plug `session.applyTuning` into. Both now live on `SessionHandle` (ticket
 * 04), where the transports can see them; re-exported here because that is
 * where ticket 02's callers already import them from.
 */
export type { ApplyResult, ApplyTuning };

/** `_resilience.py`'s budget: 3 attempts, 0.5/1/2 s. Shown in the status line. */
export const APPLY_MAX_ATTEMPTS = 3;

/** The knobs whose change costs a Deepgram reconnect, as a set for lookups. */
const CONNECTION_LEVEL_PATHS = new Set<string>(DEEPGRAM_CONNECTION_LEVEL_PATHS);

/**
 * What unchecking "Provider default" seeds the input with. These are the
 * providers' own documented defaults, so the user is nudging a real number
 * rather than typing into a blank — and the moment the key exists it is sent,
 * which is the whole point of the distinction (wireframe §3 rule 1).
 */
export const PROVIDER_DEFAULT_SEEDS: Record<string, unknown> = {
  'realtime.turnDetection.threshold': 0.5,
  'realtime.turnDetection.prefixPaddingMs': 300,
  'realtime.turnDetection.silenceDurationMs': 500,
  'realtime.turnDetection.eagerness': 'auto',
  'realtime.turnDetection.interruptResponse': true,
  'realtime.noiseReduction': 'near_field',
};

export type AppliedByMode = Record<TuningMode, ModeTuningConfig>;

export interface TuningController {
  /** What the panel's controls show. Every edit writes here. */
  draft: TuningConfig;
  /** What each mode's next `connect()` (or running session) uses. */
  applied: AppliedByMode;
  /** Dotted paths that differ between `applied[mode]` and the projected draft. */
  pending: string[];
  capabilities: TuningCapabilities | null;
  capabilitiesState: CapabilitiesState;
  applyState: ApplyState;
  /** Which retry the in-flight/failed apply reached. 0 while idle. */
  attempt: number;
  /** The retry budget the last failure reported. `APPLY_MAX_ATTEMPTS` until one does. */
  maxAttempts: number;
  /** Browser-local, display-only: never persisted, sent, or hashed. */
  lastAppliedAt: Date | null;
  /** Fingerprint of `applied[mode]` — the chip. `null` until capabilities settle. */
  activeFingerprint: string | null;
  /** Fingerprint of the projected draft. Never shown as *the* config. */
  draftFingerprint: string | null;
  /** Built-in presets first, then the user's, in save order. */
  presets: TuningPreset[];
  /** The preset the draft was last loaded from. `null` after an import or reset. */
  selectedPreset: string | null;
  /** The draft has diverged from `selectedPreset` — "Max denoise, but…". */
  presetModified: boolean;
  /** Result of the last import, or of a repair made while loading storage. */
  importMessage: string | null;
  setKnob: (path: string, value: unknown) => void;
  /** `on` = "use the provider's default" = the key is omitted entirely. */
  setProviderDefault: (path: string, on: boolean) => void;
  apply: (applyTuning?: ApplyTuning) => Promise<ApplyResult>;
  /**
   * Drops the `'deferred'` marker. Called once the transport confirms the queued
   * apply actually reached the server (its `appliedFingerprint` moves) — the
   * panel owns that signal, since the fingerprint is a prop it already has.
   */
  clearDeferred: () => void;
  /**
   * Puts the draft back to the applied config. Spelled **Revert to previous** in
   * the failure dialog (wireframe §4: "the same action … because it is doing
   * something stronger"), so there is deliberately one implementation.
   */
  revert: () => void;
  /** Sets every knob of both modes in one action. Does **not** apply to the session. */
  applyPreset: (name: string) => void;
  savePresetAs: (name: string) => void;
  /** User presets only; the built-ins are code, not data. */
  deletePreset: (name: string) => void;
  /** The whole draft document, pretty-printed — what Export writes and copies. */
  exportConfig: () => string;
  importConfig: (text: string) => { ok: boolean; message: string };
  /** The **server** defaults, not the `Provider defaults` preset. */
  resetToDefaults: () => void;
}

function appliedFrom(config: TuningConfig): AppliedByMode {
  return { cascade: projectMode(config, 'cascade'), realtime: projectMode(config, 'realtime') };
}

/** Immutable set at a dotted path. Only walks objects the schema defines. */
function setPath<T>(root: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const node = root as Record<string, unknown>;
  const next = rest.length === 0 ? value : setPath(node[head] as object, rest.join('.'), value);
  return { ...node, [head]: next } as T;
}

/** Immutable delete: the key is *gone*, not set to `undefined`. */
function deletePath<T>(root: T, path: string): T {
  const [head, ...rest] = path.split('.');
  const node = root as Record<string, unknown>;
  if (rest.length > 0) {
    return { ...node, [head]: deletePath(node[head] as object, rest.join('.')) } as T;
  }
  const remaining: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    if (key !== head) remaining[key] = node[key];
  }
  return remaining as T;
}

/** The inverse of `projectMode`: folds one mode's applied block back into the draft. */
function withMode(config: TuningConfig, applied: ModeTuningConfig): TuningConfig {
  return applied.mode === 'realtime'
    ? { ...config, client: applied.client, realtime: applied.realtime }
    : { ...config, client: applied.client, cascade: applied.cascade };
}

/**
 * Completes one already-applied mode document against the server defaults —
 * the same `migrate()` path a stored document takes, run through the full
 * document so a missing key resolves the way it does everywhere else.
 */
function completeMode(
  applied: ModeTuningConfig,
  defaults: TuningConfig,
  allowLists: ImportAllowLists,
): ModeTuningConfig {
  const completed = migrate(withMode(defaults, applied), defaults, allowLists);
  return completed ? projectMode(completed, applied.mode) : applied;
}

/**
 * Two documents are the same config when their canonical forms match in both
 * modes — the same comparison the fingerprint is built on, so "Preset
 * modified" can never disagree with the chip.
 */
function sameConfig(a: TuningConfig, b: TuningConfig): boolean {
  return (
    canonicalize(projectMode(a, 'cascade')) === canonicalize(projectMode(b, 'cascade')) &&
    canonicalize(projectMode(a, 'realtime')) === canonicalize(projectMode(b, 'realtime'))
  );
}

export function useTuningConfig(mode: TuningMode): TuningController {
  const [draft, setDraft] = useState<TuningConfig>(DEFAULT_TUNING_CONFIG);
  const [applied, setApplied] = useState<AppliedByMode>(() => appliedFrom(DEFAULT_TUNING_CONFIG));
  const [serverDefaults, setServerDefaults] = useState<TuningConfig>(DEFAULT_TUNING_CONFIG);
  const [capabilities, setCapabilities] = useState<TuningCapabilities | null>(null);
  const [capabilitiesState, setCapabilitiesState] = useState<CapabilitiesState>('loading');
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [attempt, setAttempt] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(APPLY_MAX_ATTEMPTS);
  const [lastAppliedAt, setLastAppliedAt] = useState<Date | null>(null);
  const [userPresets, setUserPresets] = useState<TuningPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const allowLists: ImportAllowLists = capabilities?.allowLists ?? FALLBACK_ALLOW_LISTS;

  /**
   * Has the user set anything themselves yet? Only read by the hydration
   * effect below, and a ref rather than state because nothing renders
   * differently for it — it exists to decide, once, whether a late
   * capabilities response is allowed to replace the documents on screen.
   */
  const userTouched = useRef(false);

  // The server's `.env`-derived values are the initial draft *and* the initial
  // applied config: on a fresh browser the panel must display what the backend
  // is actually running, not blanks (story AC 1.11). A failure is not fatal —
  // the built-in defaults are a truthful mirror of today's hardcoded behaviour.
  //
  // Storage is read *here*, after the response, rather than in a `useState`
  // initialiser: a stored document that predates a knob has to fill that knob
  // from the server's default, and on a cold start we don't know it yet.
  useEffect(() => {
    const controller = new AbortController();

    const hydrate = (defaults: TuningConfig, lists: ImportAllowLists): void => {
      setServerDefaults(defaults);
      setUserPresets(loadPresets(defaults, lists));

      // The user got here first (ticket 10 found this against the capture
      // harness: it imports a config the moment the panel renders, and a slow
      // capabilities response would then throw it away). Their document is
      // newer than both the server's defaults and anything in storage, so it
      // stays; the response is still kept for its allow-lists and stage
      // availability, and only *missing* keys are filled — the same
      // `migrate()` completion a stored document gets, which is also what
      // repairs a model id this server turns out not to offer.
      if (userTouched.current) {
        setDraft((current) => migrate(current, defaults, lists) ?? current);
        setApplied((current) => ({
          cascade: completeMode(current.cascade, defaults, lists),
          realtime: completeMode(current.realtime, defaults, lists),
        }));
        setLastAppliedAt((current) => current ?? new Date());
        return;
      }

      const stored = loadTuningState(defaults, lists);
      setDraft(stored?.draft ?? defaults);
      setApplied(stored?.applied ?? appliedFrom(defaults));
      setLastAppliedAt(new Date());
    };

    fetchCapabilities(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setCapabilities(result);
        hydrate(result.defaults, result.allowLists);
        setCapabilitiesState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('Tuning capabilities unavailable; using the built-in defaults.', error);
        hydrate(DEFAULT_TUNING_CONFIG, FALLBACK_ALLOW_LISTS);
        setCapabilitiesState('fallback');
      });
    return () => controller.abort();
  }, []);

  // Write on every change, once we have something worth writing. Gated on the
  // capabilities request having settled so a cold start cannot overwrite the
  // stored document with the client fallback before it has been read.
  useEffect(() => {
    if (capabilitiesState === 'loading') return;
    saveTuningState({ draft, applied });
  }, [draft, applied, capabilitiesState]);

  const projectedDraft = useMemo(() => projectMode(draft, mode), [draft, mode]);
  const pending = useMemo(() => diff(applied[mode], projectedDraft), [applied, mode, projectedDraft]);

  const settled = capabilitiesState !== 'loading';
  const activeFingerprint = useMemo(
    () => (settled ? fingerprint(applied[mode]) : null),
    [applied, mode, settled],
  );
  const draftFingerprint = useMemo(
    () => (settled ? fingerprint(projectedDraft) : null),
    [projectedDraft, settled],
  );

  const setKnob = useCallback((path: string, value: unknown) => {
    userTouched.current = true;
    setDraft((current) => setPath(current, path, value));
  }, []);

  const setProviderDefault = useCallback((path: string, on: boolean) => {
    userTouched.current = true;
    setDraft((current) => (on ? deletePath(current, path) : setPath(current, path, PROVIDER_DEFAULT_SEEDS[path])));
  }, []);

  const apply = useCallback(
    async (applyTuning?: ApplyTuning): Promise<ApplyResult> => {
      userTouched.current = true;
      const next = projectMode(draft, mode);
      const commit = (state: ApplyState): void => {
        setApplied((current) => ({ ...current, [mode]: next }));
        setApplyState(state);
        setAttempt(0);
        setLastAppliedAt(new Date());
      };

      // No transport: commit locally. This is the disconnected path — it still
      // does real work, so the fingerprint on screen is the one the next
      // connect uses.
      if (!applyTuning) {
        commit('idle');
        return { ok: true, fingerprint: fingerprint(next), reconnectedStt: false, deferred: false };
      }

      // A connection-level change is the one the server can only make by
      // reopening the Deepgram socket, so it gets the reconnecting copy from the
      // moment Apply is pressed rather than only once an attempt has failed.
      const reconnects = pending.some((path) => CONNECTION_LEVEL_PATHS.has(path));
      setApplyState(reconnects ? 'reconnecting' : 'applying');
      setAttempt(1);
      setMaxAttempts(APPLY_MAX_ATTEMPTS);
      const result = await applyTuning(next);
      if (result.ok) {
        // A deferred apply is committed here all the same: the transport holds
        // the *latest* config in one slot and will send exactly it, so the panel
        // showing it as applied is true — it just isn't on the wire yet, which
        // is what the status line says.
        commit(result.deferred ? 'deferred' : 'idle');
        return result;
      }
      setAttempt(result.attempt);
      setMaxAttempts(result.maxAttempts);
      // Only an exhausted budget is a decision the user has to make. A failure
      // that arrives early (the session ended underneath the apply) leaves the
      // change pending and lets the session's own error state do the talking,
      // rather than stacking a modal on top of it.
      setApplyState(result.attempt >= result.maxAttempts ? 'failed' : 'idle');
      return result;
    },
    [draft, mode, pending],
  );

  const clearDeferred = useCallback(() => {
    setApplyState((current) => (current === 'deferred' ? 'idle' : current));
  }, []);

  const revert = useCallback(() => {
    setDraft((current) => withMode(current, applied[mode]));
    setApplyState('idle');
    setAttempt(0);
  }, [applied, mode]);

  // Built-ins are resolved against the server defaults on every render of the
  // list, which is what makes `Provider defaults` mean "whatever this server
  // publishes right now" rather than a copy taken at build time.
  const presets = useMemo<TuningPreset[]>(
    () => [...builtInPresets(serverDefaults), ...userPresets],
    [serverDefaults, userPresets],
  );

  const presetModified = useMemo(() => {
    const selected = presets.find((preset) => preset.name === selectedPreset);
    return selected ? !sameConfig(draft, selected.config) : false;
  }, [draft, presets, selectedPreset]);

  const applyPreset = useCallback(
    (name: string) => {
      const preset = presets.find((candidate) => candidate.name === name);
      if (!preset) return;
      userTouched.current = true;
      // The whole document, both modes, in one action (story AC 1.9) — and
      // *only* the draft: a preset is a set of values to look at and Apply,
      // not a live change to a running session.
      setDraft(preset.config);
      setSelectedPreset(name);
      setImportMessage(null);
    },
    [presets],
  );

  const savePresetAs = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (trimmed.length === 0 || isBuiltInPreset(trimmed)) {
        console.warn(`Not saving a preset named "${trimmed}": the name is empty or reserved.`);
        return;
      }
      setUserPresets((current) => {
        const next = [...current.filter((preset) => preset.name !== trimmed), { name: trimmed, config: draft }];
        savePresets(next);
        return next;
      });
      setSelectedPreset(trimmed);
    },
    [draft],
  );

  const deletePreset = useCallback((name: string) => {
    if (isBuiltInPreset(name)) return;
    setUserPresets((current) => {
      const next = current.filter((preset) => preset.name !== name);
      savePresets(next);
      return next;
    });
    setSelectedPreset((current) => (current === name ? null : current));
  }, []);

  const exportConfig = useCallback(() => `${JSON.stringify(draft, null, 2)}\n`, [draft]);

  const importConfig = useCallback(
    (text: string) => {
      const result = parseImported(text, allowLists, serverDefaults);
      if (!result.ok) {
        // The draft is deliberately untouched: a file you fat-fingered must not
        // cost you the knobs you already set (wireframe §4).
        setImportMessage(result.error);
        return { ok: false, message: result.error };
      }
      // Only a *successful* import counts as a touch: a file you fat-fingered
      // left the draft alone, so a late hydration is still free to fill it.
      userTouched.current = true;
      const message = result.warnings.length > 0 ? result.warnings.join(' ') : 'Imported.';
      setDraft(result.config);
      setSelectedPreset(null);
      setImportMessage(message);
      return { ok: true, message };
    },
    [allowLists, serverDefaults],
  );

  const resetToDefaults = useCallback(() => {
    userTouched.current = true;
    setDraft(serverDefaults);
    // Not a preset: this restores what the server publishes, which is a
    // different claim from "the Provider defaults preset is selected".
    setSelectedPreset(null);
    setImportMessage(null);
  }, [serverDefaults]);

  return {
    draft,
    applied,
    pending,
    capabilities,
    capabilitiesState,
    applyState,
    attempt,
    maxAttempts,
    lastAppliedAt,
    activeFingerprint,
    draftFingerprint,
    presets,
    selectedPreset,
    presetModified,
    importMessage,
    setKnob,
    setProviderDefault,
    apply,
    clearDeferred,
    revert,
    applyPreset,
    savePresetAs,
    deletePreset,
    exportConfig,
    importConfig,
    resetToDefaults,
  };
}
