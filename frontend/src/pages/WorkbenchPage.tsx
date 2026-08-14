import { useState } from 'react';
import { latencyBadges, type LatencyBadge } from './latencyTracking';
import type { CascadeSegmentLatency, ConnectionStatus, SessionHandle, SessionLanguages, TranscriptSegment } from './sessionHandle';
import { useCascadeSession } from './useCascadeSession';
import { useRealtimeSession } from './useRealtimeSession';

type Mode = 'cascade' | 'realtime';

interface LanguagePairOption {
  key: string;
  label: string;
  languages: SessionLanguages;
}

// The brief's only required pair for this ticket: modeled as a list (not a
// hardcoded pair) so adding more later is just adding another entry.
const LANGUAGE_PAIR_OPTIONS: LanguagePairOption[] = [
  { key: 'en-es', label: 'English ↔ Spanish', languages: { sourceLanguage: 'en', targetLanguage: 'es' } },
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
 */
function TranscriptPaneBody({
  segments,
  flatText,
  testId,
  triggerLabelBySegment,
}: {
  segments: TranscriptSegment[] | undefined;
  flatText: string;
  testId: string;
  triggerLabelBySegment?: Record<string, string>;
}) {
  if (!segments || segments.length === 0) {
    return (
      <p className="text-sm" data-testid={testId}>
        {flatText}
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
        if (segment.speaker === null || segment.speaker === undefined) {
          return (
            <p key={segment.id} className="text-sm">
              {segment.text}
              {triggerAnnotation}
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
            </p>
          </div>
        );
      })}
    </div>
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
function CascadeLatencyStrip({ latency }: { latency: CascadeSegmentLatency }) {
  const badges = latencyBadges(latency.stages);
  const totalMs = latency.stages.playback_start ?? 0;

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body p-3">
        <div className="flex items-center gap-4 text-xs overflow-x-auto" data-testid="cascade-latency-strip">
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
function RealtimeLatencyBadge({ endToEndLatencyMs }: { endToEndLatencyMs: number | null }) {
  const toneClass =
    endToEndLatencyMs === null
      ? 'badge badge-ghost'
      : endToEndLatencyMs <= REALTIME_LATENCY_TARGET_MS
        ? 'badge badge-success badge-soft'
        : 'badge badge-error badge-soft';

  return (
    <div className="card card-border bg-base-100">
      <div className="card-body p-3">
        <div className="flex items-center gap-2 text-xs" data-testid="realtime-latency-badge">
          <span className="font-medium text-base-content/60">Latency</span>
          <span className={toneClass}>{endToEndLatencyMs === null ? '—' : `${endToEndLatencyMs}ms`}</span>
          <span className="text-base-content/50">/ {REALTIME_LATENCY_TARGET_MS}ms target</span>
        </div>
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

  const session: SessionHandle = mode === 'cascade' ? cascadeSession : realtimeSession;
  const selectedPair = LANGUAGE_PAIR_OPTIONS.find((option) => option.key === languagePairKey) ?? LANGUAGE_PAIR_OPTIONS[0];

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
      session.connect(selectedPair.languages);
    }
  }

  const connectionBadge = CONNECTION_BADGE[session.status];
  const micBadge = MIC_BADGE[session.status];

  return (
    <div className="space-y-4">
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
          <button type="button" className="btn btn-sm" onClick={() => session.connect(selectedPair.languages)}>
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

      {session.cascadeLatency ? <CascadeLatencyStrip latency={session.cascadeLatency} /> : null}
      {session.endToEndLatencyMs !== undefined ? (
        <RealtimeLatencyBadge endToEndLatencyMs={session.endToEndLatencyMs} />
      ) : null}

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="card card-border bg-base-100 h-[420px] flex flex-col">
          <div className="card-body p-4 flex flex-col gap-3 overflow-y-auto">
            <h3 className="text-xs uppercase tracking-wide text-base-content/50">Source</h3>
            <TranscriptPaneBody
              segments={session.sourceSegments}
              flatText={session.sourceText}
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

      {/* Not shown to the user. Realtime mode's remote speech plays through this element once connected. */}
      <audio ref={realtimeSession.audioRef} autoPlay hidden data-testid="realtime-audio" />
    </div>
  );
}
