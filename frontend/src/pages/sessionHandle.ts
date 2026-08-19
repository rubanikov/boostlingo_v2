/**
 * `'reconnecting'` (ticket 07, Cascade only) sits between `'connected'` and
 * either `'connected'` again or `'error'`: the browser<->backend WebSocket
 * dropped unexpectedly (not via our own `disconnect()`) and a single resume
 * attempt is in flight. Realtime never produces this value. Its failure
 * surface is WebRTC-level, with no backend-mediated session to resume (see
 * useCascadeSession.ts's resume logic and cascadeResilience.ts's
 * attempt-vs-give-up decision).
 */
import type { ModeTuningConfig } from './tuningConfig';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** The language pair a session is started with: plain data, not tied to either transport. */
export interface SessionLanguages {
  sourceLanguage: string;
  targetLanguage: string;
}

/**
 * One rendered transcript segment: its running text plus its diarized
 * speaker index. `speaker` is `null` when a segment exists but hasn't (or
 * can't be) attributed to a speaker. Cascade mode only, see ticket 04;
 * Realtime mode has no diarization equivalent.
 *
 * `flagged`/`correctedFrom` carry the transcript check's verdict (ticket 14,
 * Cascade source segments only): `flagged` means the check thought the
 * segment was likely misrecognised, and `correctedFrom` — present only in
 * `correct` mode — is the text as first transcribed, before the rewrite
 * that `text` now holds. Both absent for a segment no check ran on, which is
 * every segment when the mode is `off`.
 */
export interface TranscriptSegment {
  id: string;
  text: string;
  speaker: number | null;
  flagged?: boolean;
  correctedFrom?: string;
}

/**
 * One stage of the Cascade server's per-segment latency pipeline (ticket 06):
 * `ms` is cumulative since that segment's `speech_end` (always 0), except
 * `stt_final`, which happened *before* the reference point: its `ms` is the
 * standalone duration between the segment's last final STT result arriving
 * and the segmentation decision that cut the segment.
 *
 * `transcript_check` (ticket 14) sits between `speech_end` and the
 * translation stages, and only arrives when the check ran at all: in `off`
 * mode there is no such stage, and the strip simply skips it.
 */
export type LatencyStage =
  | 'stt_final'
  | 'speech_end'
  | 'transcript_check'
  | 'translation_first_token'
  | 'translation_complete'
  | 'tts_first_byte'
  | 'playback_start';

/**
 * The per-stage latency table for one Cascade segment: whichever stages
 * have arrived so far. See `latencyTracking.ts` for how this is accumulated
 * from incoming `latency` WS messages.
 */
export interface CascadeSegmentLatency {
  segmentId: string;
  stages: Partial<Record<LatencyStage, number>>;
}

/**
 * One active Cascade error toast (ticket 07): a non-blocking, auto-dismissing
 * notice for a `retryable: true` provider failure (rate limit/timeout/
 * connection). One segment was dropped, but the session carries on. See
 * `cascadeResilience.ts`'s `routeCascadeError` for how a server `error`
 * message becomes one of these versus the blocking terminal state.
 */
export interface CascadeToast {
  id: string;
  message: string;
}

/**
 * What a transport reports back from a live mid-session apply (ticket 04's
 * contract; the transports that can do it arrive in tickets 05/07). Lives here
 * rather than in `useTuningConfig.ts`, where ticket 02 first declared it,
 * because it is part of the transport contract. `useTuningConfig.ts` re-exports
 * it so ticket 02's callers keep importing it from where they already do.
 *
 * `fingerprint` is on both arms on purpose: after a failure the panel still has
 * to name the config the session is actually running on.
 */
export type ApplyResult =
  | { ok: true; fingerprint: string; reconnectedStt: boolean; deferred: boolean }
  | { ok: false; fingerprint: string; attempt: number; maxAttempts: number; message: string };

export type ApplyTuning = (config: ModeTuningConfig) => Promise<ApplyResult>;

/** One server-reported failed attempt at applying a config (ticket 07). */
export interface ApplyAttemptFailure {
  attempt: number;
  message: string;
  /** Browser-local, display-only: the failure dialog's attempt log. */
  at: Date;
}

/**
 * Progress of the apply currently on the wire (ticket 07), for the states an
 * `ApplyResult` can't express because it only settles once: which retry the
 * server has reached, and what each failed attempt said.
 *
 * Survives a failed settle: the failure dialog's attempt log is read from it
 * after `applyTuning` has already resolved. Cleared when the next apply starts,
 * or when one succeeds.
 */
export interface ApplyProgress {
  /** The attempt the server is on now, 1-based. */
  attempt: number;
  maxAttempts: number;
  failures: ApplyAttemptFailure[];
}

/**
 * Shared interface both `useCascadeSession` (WebSocket transport) and
 * `useRealtimeSession` (WebRTC transport) implement, so the workbench shell
 * UI can drive either one identically without ever importing a
 * transport-specific type (`WebSocket`, `RTCPeerConnection`, ...).
 */
