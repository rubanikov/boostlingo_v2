import { useRef, useState } from 'react';
import { latencyBadges, type LatencyBadge } from './latencyTracking';
import type { CascadeSegmentLatency, ConnectionStatus, SessionHandle, SessionLanguages, TranscriptSegment } from './sessionHandle';
import { TuningPanel } from './TuningPanel';
import { useCascadeSession } from './useCascadeSession';
import { useRealtimeSession } from './useRealtimeSession';
import { useTuningConfig } from './useTuningConfig';

type Mode = 'cascade' | 'realtime';

interface LanguagePairOption {
  key: string;
  label: string;
  languages: SessionLanguages;
}

// Each entry must be backed by the backend's `SUPPORTED_LANGUAGES`
// allow-list (`backend/app/languages.py`); adding a pair is one entry here
// plus one there. Direction within a pair is auto-resolved per utterance
// from the detected language, so there's no separate swap control.
const LANGUAGE_PAIR_OPTIONS: LanguagePairOption[] = [
  { key: 'en-es', label: 'English ↔ Spanish', languages: { sourceLanguage: 'en', targetLanguage: 'es' } },
  { key: 'en-fr', label: 'English ↔ French', languages: { sourceLanguage: 'en', targetLanguage: 'fr' } },
];

const MODES: { key: Mode; label: string }[] = [
  { key: 'cascade', label: 'Cascade' },
  { key: 'realtime', label: 'Realtime' },
];

const CONNECTION_BADGE: Record<ConnectionStatus, { label: string; className: string }> = {
  idle: { label: 'Not connected', className: 'badge badge-ghost gap-1' },
  connecting: { label: 'Connecting…', className: 'badge badge-ghost gap-1' },
  connected: { label: 'Connected', className: 'badge badge-success badge-soft gap-1' },
  // ticket 07, Cascade only: the browser<->backend WebSocket dropped
  // unexpectedly and a single resume attempt is in flight: amber/warning,
  // distinct from both the green "Connected" and red "Error" states.
  reconnecting: { label: 'Reconnecting…', className: 'badge badge-warning badge-soft gap-1' },
  error: { label: 'Error', className: 'badge badge-error badge-soft gap-1' },
};

const CONNECTION_DOT_CLASS: Record<ConnectionStatus, string> = {
  idle: 'bg-base-content/40',
  connecting: 'bg-base-content/40',
  connected: 'bg-success',
  reconnecting: 'bg-warning',
  error: 'bg-error',
};

const MIC_BADGE: Record<ConnectionStatus, { label: string; className: string }> = {
  idle: { label: 'Not listening', className: 'badge badge-ghost' },
  connecting: { label: 'Connecting…', className: 'badge badge-ghost' },
  connected: { label: 'Listening', className: 'badge badge-success badge-soft' },
  reconnecting: { label: 'Reconnecting…', className: 'badge badge-warning badge-soft' },
  error: { label: 'Error', className: 'badge badge-error badge-soft' },
};

const MIC_BUTTON_TONE_CLASS: Record<ConnectionStatus, string> = {
  idle: 'btn-primary',
  connecting: 'btn-primary',
  connected: 'btn-success',
  reconnecting: 'btn-warning',
  error: 'btn-error',
};

const MIC_BUTTON_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Connect microphone',
  connecting: 'Connecting…',
  connected: 'Disconnect microphone',
  reconnecting: 'Reconnecting…',
  error: 'Retry connection',
};

interface SpeakerStyle {
  label: string;
  wrapperClass: string;
  badgeClass: string;
}

// Diarized speaker -> visual treatment (ticket 04, Cascade mode only): speaker
// 0 gets the blue "A" styling, speaker 1 the orange "B" styling, per the
// approved prototype (see the .speakerA/.speakerB rules added to index.css).
// Per-segment language isn't in the wire contract yet (see ticket 04's
// notes), so badges show "Speaker A"/"Speaker B" without a language suffix
// for now, in both the source and target panes.
const SPEAKER_STYLES: Record<number, SpeakerStyle> = {
  0: { label: 'Speaker A', wrapperClass: 'speakerA', badgeClass: 'speakerA-badge' },
  1: { label: 'Speaker B', wrapperClass: 'speakerB', badgeClass: 'speakerB-badge' },
};

// Only two speakers are in scope for diarization today; an unrecognized
// index still renders as a (uncolored) labeled segment rather than being
// silently dropped.
function speakerStyle(speaker: number): SpeakerStyle {
  return SPEAKER_STYLES[speaker] ?? { label: `Speaker ${speaker + 1}`, wrapperClass: '', badgeClass: 'badge-neutral' };
}

