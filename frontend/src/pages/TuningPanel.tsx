/**
 * The Tuning panel (ticket 02): the right-hand `<aside>` that is the single
 * inventory of every audio processing step, in signal order — microphone →
 * denoise chain → turn detection → segmentation → transcript check → models.
 *
 * Presentational. All state lives in `useTuningConfig`, which `WorkbenchPage`
 * owns; this file renders it and calls back. That split is what lets the panel
 * be tested without a session and the hook be tested without a DOM.
 *
 * Six sections, all live: microphone (the `getUserMedia` constraints),
 * denoise chain (RMS gate, RNNoise, the server-side stages, and OpenAI's
 * provider-side reduction), turn detection / endpointing, segmentation
 * (Cascade only), transcript check, and models & voices. Each row is either
 * pure inventory (a knob with nothing behind it yet is never shown) or a
 * working control against the config `useTuningConfig` owns.
 *
 * Layout, section order, states and copy are the approved wireframe's
 * (`.lavish/step5-wireframe-tuning-lab.html`, notes §5–§10). Deviations from
 * the mock's markup are commented where they happen.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ApplyAttemptFailure, ApplyProgress, ConnectionStatus } from './sessionHandle';
import {
  DenoiseStageCard,
  KnobRow,
  NumberKnob,
  ProviderDefaultKnob,
  RangeKnob,
  SegmentedKnob,
  SelectKnob,
  TuningSection,
  type KnobState,
  type SelectOption,
} from './TuningSection';
import { FALLBACK_ALLOW_LISTS, type DenoiseStageName, type StageAvailability } from './tuningCapabilities';
import {
  DEEPGRAM_CONNECTION_LEVEL_PATHS,
  type ModeTuningConfig,
  type RealtimeTuning,
  type TuningMode,
} from './tuningConfig';
import { isBuiltInPreset } from './tuningPresets';
import { PROVIDER_DEFAULT_SEEDS, type ApplyTuning, type TuningController } from './useTuningConfig';

export interface TuningPanelProps {
  mode: TuningMode;
  tuning: TuningController;
  /** Drives the Apply label/status: disconnected still applies, it just queues. */
  connectionStatus: ConnectionStatus;
  onClose: () => void;
  /**
   * The fingerprint the running session's server confirmed (ticket 04). Takes
   * precedence over the locally computed one wherever the panel names the
   * applied config, so the header can never disagree with the backend. Absent /
   * `null` while nothing is running, or against a server that doesn't report
   * one.
   */
  appliedFingerprint?: string | null;
  /**
   * The live-apply transport. Tickets 05/07 pass `session.applyTuning` here;
   * without it Apply commits locally, which is exactly right while
   * disconnected and is the whole of this ticket's Apply behaviour.
   */
  applyTuning?: ApplyTuning;
  /**
   * How the apply on the wire is going (ticket 07). The controller's own
   * `attempt` only moves when the promise settles, which is once — this is the
   * per-attempt commentary the reconnecting status line and the failure
   * dialog's attempt log need while it is still in flight.
   */
  applyProgress?: ApplyProgress | null;
}

const CONNECTION_LEVEL_PATHS = new Set<string>(DEEPGRAM_CONNECTION_LEVEL_PATHS);

/**
 * The connection-level knobs that live in the Endpointing section (ticket 06).
 * A subset of `DEEPGRAM_CONNECTION_LEVEL_PATHS`, because the fourth member of
 * that set — the Deepgram model — is rendered down in Models & voices, and a
 * section may only claim it reopens the STT connection when one of *its own*
 * rows is what would reopen it.
 */
const ENDPOINTING_PATHS = [
  'cascade.deepgram.endpointingMs',
  'cascade.deepgram.utteranceEndMs',
  'cascade.deepgram.diarize',
];

/**
 * The browser's own capture constraints (ticket 11). Shared `client` block, so
 * one list renders both modes; the wire field is the `MediaTrackConstraints`
 * key the value ends up under, which is also the name in `KNOB_METADATA`.
 */
const MICROPHONE_KNOBS = [
  {
    path: 'client.microphone.echoCancellation',
    testId: 'tuning-mic-ec',
    label: 'Echo cancellation',
    wireField: 'echoCancellation',
    hint: 'Cancels what the speakers are playing back into the mic. Leave on unless you are on headphones and want the raw signal.',
  },
  {
    path: 'client.microphone.noiseSuppression',
    testId: 'tuning-mic-ns',
    label: 'Noise suppression',
    wireField: 'noiseSuppression',
    hint: 'The browser’s own denoiser, ahead of every stage below. Turn it off to measure one of those on its own.',
  },
  {
    path: 'client.microphone.autoGainControl',
    testId: 'tuning-mic-agc',
    label: 'Auto gain control',
    wireField: 'autoGainControl',
    hint: 'Levels the input automatically — which also moves the signal under the RMS gate’s threshold.',
  },
] as const;

/** OpenAI's turn-detection knobs (ticket 04), by the path that addresses them. */
const TURN_DETECTION_PATHS = {
  type: 'realtime.turnDetection.type',
  threshold: 'realtime.turnDetection.threshold',
  prefixPaddingMs: 'realtime.turnDetection.prefixPaddingMs',
  silenceDurationMs: 'realtime.turnDetection.silenceDurationMs',
  interruptResponse: 'realtime.turnDetection.interruptResponse',
  eagerness: 'realtime.turnDetection.eagerness',
} as const;

/** Which knobs each turn-detection type can carry (`interruptResponse`: both). */
const SERVER_VAD_PATHS = [
  TURN_DETECTION_PATHS.threshold,
  TURN_DETECTION_PATHS.prefixPaddingMs,
  TURN_DETECTION_PATHS.silenceDurationMs,
];
const SEMANTIC_VAD_PATHS = [TURN_DETECTION_PATHS.eagerness];

/** One knob whose absence is a value. `path` addresses it inside the draft. */
interface OptionalKnob {
  path: string;
  knob: KnobState;
  /** The key is omitted from the document entirely — "Provider default". */
  unset: boolean;
  /** The selected turn-detection type can carry this key at all. */
  applies: boolean;
}

/**
 * What a greyed row's control *shows* while its key is omitted. Reads the same
 * seeds unchecking the box would write, so the control doesn't jump the moment
 * you take it off Provider default. The readout beside it still says `—`, which
 * is what tells you nothing is being sent.
 */
function seedFor<T>(path: string): T {
  return PROVIDER_DEFAULT_SEEDS[path] as T;
}

/** The preset select's last entry: an action, not a preset (wireframe §4). */
const SAVE_AS_OPTION = '__save';

/** wireframe §7 — the actionable half of the `not installed` treatment. */
const STAGE_INSTALL_HINT: Record<DenoiseStageName, string> = {
  deepfilternet: 'Install with `uv sync --extra denoise` in `backend/`, then reconnect.',
  noisereduce: 'Install with `uv sync --extra bench` in `backend/`, then reconnect.',
  demucs: 'Install with `uv sync --extra denoise` in `backend/`.',
  dns64: 'Install with `uv sync --extra denoise` in `backend/`.',
};

const OFFLINE_STAGE_LINE =
  'Too slow for the live path. Selectable in a benchmark config file; listed here so the panel stays the complete inventory of processing steps.';

function readPath(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[key];
  }, doc);
}

/** `was:` badge text. `—` is what an omitted key reads as everywhere else. */
function formatKnobValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

