/**
 * `'reconnecting'` (ticket 07, Cascade only) sits between `'connected'` and
 * either `'connected'` again or `'error'`: the browser<->backend WebSocket
 * dropped unexpectedly (not via our own `disconnect()`) and a single resume
 * attempt is in flight. Realtime never produces this value. Its failure
 * surface is WebRTC-level, with no backend-mediated session to resume (see
 * useCascadeSession.ts's resume logic and cascadeResilience.ts's
 * attempt-vs-give-up decision).
 */
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
 */
export interface TranscriptSegment {
  id: string;
  text: string;
  speaker: number | null;
}

/**
 * One stage of the Cascade server's per-segment latency pipeline (ticket 06):
 * `ms` is cumulative since that segment's `speech_end` (always 0), except
 * `stt_final`, which happened *before* the reference point: its `ms` is the
 * standalone duration between the segment's last final STT result arriving
 * and the segmentation decision that cut the segment.
 */
export type LatencyStage =
  | 'stt_final'
  | 'speech_end'
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
  connect: (languages: SessionLanguages) => void;
  /** Tears the session down (transport + mic + audio contexts) and resets to `'idle'`, without unmounting. */
  disconnect: () => void;
}

// The brief's only required pair for this ticket.
export const DEFAULT_LANGUAGES: SessionLanguages = { sourceLanguage: 'en', targetLanguage: 'es' };