export interface SessionHandle {
  status: ConnectionStatus;
  errorMessage: string | null;
  sourceText: string;
  targetText: string;
  /**
   * Per-segment breakdown of `sourceText`/`targetText`, carrying each
   * segment's diarized speaker when the transport tracks segments
   * individually (Cascade). Left `undefined` by transports that don't
   * (Realtime accumulates one continuous string with no segment
   * boundaries). The shell falls back to the flat `sourceText`/
   * `targetText` rendering whenever these are absent or empty, which
   * covers Realtime automatically without an explicit mode check.
   */
  sourceSegments?: TranscriptSegment[];
  targetSegments?: TranscriptSegment[];
  /**
   * Realtime only (ticket 15): the flat-text counterpart of a segment's
   * `flagged`. Cascade badges the individual segment the transcript check
   * suspected; Realtime has no segments to badge, so this says the same thing
   * about the turn that just settled, and the shell renders one badge after
   * `sourceText`. Cleared when the next turn starts. Left `undefined` by
   * Cascade, which reports per-segment `flagged` instead.
   */
  sourceFlagged?: boolean;
  /** Current mic input level, 0-1, for driving a live level meter. */
  micLevel: number;
  /**
   * Cascade only (ticket 06): the most recently *completed* segment's
   * per-stage latency table: "completed" meaning its `playback_start`
   * stage has arrived, at which point the strip switches to showing that
   * segment until the next one completes. `null` before any segment has
   * completed. Left `undefined` by Realtime, which has no server-side
   * per-stage visibility to report. Mirrors the sourceSegments/
   * targetSegments fallback pattern from ticket 04.
   */
  cascadeLatency?: CascadeSegmentLatency | null;
  /**
   * Cascade only (ticket 07): active non-blocking error toasts for
   * `retryable: true` provider failures: the shell renders and
   * auto-dismisses these without interrupting the transcript/latency UI.
   * Always an array (possibly empty) once Cascade is in play, mirroring the
   * sourceSegments/targetSegments pattern; left `undefined` by Realtime,
   * which has no backend-mediated segments to report these for.
   */
  cascadeToasts?: CascadeToast[];
  /**
   * Cascade only (ticket 05): a short display label for the most recent
   * `segment_boundary` trigger seen for each segmentId (see
   * `segmentation.ts`'s `segmentTriggerLabel`). Lets the transcript panes
   * annotate which segmentation mechanism (the LLM clause check vs. a
   * Deepgram signal) ended each segment, for the hybrid-race vs.
   * LLM-priority comparison write-up. Left `undefined` by Realtime, which
   * has no `segment_boundary` equivalent.
   */
  segmentTriggers?: Record<string, string>;
  /**
   * Realtime only (ticket 06): end-to-end ms for the current/most recent
   * turn, measured entirely client-side (see `realtimeLatency.ts`) since
   * the backend has no visibility once the ephemeral token is issued.
   * `null` before the first turn's measurement lands, or between turns.
   * Left `undefined` by Cascade, which reports real per-stage numbers
   * instead.
   */
  endToEndLatencyMs?: number | null;
  /**
   * The fingerprint the transport is actually running on, once the server has
   * confirmed it (ticket 04): `POST /api/realtime/session`'s `fingerprint` for
   * Realtime, the `tuning_applied` message's for Cascade. `null` while
   * disconnected, or when the server is old enough not to report one — the
   * shell then falls back to the locally computed fingerprint. Left `undefined`
   * by a transport that doesn't carry tuning at all yet.
   */
  appliedFingerprint?: string | null;
  /**
   * Live mid-session apply (tickets 05/07). Left `undefined` by a transport
   * that can't do it, which the panel reads as "commit locally" — the same
   * thing it does while disconnected.
   */
  applyTuning?: ApplyTuning;
  /**
   * How the apply currently on the wire is going (ticket 07): the retry the
   * server has reached, and every attempt that has failed so far. `null`
   * between applies. Left `undefined` by a transport whose applies can't fail
   * partway (Realtime's `session.update` is fire-and-forget over an open data
   * channel — there is no retry to report).
   */
  applyProgress?: ApplyProgress | null;
  /**
   * `tuning` is the config this session should start with (ticket 04). It is
   * optional so a caller that has none — and every pre-tuning call site —
   * keeps compiling and keeps today's server-default behaviour exactly.
   */
  connect: (languages: SessionLanguages, tuning?: ModeTuningConfig) => void;
  /** Tears the session down (transport + mic + audio contexts) and resets to `'idle'`, without unmounting. */
  disconnect: () => void;
}

// The brief's only required pair for this ticket.
export const DEFAULT_LANGUAGES: SessionLanguages = { sourceLanguage: 'en', targetLanguage: 'es' };