/**
 * The transcript check's verdict, as it appears in a pane: a Cascade segment's
 * (ticket 14) and a settled Realtime turn's (ticket 15) are the same finding
 * about the same thing, so they are one badge rather than two kept in sync. The
 * leading space keeps it off the last word of the text.
 *
 * In `correct` mode the hover title also carries what the text used to be: the
 * pane is already showing the rewrite, and the original is otherwise nowhere on
 * screen.
 */
function SuspiciousBadge({ correctedFrom }: { correctedFrom?: string }) {
  const flagged = 'Transcript check flagged this segment as likely misrecognised';
  return (
    <>
      {' '}
      <span
        data-testid="segment-suspicious-badge"
        className="badge badge-warning badge-soft badge-xs"
        title={correctedFrom === undefined ? flagged : `${flagged} and rewrote it — was: ${correctedFrom}`}
      >
        ⚑ check
      </span>
    </>
  );
}

/**
 * Renders one transcript pane's body. When the transport tracks segments
 * individually and has at least one (Cascade), each segment with a diarized
 * speaker gets a color-coded badge; a segment without one renders as a
 * plain paragraph. When there are no segments at all (Realtime, which
 * accumulates one continuous string with no segment boundaries, or Cascade
 * before anything has streamed in), this falls back to the same
 * plain-paragraph rendering the pane always used, so Realtime mode never
 * needs an explicit mode check to stay badge-free.
 *
 * `triggerLabelBySegment` (ticket 05, Cascade only) annotates each segment
 * with the short label for whatever `segment_boundary` trigger ended it
 * (e.g. "(llm)" or "(pause)") once that message has arrived: a cheap,
 * dev-facing way to compare the hybrid-race and LLM-priority segmentation
 * mechanisms without a dedicated dashboard. Left absent/`undefined` by
 * Realtime and by any segment `segment_boundary` hasn't reported on yet.
 *
 * `flatFlagged` (ticket 15, Realtime only) is the transcript check's verdict
 * on the turn that just settled, and only reaches the screen on the
 * no-segments path: it is what a segment's `flagged` is for a transport with
 * no segments to hang one on.
 */
function TranscriptPaneBody({
  segments,
  flatText,
  flatFlagged,
  testId,
  triggerLabelBySegment,
}: {
  segments: TranscriptSegment[] | undefined;
  flatText: string;
  flatFlagged?: boolean;
  testId: string;
  triggerLabelBySegment?: Record<string, string>;
}) {
  if (!segments || segments.length === 0) {
    return (
      <p className="text-sm" data-testid={testId}>
        {flatText}
        {flatFlagged ? <SuspiciousBadge /> : null}
      </p>
    );
  }

  return (
    <div data-testid={testId}>
      {segments.map((segment) => {
        const trigger = triggerLabelBySegment?.[segment.id];
        const triggerAnnotation = trigger ? (
          <span className="text-base-content/40 text-[10px]"> ({trigger})</span>
        ) : null;
        const suspiciousBadge = segment.flagged ? <SuspiciousBadge correctedFrom={segment.correctedFrom} /> : null;
        if (segment.speaker === null || segment.speaker === undefined) {
          return (
            <p key={segment.id} className="text-sm">
              {segment.text}
              {triggerAnnotation}
              {suspiciousBadge}
            </p>
          );
        }
        const style = speakerStyle(segment.speaker);
        return (
          <div key={segment.id} className={`${style.wrapperClass} pl-3 py-1`}>
            <span className={`badge ${style.badgeClass} badge-xs mb-1`}>{style.label}</span>
            <p className="text-sm">
              {segment.text}
              {triggerAnnotation}
              {suspiciousBadge}
            </p>
          </div>
        );
      })}
    </div>
  );
}

const FINGERPRINT_CHIP_CLASS = 'badge badge-ghost badge-xs font-mono shrink-0';

/**
 * The applied tuning config's fingerprint (ticket 01), rendered wherever you
 * need to read it off the screen: the navbar and beside the latency numbers it
 * produced. `null` while `/api/tuning/capabilities` is still in flight, which
 * shows as a skeleton rather than a wrong-then-corrected hash.
 *
 * Its own element, never nested inside `cascade-latency-strip` /
 * `realtime-latency-badge`: the capture harness scrapes those for `/(\d+)\s*ms/`
 * and must not start matching config text.
 */