function stageBadge(stage: StageAvailability | undefined): { label: string; unavailable: boolean } {
  if (!stage?.installed) return { label: 'not installed', unavailable: true };
  // Installed but unusable is a different problem with a different fix, so it
  // gets its own words rather than being flattened into "not installed".
  if (stage.reason) return { label: 'model weights unavailable', unavailable: true };
  return { label: '', unavailable: false };
}

export function TuningPanel({
  mode,
  tuning,
  connectionStatus,
  onClose,
  appliedFingerprint,
  applyTuning,
  applyProgress,
}: TuningPanelProps) {
  const {
    draft,
    applied,
    pending,
    capabilities,
    capabilitiesState,
    applyState,
    attempt,
    maxAttempts,
    lastAppliedAt,
    activeFingerprint: localFingerprint,
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
    exportConfig,
    importConfig,
    resetToDefaults,
  } = tuning;

  // Header-local UI state: which of the two inline editors is showing. Neither
  // is persisted, and neither belongs in the controller — they are about this
  // panel's chrome, not about the config.
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [pastedConfig, setPastedConfig] = useState('');
  // Where focus goes when the failure dialog closes (wireframe §9). Apply is
  // disabled the moment Revert to previous clears the pending change, and a
  // disabled button can't hold focus, so Revert is the fallback: the nearest
  // still-operable control in the same footer, rather than dropping focus on
  // `<body>` and making the user tab in from the top of the page.
  const applyButtonRef = useRef<HTMLButtonElement>(null);
  const revertButtonRef = useRef<HTMLButtonElement>(null);

  // A deferred apply is queued in the transport until the current reply
  // finishes. Both modes confirm it through the same prop, `appliedFingerprint`,
  // just by different mechanisms: **Cascade** moves it when the server confirms
  // a new fingerprint; **Realtime** moves it locally, inside
  // `useRealtimeSession.sendSessionUpdate`, the instant a queued `session.update`
  // actually goes out over the data channel — there is no server leg to wait on,
  // so a successful send *is* the confirmation. Either way, once the prop moves
  // this effect is what tells the controller to drop the "Applying after the
  // current reply…" line.
  const confirmedFingerprintRef = useRef(appliedFingerprint);
  useEffect(() => {
    if (appliedFingerprint === confirmedFingerprintRef.current) return;
    confirmedFingerprintRef.current = appliedFingerprint;
    clearDeferred();
  }, [appliedFingerprint, clearDeferred]);

  // The server's confirmation, when there is a session to confirm it; otherwise
  // the hash of what this panel has committed locally.
  const activeFingerprint = appliedFingerprint ?? localFingerprint;
  const appliedDoc: ModeTuningConfig = applied[mode];
  const allowLists = capabilities?.allowLists ?? FALLBACK_ALLOW_LISTS;
  const pendingPaths = new Set(pending);
  const connectionLevelPending = pending.some((path) => CONNECTION_LEVEL_PATHS.has(path));
  const endpointingPending = ENDPOINTING_PATHS.some((path) => pendingPaths.has(path));
  const connected = connectionStatus === 'connected' || connectionStatus === 'reconnecting';

  /** Pending/disabled/reconnect state for one knob, from the derived diff. */
  function knob(path: string, disabled = false): KnobState {
    const isPending = pendingPaths.has(path);
    return {
      pending: isPending,
      was: isPending ? formatKnobValue(readPath(appliedDoc, path)) : undefined,
      reconnects: isPending && CONNECTION_LEVEL_PATHS.has(path),
      disabled,
    };
  }

  function stage(name: DenoiseStageName): StageAvailability | undefined {
    return capabilities?.stages[name];
  }

  const textModelOptions = allowLists.textModels.map((model) => ({ value: model, label: model }));

  // Both in-flight states share the button treatment — spinner, `Applying…`,
  // disabled — and differ only in what the status line underneath says.
  const applyInFlight = applyState === 'applying' || applyState === 'reconnecting';

  const applyLabel = applyInFlight
    ? 'Applying…'
    : pending.length === 0
      ? 'Apply'
      : !connected
        ? 'Apply at next connect'
        : connectionLevelPending
          ? 'Apply (reconnects STT)'
          : 'Apply';

  function statusLine(): ReactNode {
    if (applyState === 'reconnecting') {
      // The transport's live count when there is one (it is the only thing that
      // sees each failed attempt); otherwise the first attempt, which is where
      // every reconnect starts.
      const current = applyProgress?.attempt ?? Math.max(attempt, 1);
      const budget = applyProgress?.maxAttempts ?? maxAttempts;
      return `Reconnecting STT with the new parameters… (attempt ${current} of ${budget})`;
    }
    if (applyState === 'applying') {
      return 'Applying…';
    }
    if (applyState === 'deferred') {
      return 'Applying after the current reply…';
    }
    if (pending.length === 0) {
      return (
        <>
          Applied · <span className="font-mono">{activeFingerprint ?? '—'}</span>
          {lastAppliedAt ? ` · ${lastAppliedAt.toLocaleTimeString()}` : ''}
        </>
      );
    }
    if (!connected) {
      return `Not connected · ${pending.length} changes will be sent when you connect`;
    }
    return connectionLevelPending
      ? `${pending.length} changes pending · 1 reopens the Deepgram connection`
      : `${pending.length} changes pending`;
  }

  /**
   * Export does both halves of "get this config out of the browser": a
   * download, because that is what you attach to a benchmark row, and a
   * clipboard copy, because that is what you paste into another tab. Neither
   * API exists everywhere (no `createObjectURL` under jsdom, no `clipboard`
   * without a secure context), so both are optional and neither can throw the
   * panel down.
   */
  function handleExport(): void {
    const json = exportConfig();
    // `cfg:7f3a9c21` → `tuning-7f3a9c21.json`: the colon is a legal fingerprint
    // character and an illegal Windows filename one.
    const slug = (draftFingerprint ?? 'config').replace('cfg:', '');
    void navigator.clipboard?.writeText(json).catch((error: unknown) => {
      console.warn('Could not copy the tuning config to the clipboard.', error);
    });
    if (typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `tuning-${slug}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportFile(file: File | undefined): Promise<void> {
    if (!file) return;
    const result = importConfig(await file.text());
    if (result.ok) setImportOpen(false);
  }

  function handleImportPaste(): void {
    const result = importConfig(pastedConfig);
    if (!result.ok) return;
    setPastedConfig('');
    setImportOpen(false);
  }

  function handlePresetChange(value: string): void {
    if (value === SAVE_AS_OPTION) {
      setSavingPreset(true);
      return;
    }
    setSavingPreset(false);
    // The empty option is a *state* ("this config came from nowhere in
    // particular"), not an action — selecting it changes no knob.
    if (value !== '') applyPreset(value);
  }

  function handleSavePreset(): void {
    savePresetAs(presetName);
    setPresetName('');
    setSavingPreset(false);
  }

  const builtInOptions = presets.filter((preset) => isBuiltInPreset(preset.name));
  const userOptions = presets.filter((preset) => !isBuiltInPreset(preset.name));

  // Section summary chips: a collapsed section still says what it is set to.
  const microphoneOn = MICROPHONE_KNOBS.filter(({ path }) => readPath(draft, path) === true).length;
  const denoiseOn =
    (draft.client.rmsGate.enabled ? 1 : 0) +
    (draft.client.rnnoise.enabled ? 1 : 0) +
    (mode === 'cascade'
      ? (draft.cascade.denoise.noisereduce.enabled ? 1 : 0) + (draft.cascade.denoise.deepfilternet.enabled ? 1 : 0)
      : draft.realtime.noiseReduction && draft.realtime.noiseReduction !== 'off'
        ? 1
        : 0);
  const transcriptCheckMode =
    mode === 'cascade' ? draft.cascade.transcriptCheck.mode : draft.realtime.transcriptCheck.mode;

  return (
    <aside
      id="tuning-panel"
      data-testid="tuning-panel"
      aria-label="Tuning panel"
      // Mobile: a full-width bottom sheet over the page (the transcripts are
      // already single-column, so there is no side room to give up). From `sm`
      // up it is the sticky side column the wireframe specifies.
      className="fixed inset-x-0 bottom-0 z-40 max-h-[85vh] w-full rounded-t-box card card-border bg-base-100 shadow-xl sm:sticky sm:z-auto sm:top-4 sm:max-h-none sm:w-[340px] sm:shrink-0 sm:rounded-box sm:shadow-none lg:w-[400px]"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="card-body p-0 max-h-[85vh] sm:max-h-none flex flex-col">
        <div className="p-3 border-b border-base-300 space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-sm flex-1">
              Tuning
              <span className="badge badge-ghost badge-sm ml-1">{mode === 'cascade' ? 'Cascade' : 'Realtime'}</span>
            </h2>
            {/* The navbar chip keeps `tuning-fingerprint` (ticket 01); this one
                needs its own id so both can be queried in one page. */}
            {activeFingerprint === null ? (
              <span className="badge badge-ghost badge-sm font-mono skeleton w-20" data-testid="tuning-fingerprint-panel" aria-hidden="true" />
            ) : (
              <span className="badge badge-ghost badge-sm font-mono" data-testid="tuning-fingerprint-panel" title="Applied tuning config">
                {activeFingerprint}
              </span>
            )}
            <button
              type="button"
              className="btn btn-xs btn-ghost btn-circle"
              aria-label="Close tuning panel"
              data-testid="tuning-close"
              onClick={onClose}
            >
              ✕
            </button>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tuning-preset-input" className="sr-only">
              Preset
            </label>
            <select
              id="tuning-preset-input"
              data-testid="tuning-preset"
              className="select select-xs flex-1"
              value={savingPreset ? SAVE_AS_OPTION : (selectedPreset ?? '')}
              onChange={(event) => handlePresetChange(event.target.value)}
            >
              {/* Where the draft sits after an import, a reset, or a knob you
                  turned yourself: no preset claims it. */}
              <option value="">Custom</option>
              <optgroup label="Built-in">
                {builtInOptions.map((preset) => (
                  <option key={preset.name} value={preset.name}>
                    {preset.name}
                  </option>
                ))}
              </optgroup>
              {userOptions.length > 0 ? (
                <optgroup label="My presets">
                  {userOptions.map((preset) => (
                    <option key={preset.name} value={preset.name}>
                      {preset.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <option value={SAVE_AS_OPTION}>Save as…</option>
            </select>
            <button type="button" className="btn btn-xs" data-testid="tuning-export" onClick={handleExport}>
              Export
            </button>
            <button
              type="button"
              className="btn btn-xs"
              data-testid="tuning-import"
              aria-expanded={importOpen}
              onClick={() => setImportOpen((open) => !open)}
            >
              Import
            </button>
          </div>

          {savingPreset ? (
            <div className="flex items-center gap-2">
              <label htmlFor="tuning-preset-name-input" className="sr-only">
                Preset name
              </label>
              <input
                type="text"
                id="tuning-preset-name-input"
                data-testid="tuning-preset-name"
                className="input input-xs flex-1"
                placeholder="Preset name"
                value={presetName}
                autoFocus
                onChange={(event) => setPresetName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && presetName.trim() !== '') handleSavePreset();
                }}
              />
              <button
                type="button"
                className="btn btn-xs btn-primary"
                data-testid="tuning-preset-save"
                disabled={presetName.trim() === ''}
                onClick={handleSavePreset}
              >
                Save
              </button>
            </div>
          ) : null}

          {/* The file input stays mounted while the importer is closed so the
              capture harness can set a whole config on it without driving the
              header first; it is only *shown* once Import is pressed. */}
          {importOpen ? (
            <div className="rounded-box border border-base-300 p-2 space-y-1">
              <label htmlFor="tuning-import-text-input" className="text-[11px] text-base-content/60">
                Paste a tuning config
              </label>
              <textarea
                id="tuning-import-text-input"
                data-testid="tuning-import-text"
                className="textarea textarea-xs w-full font-mono"
                rows={3}
                value={pastedConfig}
                onChange={(event) => setPastedConfig(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-xs"
                  data-testid="tuning-import-paste"
                  disabled={pastedConfig.trim() === ''}
                  onClick={handleImportPaste}
                >
                  Load pasted JSON
                </button>
                <span className="text-[11px] text-base-content/60">or choose a file:</span>
              </div>
            </div>
          ) : null}
          <input
            type="file"
            data-testid="tuning-import-file"
            aria-label="Import a tuning config file"
            accept="application/json,.json"
            className={importOpen ? 'file-input file-input-xs w-full' : 'hidden'}
            onChange={(event) => {
              void handleImportFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />

          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-xs btn-ghost" data-testid="tuning-reset" onClick={resetToDefaults}>
              Reset to defaults
            </button>
            {presetModified ? <span className="text-[11px] text-base-content/50 ml-auto">Preset modified</span> : null}
          </div>

          {importMessage ? (
            <p
              className="text-[11px] text-base-content/70"
              role="status"
              aria-live="polite"
              data-testid="tuning-import-message"
            >
              {importMessage}
            </p>
          ) : null}
        </div>

        <div className="overflow-y-auto flex-1 sm:max-h-[560px] p-2 space-y-2" data-testid="tuning-sections">
          {capabilitiesState === 'loading' ? (
            <SectionSkeleton />
          ) : (
            <>
              <TuningSection
                testId="tuning-section-microphone"
                title="Microphone"
                defaultOpen
                summaryBadges={
                  <>
                    <span className="badge badge-ghost badge-xs ml-1">browser</span>
                    <span className="badge badge-primary badge-xs ml-1">{microphoneOn} on</span>
                  </>
                }
              >
                {/* One shared block, so the rows are identical in both modes —
                    the browser's constraints know nothing about which transport
                    is about to consume the track. */}
                {MICROPHONE_KNOBS.map(({ path, testId, label, wireField, hint }) => (
                  <KnobRow
                    key={path}
                    htmlFor={`${testId}-input`}
                    label={label}
                    wireField={wireField}
                    knob={knob(path)}
                    inline
                    hint={hint}
                  >
                    <input
                      type="checkbox"
                      id={`${testId}-input`}
                      data-testid={testId}
                      className="toggle toggle-xs toggle-primary"
                      checked={readPath(draft, path) === true}
                      onChange={(event) => setKnob(path, event.target.checked)}
                    />
                  </KnobRow>
                ))}
                {/* No `reconnects` chip anywhere in this section, deliberately:
                    these are constraints on a track that is already open, so
                    applying one costs nothing now and everything at the next
                    getUserMedia. */}
                <p className="text-[11px] text-base-content/50">
                  Applied at getUserMedia time — takes effect on the next connect.
                </p>
              </TuningSection>

              <TuningSection
                testId="tuning-section-denoise"
                title="Denoise chain"
                defaultOpen
                summaryBadges={<span className="badge badge-primary badge-xs ml-1">{denoiseOn} on</span>}
              >
                <p className="text-[11px] text-base-content/50">Stages run top to bottom, in signal order.</p>

                {/* RMS gate — first in signal order, and the only stage that runs
                    in the browser in *both* modes (ticket 12). */}
                <DenoiseStageCard
                  id="tuning-rms-enabled-input"
                  testId="tuning-rms-enabled"
                  name="RMS gate"
                  runsIn="browser"
                  enabled={draft.client.rmsGate.enabled}
                  onToggle={(on) => setKnob('client.rmsGate.enabled', on)}
                  knob={knob('client.rmsGate.enabled')}
                  hint="Attenuates anything quieter than the threshold, so room tone between sentences never reaches the transcriber."
                >
                  <RangeKnob
                    id="tuning-rms-threshold-input"
                    testId="tuning-rms-threshold"
                    label="Threshold"
                    wireField="thresholdDbfs"
                    min={-80}
                    max={0}
                    step={1}
                    value={draft.client.rmsGate.thresholdDbfs}
                    format={(value) => `${value} dBFS`}
                    knob={knob('client.rmsGate.thresholdDbfs')}
                    onChange={(value) => setKnob('client.rmsGate.thresholdDbfs', value)}
                    hint="−80 dBFS is always open; 0 dBFS is always closed."
                  />
                  <div className="grid grid-cols-3 gap-x-2">
                    <NumberKnob
                      id="tuning-rms-hold-input"
                      testId="tuning-rms-hold"
                      label="Hold (ms)"
                      min={0}
                      max={2000}
                      step={10}
                      value={draft.client.rmsGate.holdMs}
                      knob={knob('client.rmsGate.holdMs')}
                      onChange={(value) => setKnob('client.rmsGate.holdMs', value)}
                    />
                    <NumberKnob
                      id="tuning-rms-attack-input"
                      testId="tuning-rms-attack"
                      label="Attack (ms)"
                      min={0}
                      max={500}
                      step={1}
                      value={draft.client.rmsGate.attackMs}
                      knob={knob('client.rmsGate.attackMs')}
                      onChange={(value) => setKnob('client.rmsGate.attackMs', value)}
                    />
                    <NumberKnob
                      id="tuning-rms-release-input"
                      testId="tuning-rms-release"
                      label="Release (ms)"
                      min={0}
                      max={2000}
                      step={10}
                      value={draft.client.rmsGate.releaseMs}
                      knob={knob('client.rmsGate.releaseMs')}
                      onChange={(value) => setKnob('client.rmsGate.releaseMs', value)}
                    />
                  </div>
                  <RangeKnob
                    id="tuning-rms-attenuation-input"
                    testId="tuning-rms-attenuation"
                    label="Attenuation"
                    wireField="attenuationDb"
                    min={0}
                    max={60}
                    step={1}
                    value={draft.client.rmsGate.attenuationDb}
                    // Full mute is the far end of this same control, so while it
                    // is on the slider has nothing left to say — genuinely
                    // disabled, with the reason in the visible scale beneath it.
                    format={(value) => (draft.client.rmsGate.fullMute ? 'mute' : `${value} dB`)}
                    knob={knob('client.rmsGate.attenuationDb', draft.client.rmsGate.fullMute)}
                    onChange={(value) => setKnob('client.rmsGate.attenuationDb', value)}
                  />
                  <div className="flex justify-between text-[10px] text-base-content/40" aria-hidden="true">
                    <span>0 dB (off)</span>
                    <span>60 dB</span>
                    <span>mute</span>
                  </div>
                  {draft.client.rmsGate.fullMute ? (
                    <p className="text-[11px] text-base-content/50" data-testid="tuning-rms-attenuation-muted-note">
                      Full mute overrides attenuation.
                    </p>
                  ) : null}
                  <KnobRow
                    htmlFor="tuning-rms-mute-input"
                    label="Full mute"
                    wireField="fullMute"
                    knob={knob('client.rmsGate.fullMute')}
                    inline
                    hint="Pins the far end of the scale: a closed gate outputs silence rather than an attenuated signal."
                  >
                    <input
                      type="checkbox"
                      id="tuning-rms-mute-input"
                      data-testid="tuning-rms-mute"
                      className="checkbox checkbox-xs"
                      checked={draft.client.rmsGate.fullMute}
                      onChange={(event) => setKnob('client.rmsGate.fullMute', event.target.checked)}
                    />
                  </KnobRow>
                  <p className="text-[11px] text-base-content/50">
                    Threshold, hold, attack, release and attenuation apply live, without a reconnect. Turning the gate
                    on applies at next connect — it is inserted when the capture graph is built.
                  </p>
                </DenoiseStageCard>

                {/* RNNoise — second in signal order, after the gate, and like it
                    it runs in the browser in both modes (ticket 13). */}
                <DenoiseStageCard
                  id="tuning-rnnoise-enabled-input"
                  testId="tuning-rnnoise-enabled"
                  name="RNNoise"
                  runsIn="browser"
                  enabled={draft.client.rnnoise.enabled}
                  onToggle={(on) => setKnob('client.rnnoise.enabled', on)}
                  knob={knob('client.rnnoise.enabled')}
                  hint="A recurrent-network denoiser trained on speech, running on the mic signal before anything is sent."
                >
                  <RangeKnob
                    id="tuning-rnnoise-voice-prob-input"
                    testId="tuning-rnnoise-voice-prob"
                    label="Voice probability threshold"
                    wireField="voiceProbThreshold"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.client.rnnoise.voiceProbThreshold}
                    // Genuinely disabled, with the reason in visible text below
                    // rather than a title (wireframe §9): this build of the
                    // package applies RNNoise unconditionally and exposes no
                    // knob for the per-frame voice probability, so a live
                    // slider here would be a control that does nothing.
                    knob={knob('client.rnnoise.voiceProbThreshold', true)}
                    onChange={(value) => setKnob('client.rnnoise.voiceProbThreshold', value)}
                    hint="Not exposed by this build of @sapphi-red/web-noise-suppressor — the value is still part of the config and its fingerprint, but nothing reads it."
                  />
                  <p className="text-[11px] text-base-content/50">
                    RNNoise runs at 48 kHz on 480-sample frames, so the capture graph switches to a 48 kHz context and
                    resamples 3:1 back to 16 kHz on the way out. Turning it on applies at next connect.
                  </p>
                </DenoiseStageCard>

                {/* OpenAI noise reduction — the provider-side stage, Realtime only. */}
                <div className={`rounded-box border border-base-300 p-2 space-y-2 ${mode === 'cascade' ? 'border-dashed opacity-50' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium flex-1">OpenAI noise reduction</span>
                    {mode === 'realtime' ? (
                      <span className="badge badge-ghost badge-xs">runs in: provider</span>
                    ) : (
                      <span className="badge badge-ghost badge-xs">Realtime only</span>
                    )}
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <SegmentedKnob
                        name="tuning-openai-noise-reduction"
                        groupLabel="OpenAI input noise reduction"
                        label="Mode"
                        knob={knob(
                          'realtime.noiseReduction',
                          mode === 'cascade' || draft.realtime.noiseReduction === undefined,
                        )}
                        value={draft.realtime.noiseReduction}
                        onChange={(value) => setKnob('realtime.noiseReduction', value)}
                        options={[
                          { value: 'off', label: 'off', testId: 'tuning-openai-noise-reduction-off' },
                          { value: 'near_field', label: 'near_field', testId: 'tuning-openai-noise-reduction-near' },
                          { value: 'far_field', label: 'far_field', testId: 'tuning-openai-noise-reduction-far' },
                        ]}
                      />
                    </div>
                    <ProviderDefaultKnob
                      id="tuning-openai-noise-reduction-default-input"
                      testId="tuning-openai-noise-reduction-default"
                      checked={draft.realtime.noiseReduction === undefined}
                      disabled={mode === 'cascade'}
                      onChange={(on) => setProviderDefault('realtime.noiseReduction', on)}
                    />
                  </div>
                  <p className="text-[11px] text-base-content/50">
                    off sends the key explicitly; “Provider default” omits it entirely, so OpenAI&apos;s own default applies.
                  </p>
                </div>

                <ServerStage
                  mode={mode}
                  name="deepfilternet"
                  label="DeepFilterNet"
                  toggleTestId="tuning-dfn-enabled"
                  unavailableTestId="tuning-dfn-unavailable"
                  availability={stage('deepfilternet')}
                  enabled={draft.cascade.denoise.deepfilternet.enabled}
                  onToggle={(on) => setKnob('cascade.denoise.deepfilternet.enabled', on)}
                  knob={knob('cascade.denoise.deepfilternet.enabled')}
                >
                  {(disabled) => (
                    <div className="grid grid-cols-2 gap-x-3">
                      <NumberKnob
                        id="tuning-dfn-attenuation-limit-input"
                        testId="tuning-dfn-attenuation-limit"
                        label="Attenuation limit (dB)"
                        min={0}
                        max={100}
                        step={1}
                        value={draft.cascade.denoise.deepfilternet.attenuationLimitDb}
                        knob={knob('cascade.denoise.deepfilternet.attenuationLimitDb', disabled)}
                        onChange={(value) => setKnob('cascade.denoise.deepfilternet.attenuationLimitDb', value)}
                      />
                      <NumberKnob
                        id="tuning-dfn-post-filter-input"
                        testId="tuning-dfn-post-filter"
                        label="Post-filter strength"
                        min={0}
                        max={1}
                        step={0.01}
                        value={draft.cascade.denoise.deepfilternet.postFilterBeta}
                        knob={knob('cascade.denoise.deepfilternet.postFilterBeta', disabled)}
                        onChange={(value) => setKnob('cascade.denoise.deepfilternet.postFilterBeta', value)}
                      />
                    </div>
                  )}
                </ServerStage>

                <ServerStage
                  mode={mode}
                  name="noisereduce"
                  label="noisereduce"
                  toggleTestId="tuning-noisereduce-enabled"
                  unavailableTestId="tuning-noisereduce-unavailable"
                  availability={stage('noisereduce')}
                  enabled={draft.cascade.denoise.noisereduce.enabled}
                  onToggle={(on) => setKnob('cascade.denoise.noisereduce.enabled', on)}
                  knob={knob('cascade.denoise.noisereduce.enabled')}
                >
                  {(disabled) => (
                    <>
                      <RangeKnob
                        id="tuning-noisereduce-prop-decrease-input"
                        testId="tuning-noisereduce-prop-decrease"
                        label="prop_decrease"
                        min={0}
                        max={1}
                        step={0.05}
                        value={draft.cascade.denoise.noisereduce.propDecrease}
                        format={(value) => value.toFixed(2)}
                        knob={knob('cascade.denoise.noisereduce.propDecrease', disabled)}
                        onChange={(value) => setKnob('cascade.denoise.noisereduce.propDecrease', value)}
                      />
                      <SegmentedKnob
                        name="tuning-noisereduce-stationary"
                        groupLabel="noisereduce noise model"
                        label="Noise model"
                        knob={knob('cascade.denoise.noisereduce.stationary', disabled)}
                        value={draft.cascade.denoise.noisereduce.stationary ? 'stationary' : 'non-stationary'}
                        onChange={(value) => setKnob('cascade.denoise.noisereduce.stationary', value === 'stationary')}
                        options={[
                          { value: 'stationary', label: 'stationary', testId: 'tuning-noisereduce-stationary' },
                          { value: 'non-stationary', label: 'non-stationary', testId: 'tuning-noisereduce-non-stationary' },
                        ]}
                      />
                    </>
                  )}
                </ServerStage>

                {/* Offline-only stages. Permanently disabled in both modes: the
                    live path ignores them and logs. Present because the panel is
                    the complete inventory (locked decision 11). */}
                <div className="rounded-box border border-base-300 border-dashed p-2 space-y-1 opacity-60">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="tuning-demucs-enabled-input"
                      data-testid="tuning-demucs-enabled"
                      className="toggle toggle-xs"
                      checked={draft.cascade.denoise.offline.demucs}
                      disabled
                      readOnly
                    />
                    <label htmlFor="tuning-demucs-enabled-input" className="font-medium flex-1">
                      Demucs
                    </label>
                    <span className="badge badge-neutral badge-xs">benchmark only</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="tuning-dns-enabled-input"
                      data-testid="tuning-dns-enabled"
                      className="toggle toggle-xs"
                      checked={draft.cascade.denoise.offline.dns64}
                      disabled
                      readOnly
                    />
                    <label htmlFor="tuning-dns-enabled-input" className="font-medium flex-1">
                      denoiser (DNS64)
                    </label>
                    <span className="badge badge-neutral badge-xs">benchmark only</span>
                  </div>
                  <p className="text-[11px] text-base-content/50">{OFFLINE_STAGE_LINE}</p>
                </div>
              </TuningSection>

              <TuningSection
                testId="tuning-section-turn"
                title={mode === 'cascade' ? 'Endpointing' : 'Turn detection'}
                defaultOpen
                summaryBadges={
                  mode === 'cascade' ? (
                    <>
                      <span className="badge badge-ghost badge-xs ml-1">Deepgram</span>
                      {/* Only once one of *these* rows is pending: an unconditional
                          chip would say "reconnects STT" about a section nobody has
                          touched, and then say exactly the same thing when the
                          Apply below really is about to reopen the socket. */}
                      {endpointingPending ? (
                        <span className="badge badge-warning badge-soft badge-xs ml-1">reconnects STT</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="badge badge-ghost badge-xs ml-1">{draft.realtime.turnDetection.type}</span>
                  )
                }
              >
                {mode === 'cascade' ? (
                  <>
                    <NumberKnob
                      id="tuning-dg-endpointing-input"
                      testId="tuning-dg-endpointing"
                      label="Endpointing (ms)"
                      wireField="endpointing"
                      min={0}
                      max={5000}
                      step={10}
                      value={draft.cascade.deepgram.endpointingMs}
                      knob={knob('cascade.deepgram.endpointingMs')}
                      onChange={(value) => setKnob('cascade.deepgram.endpointingMs', value)}
                      hint="Silence Deepgram waits for before finalising a transcript. Lower is snappier and cuts more mid-sentence."
                    />
                    <NumberKnob
                      id="tuning-dg-utterance-end-input"
                      testId="tuning-dg-utterance-end"
                      label="Utterance end (ms)"
                      wireField="utterance_end_ms"
                      min={1000}
                      max={5000}
                      step={100}
                      value={draft.cascade.deepgram.utteranceEndMs}
                      knob={knob('cascade.deepgram.utteranceEndMs')}
                      onChange={(value) => setKnob('cascade.deepgram.utteranceEndMs', value)}
                      hint="The backstop: how long a gap in words counts as the end of a turn."
                    />
                    <KnobRow
                      htmlFor="tuning-dg-diarize-input"
                      label="Diarize"
                      wireField="diarize"
                      knob={knob('cascade.deepgram.diarize')}
                      inline
                      hint="Per-word speaker labels — what attributes each transcript segment to speaker A or B."
                    >
                      <input
                        type="checkbox"
                        id="tuning-dg-diarize-input"
                        data-testid="tuning-dg-diarize"
                        className="toggle toggle-xs toggle-primary"
                        checked={draft.cascade.deepgram.diarize}
                        onChange={(event) => setKnob('cascade.deepgram.diarize', event.target.checked)}
                      />
                    </KnobRow>
                    <p className="text-[11px] text-base-content/50">
                      All three are Deepgram connection parameters — applying one reopens the STT connection, which
                      the server does behind the running session rather than ending it.
                    </p>
                  </>
                ) : (
                  <RealtimeTurnDetection
                    turnDetection={draft.realtime.turnDetection}
                    eagernessOptions={allowLists.eagerness.map((level) => ({ value: level, label: level }))}
                    knob={knob}
                    setKnob={setKnob}
                    setProviderDefault={setProviderDefault}
                  />
                )}
              </TuningSection>

              {mode === 'cascade' ? (
                <TuningSection
                  testId="tuning-section-segmentation"
                  title="Segmentation"
                  summaryBadges={
                    <span className="badge badge-ghost badge-xs ml-1">
                      {draft.cascade.segmentation.mode === 'hybrid' ? 'hybrid-race' : 'llm-priority'}
                    </span>
                  }
                >
                  <SegmentedKnob
                    name="tuning-segmentation-mode"
                    groupLabel="Segmentation mode"
                    label="Mode"
                    wireField="segmentationMode"
                    value={draft.cascade.segmentation.mode}
                    knob={knob('cascade.segmentation.mode')}
                    onChange={(value) => setKnob('cascade.segmentation.mode', value)}
                    options={[
                      { value: 'hybrid', label: 'hybrid-race', testId: 'tuning-segmentation-mode-hybrid' },
                      { value: 'llm_priority', label: 'llm-priority', testId: 'tuning-segmentation-mode-llm' },
                    ]}
                    hint="hybrid-race — whichever of the LLM clause check and Deepgram's own pause signal fires first ends the segment. llm-priority — the LLM decides, with Deepgram only as the ceiling."
                  />
                  <SelectKnob
                    id="tuning-segmentation-model-input"
                    testId="tuning-segmentation-model"
                    label="Segmentation model"
                    options={textModelOptions}
                    value={draft.cascade.segmentation.model}
                    knob={knob('cascade.segmentation.model')}
                    onChange={(value) => setKnob('cascade.segmentation.model', value)}
                  />
                  <p className="text-[11px] text-base-content/50">
                    Applies to the next segment — no reconnect.
                  </p>
                </TuningSection>
              ) : null}

              <TuningSection
                testId="tuning-section-transcript-check"
                title="Transcript check"
                defaultOpen
                summaryBadges={
                  <span
                    className={`badge badge-xs ml-1 ${transcriptCheckMode === 'off' ? 'badge-ghost' : 'badge-warning badge-soft'}`}
                  >
                    {transcriptCheckMode}
                  </span>
                }
              >
                <SegmentedKnob
                  name="tuning-transcript-check"
                  groupLabel="Transcript check"
                  label="Mode"
                  value={transcriptCheckMode}
                  knob={knob(`${mode}.transcriptCheck.mode`)}
                  onChange={(value) => setKnob(`${mode}.transcriptCheck.mode`, value)}
                  options={[
                    { value: 'off', label: 'off', testId: 'tuning-transcript-check-off' },
                    { value: 'flag', label: 'flag', testId: 'tuning-transcript-check-flag' },
                    {
                      value: 'correct',
                      label: 'correct',
                      testId: 'tuning-transcript-check-correct',
                      // Genuinely `disabled`, not the mock's `role="presentation"`
                      // span: §9 requires a disabled control, not a dimmed one.
                      disabled: mode === 'realtime',
                      title:
                        mode === 'realtime'
                          ? 'No seam in Realtime — the model produces the translation directly, so there is nothing to rewrite before translating.'
                          : undefined,
                    },
                  ]}
                />
                {mode === 'realtime' ? (
                  <p className="text-[11px] text-base-content/50">correct is unavailable: no seam in Realtime.</p>
                ) : (
                  <p className="text-[11px] text-base-content/50">
                    flag — non-blocking; a suspicious segment gets a badge, translation proceeds on the original
                    text. correct — rewrites the source before translation and adds its own latency stage.
                  </p>
                )}
                <SelectKnob
                  id="tuning-transcript-check-model-input"
                  testId="tuning-transcript-check-model"
                  label="Check model"
                  options={textModelOptions}
                  value={mode === 'cascade' ? draft.cascade.transcriptCheck.model : draft.realtime.transcriptCheck.model}
                  knob={knob(`${mode}.transcriptCheck.model`)}
                  onChange={(value) => setKnob(`${mode}.transcriptCheck.model`, value)}
                />
              </TuningSection>

              <TuningSection
                testId="tuning-section-models"
                title="Models & voices"
                summaryBadges={
                  // Only the Deepgram model is a connection-level knob in this
                  // section — translation model and TTS voices apply without a
                  // reconnect — so the chip mirrors Endpointing's rule: show it
                  // only once that row is actually pending.
                  mode === 'cascade' && pendingPaths.has('cascade.deepgram.model') ? (
                    <span className="badge badge-warning badge-soft badge-xs ml-1">reconnects STT</span>
                  ) : null
                }
              >
                {mode === 'cascade' ? (
                  <>
                    <SelectKnob
                      id="tuning-model-deepgram-input"
                      testId="tuning-model-deepgram"
                      label="Deepgram model"
                      options={allowLists.deepgramModels.map((model) => ({ value: model, label: model }))}
                      value={draft.cascade.deepgram.model}
                      knob={knob('cascade.deepgram.model')}
                      onChange={(value) => setKnob('cascade.deepgram.model', value)}
                    />
                    <SelectKnob
                      id="tuning-model-translation-input"
                      testId="tuning-model-translation"
                      label="Translation model"
                      options={textModelOptions}
                      value={draft.cascade.translationModel}
                      knob={knob('cascade.translationModel')}
                      onChange={(value) => setKnob('cascade.translationModel', value)}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <SelectKnob
                        id="tuning-voice-a-input"
                        testId="tuning-voice-a"
                        label="TTS voice A"
                        options={allowLists.elevenLabsVoices.map((voice) => ({ value: voice.id, label: voice.label }))}
                        value={draft.cascade.ttsVoiceA}
                        knob={knob('cascade.ttsVoiceA')}
                        onChange={(value) => setKnob('cascade.ttsVoiceA', value)}
                      />
                      <SelectKnob
                        id="tuning-voice-b-input"
                        testId="tuning-voice-b"
                        label="TTS voice B"
                        options={allowLists.elevenLabsVoices.map((voice) => ({ value: voice.id, label: voice.label }))}
                        value={draft.cascade.ttsVoiceB}
                        knob={knob('cascade.ttsVoiceB')}
                        onChange={(value) => setKnob('cascade.ttsVoiceB', value)}
                      />
                    </div>
                    <p className="text-[11px] text-base-content/50" data-testid="tuning-models-allow-list-note">
                      Every option comes from the server's allow-list (<code>GET /api/tuning/capabilities</code>) —
                      no free text. A value outside it falls back to the default for that picker, and the server
                      logs it.
                    </p>
                  </>
                ) : (
                  <>
                    <SelectKnob
                      id="tuning-model-realtime-input"
                      testId="tuning-model-realtime"
                      label="Realtime model"
                      options={allowLists.realtimeModels.map((model) => ({ value: model, label: model }))}
                      value={draft.realtime.model}
                      knob={knob('realtime.model')}
                      badges={<span className="badge badge-ghost badge-xs">applies at next connect</span>}
                      onChange={(value) => setKnob('realtime.model', value)}
                    />
                    <SelectKnob
                      id="tuning-voice-realtime-input"
                      testId="tuning-voice-realtime"
                      label="Realtime voice"
                      options={allowLists.realtimeVoices.map((voice) => ({ value: voice, label: voice }))}
                      value={draft.realtime.voice}
                      knob={knob('realtime.voice')}
                      badges={<span className="badge badge-ghost badge-xs">applies at next connect</span>}
                      onChange={(value) => setKnob('realtime.voice', value)}
                    />
                    {/* Both rows carry the chip as well: `session.update` cannot change model
                        or voice, so an Apply here is committed but only takes effect on the
                        next `connect()` — a footnote alone is missed while scrolling. */}
                    <p className="text-[11px] text-base-content/50" data-testid="tuning-models-allow-list-note">
                      Both are session-creation parameters, so they apply at next connect. Every option comes
                      from the server's allow-list (<code>GET /api/tuning/capabilities</code>) — no free text;
                      a value outside it is rejected with a 400 when the session is created.
                    </p>
                  </>
                )}
              </TuningSection>
            </>
          )}
        </div>

        <div className="p-3 border-t border-base-300 space-y-2 bg-base-200 rounded-b-box sticky bottom-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              ref={applyButtonRef}
              className={`btn btn-sm btn-primary flex-1 ${!connected && pending.length > 0 ? 'btn-outline' : ''}`}
              data-testid="tuning-apply"
              disabled={pending.length === 0 || applyInFlight}
              onClick={() => void apply(applyTuning)}
            >
              {applyInFlight ? <span className="loading loading-spinner loading-xs" /> : null}
              {applyLabel}
            </button>
            <button
              type="button"
              ref={revertButtonRef}
              className="btn btn-sm btn-ghost"
              data-testid="tuning-revert"
              onClick={revert}
            >
              Revert
            </button>
          </div>
          <p className="text-[11px] text-base-content/60" role="status" aria-live="polite" data-testid="tuning-status">
            {statusLine()}
          </p>
        </div>
      </div>

      {/* Cascade only, deliberately: every word of this dialog is
          about the Deepgram connection failing to reopen. Realtime's
          `session.update` has nothing to reopen and its transport never reports
          a failed apply, so gating on the mode keeps the copy honest rather than
          relying on that never changing. */}
      {applyState === 'failed' && mode === 'cascade' ? (
        <ApplyFailedDialog
          fingerprint={activeFingerprint ?? '—'}
          attempts={attempt}
          failures={applyProgress?.failures ?? []}
          onRetry={() => void apply(applyTuning)}
          onRevert={revert}
          restoreFocus={() => {
            const target = applyButtonRef.current;
            (target?.disabled ? revertButtonRef.current : target)?.focus();
          }}
        />
      ) : null}
    </aside>
  );
}

/**
 * OpenAI's turn-detection knobs (ticket 04), Realtime only. Every row but the
 * type is optional in the strict sense the panel means by that: **greyed means
 * the key is omitted from the outbound payload entirely**, not "set to the
 * documented default". The closing note says so, and this component keeps that
 * literally true — a knob the selected type can't carry is both greyed *and*
 * removed from the document.
 *
 * Which is why switching the type drops the other type's keys. `eagerness` with
 * `server_vad` is an outright 400 from the backend, and a `threshold` left
 * behind under `semantic_vad` would be a key the panel shows greyed while still
 * hashing it into the fingerprint — a config nobody can see.
 */
function RealtimeTurnDetection({
  turnDetection,
  eagernessOptions,
  knob,
  setKnob,
  setProviderDefault,
}: {
  turnDetection: RealtimeTuning['turnDetection'];
  eagernessOptions: SelectOption[];
  knob: (path: string, disabled?: boolean) => KnobState;
  setKnob: (path: string, value: unknown) => void;
  setProviderDefault: (path: string, on: boolean) => void;
}) {
  const serverVad = turnDetection.type === 'server_vad';

  function changeType(type: string): void {
    setKnob(TURN_DETECTION_PATHS.type, type);
    const dropped = type === 'server_vad' ? SEMANTIC_VAD_PATHS : SERVER_VAD_PATHS;
    for (const path of dropped) setProviderDefault(path, true);
  }

  /** A knob is live only when its type applies *and* it is not on Provider default. */
  function optional(path: string, value: unknown, applies: boolean): OptionalKnob {
    return { path, knob: knob(path, !applies || value === undefined), unset: value === undefined, applies };
  }

  const threshold = optional(TURN_DETECTION_PATHS.threshold, turnDetection.threshold, serverVad);
  const prefix = optional(TURN_DETECTION_PATHS.prefixPaddingMs, turnDetection.prefixPaddingMs, serverVad);
  const silence = optional(TURN_DETECTION_PATHS.silenceDurationMs, turnDetection.silenceDurationMs, serverVad);
  const interrupt = optional(TURN_DETECTION_PATHS.interruptResponse, turnDetection.interruptResponse, true);
  const eagerness = optional(TURN_DETECTION_PATHS.eagerness, turnDetection.eagerness, !serverVad);

  return (
    <>
      <SegmentedKnob
        name="tuning-vad-type"
        groupLabel="Turn detection type"
        label="Type"
        wireField="turn_detection.type"
        value={turnDetection.type}
        knob={knob(TURN_DETECTION_PATHS.type)}
        onChange={changeType}
        options={[
          { value: 'server_vad', label: 'server_vad', testId: 'tuning-vad-type-server' },
          { value: 'semantic_vad', label: 'semantic_vad', testId: 'tuning-vad-type-semantic' },
        ]}
      />

      <ProviderDefaultRow testId="tuning-vad-threshold" state={threshold} onChange={setProviderDefault}>
        <RangeKnob
          id="tuning-vad-threshold-input"
          testId="tuning-vad-threshold"
          label="threshold"
          min={0}
          max={1}
          step={0.05}
          value={turnDetection.threshold ?? seedFor<number>(TURN_DETECTION_PATHS.threshold)}
          format={(value) => (threshold.unset ? '—' : value.toFixed(2))}
          knob={threshold.knob}
          onChange={(value) => setKnob(TURN_DETECTION_PATHS.threshold, value)}
        />
      </ProviderDefaultRow>

      <ProviderDefaultRow testId="tuning-vad-prefix-padding" state={prefix} onChange={setProviderDefault}>
        <NumberKnob
          id="tuning-vad-prefix-padding-input"
          testId="tuning-vad-prefix-padding"
          label="prefix_padding_ms"
          min={0}
          max={5000}
          step={10}
          value={turnDetection.prefixPaddingMs ?? seedFor<number>(TURN_DETECTION_PATHS.prefixPaddingMs)}
          knob={prefix.knob}
          onChange={(value) => setKnob(TURN_DETECTION_PATHS.prefixPaddingMs, value)}
        />
      </ProviderDefaultRow>

      <ProviderDefaultRow testId="tuning-vad-silence-duration" state={silence} onChange={setProviderDefault}>
        <NumberKnob
          id="tuning-vad-silence-duration-input"
          testId="tuning-vad-silence-duration"
          label="silence_duration_ms"
          min={0}
          max={10000}
          step={10}
          value={turnDetection.silenceDurationMs ?? seedFor<number>(TURN_DETECTION_PATHS.silenceDurationMs)}
          knob={silence.knob}
          onChange={(value) => setKnob(TURN_DETECTION_PATHS.silenceDurationMs, value)}
        />
      </ProviderDefaultRow>

      {serverVad ? null : (
        <p className="text-[11px] text-base-content/50">
          <span className="font-medium">server_vad only</span> — semantic_vad decides turns from what was said, not
          from a silence threshold.
        </p>
      )}

      <ProviderDefaultRow testId="tuning-vad-interrupt-response" state={interrupt} onChange={setProviderDefault}>
        <KnobRow htmlFor="tuning-vad-interrupt-response-input" label="interrupt_response" knob={interrupt.knob} inline>
          <input
            type="checkbox"
            id="tuning-vad-interrupt-response-input"
            data-testid="tuning-vad-interrupt-response"
            className="toggle toggle-xs toggle-primary"
            checked={turnDetection.interruptResponse ?? seedFor<boolean>(TURN_DETECTION_PATHS.interruptResponse)}
            disabled={interrupt.knob.disabled}
            onChange={(event) => setKnob(TURN_DETECTION_PATHS.interruptResponse, event.target.checked)}
          />
        </KnobRow>
      </ProviderDefaultRow>

      <ProviderDefaultRow testId="tuning-vad-eagerness" state={eagerness} onChange={setProviderDefault}>
        <SelectKnob
          id="tuning-vad-eagerness-input"
          testId="tuning-vad-eagerness"
          label="eagerness"
          options={eagernessOptions}
          value={turnDetection.eagerness ?? seedFor<string>(TURN_DETECTION_PATHS.eagerness)}
          knob={eagerness.knob}
          onChange={(value) => setKnob(TURN_DETECTION_PATHS.eagerness, value)}
          hint={serverVad ? 'semantic_vad only' : undefined}
        />
      </ProviderDefaultRow>

      <p className="text-[11px] text-base-content/50">
        A greyed field is unset — the key is omitted from the payload entirely, so the provider&apos;s own default
        applies.
      </p>
    </>
  );
}

/**
 * One optional knob: the control, then its `Provider default` checkbox. The
 * checkbox is itself disabled when the selected turn-detection type can't carry
 * the key at all, so the panel can't build a document the backend would 400.
 */
function ProviderDefaultRow({
  testId,
  state,
  onChange,
  children,
}: {
  testId: string;
  state: OptionalKnob;
  onChange: (path: string, on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1 min-w-0">{children}</div>
      <ProviderDefaultKnob
        id={`${testId}-default-input`}
        testId={`${testId}-default`}
        checked={state.unset}
        disabled={!state.applies}
        onChange={(on) => onChange(state.path, on)}
      />
    </div>
  );
}

/**
 * A server-side denoise stage. Three ways it can be unusable, each with its own
 * words: wrong mode, not installed, installed-but-broken. `children` receives
 * whether the parameters should be disabled so a row never renders live inputs
 * under a dead toggle.
 */
function ServerStage({
  mode,
  name,
  label,
  toggleTestId,
  unavailableTestId,
  availability,
  enabled,
  onToggle,
  knob,
  children,
}: {
  mode: TuningMode;
  name: DenoiseStageName;
  label: string;
  toggleTestId: string;
  unavailableTestId: string;
  availability: StageAvailability | undefined;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  knob: KnobState;
  children: (disabled: boolean) => ReactNode;
}) {
  const wrongMode = mode !== 'cascade';
  const { label: badgeLabel, unavailable } = stageBadge(availability);
  const disabled = wrongMode || unavailable;

  return (
    <DenoiseStageCard
      id={`${toggleTestId}-input`}
      testId={toggleTestId}
      name={label}
      runsIn="server"
      enabled={enabled}
      onToggle={onToggle}
      knob={{ ...knob, disabled }}
      dashed={wrongMode}
      status={
        wrongMode ? (
          <span className="badge badge-ghost badge-xs">Cascade only</span>
        ) : unavailable ? (
          <span className="badge badge-warning badge-soft badge-xs" data-testid={unavailableTestId}>
            {badgeLabel}
          </span>
        ) : null
      }
      hint={wrongMode ? null : unavailable ? (availability?.reason ?? STAGE_INSTALL_HINT[name]) : null}
    >
      {children(disabled)}
    </DenoiseStageCard>
  );
}

/**
 * Blocking, because after a failed apply you are looking at latency numbers
 * that belong to a config the panel says is not running any more — the one
 * failure this feature cannot tolerate. No dismiss-by-backdrop and no
 * dismiss-by-Escape: the user must choose between Retry and Revert to previous
 * (wireframe §6). Escape is swallowed here rather than left to bubble, because
 * the panel's own Escape handler would otherwise close the whole panel out from
 * under an alertdialog — a dismissal by another name.
 *
 * Rendered as an always-`open` `<dialog>` rather than `showModal()` so the
 * markup is the same in the app and under test; that also means the browser's
 * own modal focus containment doesn't apply, so `Tab` is trapped by hand
 * between the two actions (wireframe §9).
 */
function ApplyFailedDialog({
  fingerprint,
  attempts,
  failures,
  onRetry,
  onRevert,
  restoreFocus,
}: {
  fingerprint: string;
  attempts: number;
  failures: ApplyAttemptFailure[];
  onRetry: () => void;
  onRevert: () => void;
  restoreFocus: () => void;
}) {
  const retryRef = useRef<HTMLButtonElement>(null);
  const revertRef = useRef<HTMLButtonElement>(null);
  // Read through a ref so the mount/unmount effect can stay `[]`: focus is
  // moved in exactly once on open and put back exactly once on close.
  const restoreFocusRef = useRef(restoreFocus);
  restoreFocusRef.current = restoreFocus;

  useEffect(() => {
    retryRef.current?.focus();
    return () => restoreFocusRef.current();
  }, []);

  function trapFocus(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== 'Tab') return;
    // Two actions, so the trap is the pair itself rather than a query over
    // whatever the box happens to contain.
    const order = [revertRef.current, retryRef.current].filter((node) => node !== null);
    if (order.length === 0) return;
    const index = order.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.shiftKey ? index - 1 : index + 1;
    event.preventDefault();
    order[(next + order.length) % order.length].focus();
  }

  return (
    <dialog
      open
      className="modal modal-open"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="tuning-apply-failed-title"
      aria-describedby="tuning-apply-failed-body"
      data-testid="tuning-apply-failed-dialog"
      onKeyDown={trapFocus}
    >
      <div className="modal-box max-w-md">
        <h3 id="tuning-apply-failed-title" className="text-lg font-bold">
          Couldn&apos;t apply the new settings
        </h3>
        <p id="tuning-apply-failed-body" className="py-3 text-sm">
          The speech-to-text connection failed to reopen with the new parameters after {attempts} attempts. The
          session is still running on the previously applied config (<span className="font-mono">{fingerprint}</span>).
        </p>
        {failures.length > 0 ? (
          <ul
            className="rounded-box bg-base-200 p-2 font-mono text-[11px] space-y-0.5"
            data-testid="tuning-apply-failed-log"
          >
            {failures.map((failure) => (
              <li key={failure.attempt}>
                {failure.at.toLocaleTimeString()} · attempt {failure.attempt} of {attempts} · {failure.message}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="modal-action">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-testid="tuning-apply-revert"
            ref={revertRef}
            onClick={onRevert}
          >
            Revert to previous
          </button>
          <button type="button" className="btn btn-sm btn-primary" data-testid="tuning-apply-retry" ref={retryRef} onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Shown until `/api/tuning/capabilities` settles: the panel must not display a value it might have to correct. */
function SectionSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index} className="skeleton h-10 w-full rounded-box" />
      ))}
    </div>
  );
}