function FingerprintChip({ testId, value }: { testId: string; value: string | null }) {
  if (value === null) {
    return <span className={`${FINGERPRINT_CHIP_CLASS} skeleton w-20`} data-testid={testId} aria-hidden="true" />;
  }
  return (
    <span className={FINGERPRINT_CHIP_CLASS} data-testid={testId} title="Applied tuning config">
      {value}
    </span>
  );
}

const LATENCY_BADGE_TONE_CLASS: Record<LatencyBadge['tone'], string> = {
  ghost: 'badge badge-ghost',
  warning: 'badge badge-warning badge-soft',
  primary: 'badge badge-primary',
};

// The brief's targets for each mode (ticket 06): Cascade's server round trip
// budget is looser than Realtime's since it's speech -> STT -> MT -> TTS ->
// playback, versus Realtime's single model hop.
const CASCADE_LATENCY_TARGET_MS = 2000;
const REALTIME_LATENCY_TARGET_MS = 1500;

/**
 * Cascade-only latency strip (ticket 06): the live per-stage breakdown for
 * the most recently *completed* segment (its `playback_start` stage has
 * arrived). Stays showing that segment until the next one completes.
 * Markup faithfully follows the approved prototype
 * (.lavish/ticket-09-ui-ux-layout.html lines 74-92): one badge per stage
 * that's arrived, the biggest inter-stage jump flagged as the likely
 * bottleneck, `playback_start` always highlighted as the final benchmark
 * number, and a progress bar against the target.
 */
function CascadeLatencyStrip({
  latency,
  configFingerprint,
}: {
  latency: CascadeSegmentLatency;
  configFingerprint: string | null;
}) {
  const badges = latencyBadges(latency.stages);
  const totalMs = latency.stages.playback_start ?? 0;

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body p-3 flex-row items-center gap-3">
        <div
          className="flex flex-1 min-w-0 items-center gap-4 text-xs overflow-x-auto"
          data-testid="cascade-latency-strip"
        >
          <span className="font-medium text-base-content/60 shrink-0">Latency</span>
          {badges.flatMap((badge, index) => {
            const nodes = [];
            if (index > 0) {
              nodes.push(
                <span key={`${badge.stage}-arrow`} className="text-base-content/30">
                  →
                </span>,
              );
            }
            nodes.push(
              <span key={badge.stage} className={LATENCY_BADGE_TONE_CLASS[badge.tone]}>
                {badge.label} {badge.ms}ms
              </span>,
            );
            return nodes;
          })}
          <progress
            className="progress progress-success w-32 ml-auto shrink-0"
            value={totalMs}
            max={CASCADE_LATENCY_TARGET_MS}
          />
          <span className="text-base-content/50 shrink-0">/ {CASCADE_LATENCY_TARGET_MS}ms target</span>
        </div>
        <FingerprintChip testId="tuning-fingerprint-latency" value={configFingerprint} />
      </div>
    </div>
  );
}

/**
 * Realtime-only latency badge (ticket 06): a single end-to-end number, not a
 * per-stage breakdown: the backend has no sub-stage visibility once the
 * ephemeral token is issued (ticket 03), so there is nothing to break down.
 * This asymmetry with Cascade's strip is intentional, not a gap. `null`
 * before the current turn's measurement lands (see useRealtimeSession /
 * realtimeLatency.ts).
 */
function RealtimeLatencyBadge({
  endToEndLatencyMs,
  configFingerprint,
}: {
  endToEndLatencyMs: number | null;
  configFingerprint: string | null;
}) {
  const toneClass =
    endToEndLatencyMs === null
      ? 'badge badge-ghost'
      : endToEndLatencyMs <= REALTIME_LATENCY_TARGET_MS
        ? 'badge badge-success badge-soft'
        : 'badge badge-error badge-soft';

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body p-3 flex-row items-center gap-3">
        <div className="flex items-center gap-2 text-xs" data-testid="realtime-latency-badge">
          <span className="font-medium text-base-content/60">Latency</span>
          <span className={toneClass}>{endToEndLatencyMs === null ? '—' : `${endToEndLatencyMs}ms`}</span>
          <span className="text-base-content/50">/ {REALTIME_LATENCY_TARGET_MS}ms target</span>
        </div>
        <FingerprintChip testId="tuning-fingerprint-latency" value={configFingerprint} />
      </div>
    </div>
  );
}

/**
 * The unified workbench shell (Ticket 3): mode tabs (Cascade/Realtime),
 * language-pair selector, connection-status badge, dual-column source/target
 * transcripts, and a mic control with a live level meter.
 *
 * Both session hooks are always mounted so mode switching never needs to
 * remount a hook mid-session. The shell only ever reads/writes through the
 * shared `SessionHandle` shape, never `RTCPeerConnection`/`WebSocket` types.
 */
export function WorkbenchPage() {
  const cascadeSession = useCascadeSession();
  const realtimeSession = useRealtimeSession();
  const [mode, setMode] = useState<Mode>('cascade');
  const [languagePairKey, setLanguagePairKey] = useState(LANGUAGE_PAIR_OPTIONS[0].key);
  const [tuningOpen, setTuningOpen] = useState(false);
  const tuningToggleRef = useRef<HTMLButtonElement>(null);

  // The tuning document for the mode on screen (ticket 02). The hook owns the
  // capabilities fetch, so the panel and the chips can never disagree about
  // which config is applied. Mounted whether or not the panel is open: the
  // fingerprint chips and the pending badge are the collapsed-state contract.
  const tuning = useTuningConfig(mode);

  const session: SessionHandle = mode === 'cascade' ? cascadeSession : realtimeSession;
  const selectedPair = LANGUAGE_PAIR_OPTIONS.find((option) => option.key === languagePairKey) ?? LANGUAGE_PAIR_OPTIONS[0];

  // Mode is part of the hash on purpose (the same knobs in different modes are
  // different runs), so switching tabs changes the chip.
  //
  // A running session's fingerprint comes from the *server* (ticket 04): it is
  // the hash of what the backend says it applied, so the chip can never claim a
  // config the provider was not actually asked for. The locally computed one is
  // the fallback — while disconnected, and against a server too old to report
  // one.
  const tuningFingerprint = session.appliedFingerprint ?? tuning.activeFingerprint;
  const pendingCount = tuning.pending.length;
  // What the next connect() sends, and what a live apply would move away from.
  const appliedForMode = tuning.applied[mode];

  function closeTuningPanel() {
    setTuningOpen(false);
    // Escape and the close button both put focus back where it came from,
    // rather than dropping it on `<body>`.
    tuningToggleRef.current?.focus();
  }

  function handleModeChange(nextMode: Mode) {
    if (nextMode === mode) return;
    // Mid-session mode switch: cleanly tear down whichever transport is
    // currently live before handing the UI to the other hook. Pre-session
    // (status 'idle'), there's nothing to tear down.
    if (session.status !== 'idle') {
      session.disconnect();
    }
    setMode(nextMode);
  }

  function handleMicClick() {
    if (session.status === 'connected') {
      session.disconnect();
    } else if (session.status === 'idle' || session.status === 'error') {
      session.connect(selectedPair.languages, appliedForMode);
    }
  }

  const connectionBadge = CONNECTION_BADGE[session.status];
  const micBadge = MIC_BADGE[session.status];

  return (
    <div className="mx-auto max-w-6xl px-4 py-4 space-y-4">
      <div className="navbar bg-base-200 rounded-box">
        <div className="navbar-start gap-3">
          <div role="tablist" className="tabs tabs-box tabs-sm">
            {MODES.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                className={`tab ${mode === key ? 'tab-active' : ''}`}
                onClick={() => handleModeChange(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            className="select select-sm w-40"
            aria-label="Language pair"
            value={languagePairKey}
            onChange={(event) => setLanguagePairKey(event.target.value)}
          >
            {LANGUAGE_PAIR_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="navbar-end gap-2">
          {/* Before the connection badge, per wireframe §1: the badge stays the
              right-most, highest-salience element. */}
          <button
            type="button"
            ref={tuningToggleRef}
            className={`btn btn-sm btn-ghost gap-2 ${tuningOpen ? 'btn-active' : ''}`}
            aria-expanded={tuningOpen}
            aria-controls="tuning-panel"
            data-testid="tuning-toggle"
            onClick={() => (tuningOpen ? closeTuningPanel() : setTuningOpen(true))}
          >
            <span aria-hidden="true">🎛</span>
            Tuning
            <FingerprintChip testId="tuning-fingerprint" value={tuningFingerprint} />
            {pendingCount > 0 ? (
              <span className="badge badge-warning badge-xs" data-testid="tuning-pending-count">
                {pendingCount} pending
              </span>
            ) : null}
          </button>
          <span className={connectionBadge.className} role="status">
            <span className={`w-2 h-2 rounded-full ${CONNECTION_DOT_CLASS[session.status]}`} />
            {connectionBadge.label}
          </span>
        </div>
      </div>

      {session.status === 'error' && session.errorMessage ? (
        // Blocking, can't-miss banner (ticket 07): covers mic-permission-denied,
        // Cascade's circuit-open "interpretation unavailable" state, and a
        // failed/impossible session resume alike; the message text is what
        // distinguishes them, the treatment is deliberately identical. "Try
        // again" re-runs connect() from scratch (fresh getUserMedia() call,
        // fresh backend session). No page reload.
        <div role="alert" className="alert alert-error shadow-lg">
          <span className="flex-1 font-medium">{session.errorMessage}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => session.connect(selectedPair.languages, appliedForMode)}
          >
            Try again
          </button>
        </div>
      ) : null}

      {session.cascadeToasts && session.cascadeToasts.length > 0 ? (
        // Non-blocking (ticket 07): a run of retryable segment failures
        // (rate limit/timeout/connection). Auto-dismisses on its own, never
        // requires user interaction, and never covers the transcript/latency
        // UI. `role="status"` (polite) rather than `role="alert"`
        // (assertive), matching how disruptive this is meant to be.
        <div className="toast toast-top toast-end z-50">
          {session.cascadeToasts.map((toast) => (
            <div key={toast.id} role="status" className="alert alert-warning alert-soft text-sm">
              <span>{toast.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Two-column shell (wireframe §1): the panel takes a fixed right-hand
          column and the page shrinks beside it, so the transcripts and the
          latency strip stay on screen the whole time you are tuning — turn a
          knob, press Apply, watch the very next segment. `min-w-0` matters:
          without it the latency strip's `overflow-x-auto` will not shrink. */}
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-4">
          {session.cascadeLatency ? (
            <CascadeLatencyStrip latency={session.cascadeLatency} configFingerprint={tuningFingerprint} />
          ) : null}
          {session.endToEndLatencyMs !== undefined ? (
            <RealtimeLatencyBadge endToEndLatencyMs={session.endToEndLatencyMs} configFingerprint={tuningFingerprint} />
          ) : null}

          <div className={`grid gap-4 ${tuningOpen ? '' : 'sm:grid-cols-2'}`}>
            <div className="card card-border bg-base-100 h-[420px] flex flex-col">
              <div className="card-body p-4 flex flex-col gap-3 overflow-y-auto">
                <h3 className="text-xs uppercase tracking-wide text-base-content/50">Source</h3>
                <TranscriptPaneBody
                  segments={session.sourceSegments}
                  flatText={session.sourceText}
                  flatFlagged={session.sourceFlagged}
                  testId="source-transcript"
                  triggerLabelBySegment={session.segmentTriggers}
                />
              </div>
            </div>
            <div className="card card-border bg-base-100 h-[420px] flex flex-col">
              <div className="card-body p-4 flex flex-col gap-3 overflow-y-auto">
                <h3 className="text-xs uppercase tracking-wide text-base-content/50">Target</h3>
                <TranscriptPaneBody
                  segments={session.targetSegments}
                  flatText={session.targetText}
                  testId="target-transcript"
                  triggerLabelBySegment={session.segmentTriggers}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center gap-4 py-2">
            <div className="w-40 h-2 rounded-full bg-base-300 overflow-hidden">
              <div
                className="h-full bg-success"
                data-testid="mic-level-bar"
                style={{ width: `${Math.round(session.micLevel * 100)}%` }}
              />
            </div>
            <button
              type="button"
              aria-label={MIC_BUTTON_LABEL[session.status]}
              className={`btn btn-circle btn-lg ${MIC_BUTTON_TONE_CLASS[session.status]}`}
              disabled={session.status === 'connecting' || session.status === 'reconnecting'}
              onClick={handleMicClick}
            >
              🎙️
            </button>
            <span className={micBadge.className}>{micBadge.label}</span>
          </div>
        </div>

        {tuningOpen ? (
          <TuningPanel
            mode={mode}
            tuning={tuning}
            connectionStatus={session.status}
            onClose={closeTuningPanel}
            appliedFingerprint={session.appliedFingerprint}
            applyTuning={session.applyTuning}
            applyProgress={session.applyProgress}
          />
        ) : null}
      </div>

      {/* Not shown to the user. Realtime mode's remote speech plays through this element once connected. */}
      <audio ref={realtimeSession.audioRef} autoPlay hidden data-testid="realtime-audio" />
    </div>
  );
}
