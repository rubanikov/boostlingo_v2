import { useCallback, useEffect, useRef, useState } from 'react';
import { decideResume, routeCascadeError } from './cascadeResilience';
import {
  CASCADE_PCM_TARGET_SAMPLE_RATE,
  CASCADE_PCM_WORKLET_NAME,
  CASCADE_PCM_WORKLET_URL,
  CASCADE_WS_ENDPOINT,
} from './cascadeConfig';
import { GATE_WORKLET_NAME, GATE_WORKLET_URL } from './gateConfig';
import { RNNOISE_CONTEXT_SAMPLE_RATE, createRnnoiseNode } from './rnnoiseConfig';
import { createGaplessPlayer, type GaplessPlayer } from './gaplessPlayer';
import {
  EMPTY_CASCADE_LATENCY,
  currentCascadeLatency,
  isLatencyStage,
  recordLatencyStage,
  type CascadeLatencyState,
} from './latencyTracking';
import { requestMicStream, stopMediaStream } from './mediaStream';
import { startMicLevelMeter, type MicLevelMeter } from './micLevel';
import { int16BufferToFloat32 } from './pcm';
import { resolveSegmentationModeOverride, segmentTriggerLabel } from './segmentation';
import type {
  ApplyProgress,
  ApplyResult,
  ApplyTuning,
  CascadeToast,
  ConnectionStatus,
  SessionHandle,
  SessionLanguages,
} from './sessionHandle';
import {
  EMPTY_TRANSCRIPT_PANE,
  appendTranscriptSegment,
  applyTranscriptCheck,
  paneText,
  type TranscriptPaneState,
} from './transcriptPane';
import {
  DEEPGRAM_CONNECTION_LEVEL_PATHS,
  DEFAULT_TUNING_CONFIG,
  clampGateParams,
  diff,
  fingerprint,
  type ClientTuning,
  type ModeTuningConfig,
} from './tuningConfig';
import { APPLY_MAX_ATTEMPTS } from './useTuningConfig';

export type { ConnectionStatus } from './sessionHandle';

// Clock-sync ping cadence (ticket 06): once right after start_session, then
// every 30s for the life of the session. Accounts for clock drift over the
// brief's 5-minute stability window. The server does the offset math; we
// just keep pinging.
const CLOCK_SYNC_INTERVAL_MS = 30_000;

// How long a non-blocking error toast (ticket 07) stays on screen before
// auto-dismissing: long enough to notice, short enough not to pile up
// across a run of retryable segment failures.
const CASCADE_TOAST_DURATION_MS = 5_000;

// Extra time to keep the mic muted past the scheduled end of TTS playback:
// covers speaker/room acoustic decay and scheduling slop, so the tail of our
// own voice output doesn't get picked back up as the start of a new segment.
const PLAYBACK_MUTE_TAIL_MS = 200;

/**
 * How long an `update_tuning` waits for its `tuning_applied`/`tuning_failed`
 * before the panel is told nobody answered (ticket 06). It sits past the
 * server's own reconnect budget (`_resilience.py`: 3 attempts, ~3.5 s of
 * backoff plus the time to reopen the Deepgram socket three times), so it can
 * only fire on a reply that is never coming. Ticket 06's original 10 s was
 * raised for that reason once an apply could mean a deliberate Deepgram
 * reconnect (ticket 07): a timeout firing during a reconnect the server is
 * still winning would report a failure that isn't one.
 */
const TUNING_APPLY_TIMEOUT_MS = 20_000;

/** Paths whose change makes the server reopen the Deepgram socket. */
const CONNECTION_LEVEL_PATHS = new Set<string>(DEEPGRAM_CONNECTION_LEVEL_PATHS);

interface ServerEnvelope {
  type: string;
  segmentId?: string;
  text?: string;
  isFinal?: boolean;
  trigger?: string;
  sampleRate?: number;
  /** Diarized speaker index (ticket 04): additive on source_transcript/target_transcript/tts_audio_meta. */
  speaker?: number | null;
  /**
   * Present on a `source_transcript` re-sent by the transcript check (ticket
   * 14). `flagged` is what marks the message as a verdict rather than more
   * streamed text; `correctedFrom` accompanies it only in `correct` mode.
   */
  flagged?: boolean;
  correctedFrom?: string;
  /** Present on `latency` messages (ticket 06). */
  stage?: string;
  ms?: number;
  /** Present on `session_started` (ticket 07): stored for a later `resume_session` attempt. */
  sessionId?: string;
  /** Present on `error` messages (ticket 07). */
  provider?: string;
  kind?: string;
  message?: string;
  retryable?: boolean;
  /**
   * Present on `tuning_applied`/`tuning_failed` (ticket 06). `requestId` is
   * `null` on the unsolicited `tuning_applied` the server sends right after
   * `session_started` to publish the start-of-session fingerprint.
   */
  requestId?: string | null;
  fingerprint?: string;
  reconnectedStt?: boolean;
  attempt?: number;
  maxAttempts?: number;
}

/**
 * `SessionHandle` with the live-tuning members (ticket 06) narrowed from
 * optional to always-present, since Cascade implements all of them. Extending
 * rather than redeclaring means the compiler checks the two agree.
 */
export interface CascadeSessionHandle extends SessionHandle {
  /** The server's fingerprint for the config the session is running. */
  appliedFingerprint: string | null;
  applyTuning: ApplyTuning;
  /** Which retry an in-flight apply has reached, and what has failed (ticket 07). */
  applyProgress: ApplyProgress | null;
}

export type UseCascadeSessionResult = CascadeSessionHandle;

/** One `update_tuning` awaiting its `tuning_applied`/`tuning_failed` reply. */
interface PendingApply {
  fingerprint: string;
  /** The document this apply asked for; becomes the live config once accepted. */
  config: ModeTuningConfig;
  /**
   * This apply changes a Deepgram connection-level field, so the server is
   * reopening the STT socket behind the running session — which is what puts
   * the connection badge on `'reconnecting'` for the duration.
   */
  reconnects: boolean;
  /**
   * Send order. When one server message answers several applies at once (see
   * `settleApply`), this is what identifies the newest of them — the one whose
   * document the server actually ended up running. The echoed `requestId` can
   * be any of them, so it cannot be read off the Map's own ordering.
   */
  seq: number;
  settle: (result: ApplyResult) => void;
  /**
   * `null` for an apply that is deliberately **not** timed — see
   * `sendUpdateTuning`. A reconnect's reply waits on the next thing the user
   * says, which is not a duration anything can put a bound on.
   */
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/** Cancels an apply's reply timeout, if it had one. */
function disarmApply(pending: PendingApply): void {
  if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
}

/**
 * Correlates one `update_tuning` with its reply. Short and random rather than
 * a counter: the server echoes it back verbatim, and a session that resumes
 * must not reuse an id an earlier socket already spent.
 */
function newRequestId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

/**
 * Drives the Cascade mode voice-in/voice-out flow: one full-duplex WebSocket
 * per session carrying a JSON envelope for transcripts/control messages and
 * binary frames for mic audio (client -> server) and TTS audio
 * (server -> client). See tickets/02-cascade-mvp.md for the wire contract.
 */
export function useCascadeSession(): UseCascadeSessionResult {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sourcePane, setSourcePane] = useState<TranscriptPaneState>(EMPTY_TRANSCRIPT_PANE);
  const [targetPane, setTargetPane] = useState<TranscriptPaneState>(EMPTY_TRANSCRIPT_PANE);
  const [micLevel, setMicLevel] = useState(0);
  const [latencyState, setLatencyState] = useState<CascadeLatencyState>(EMPTY_CASCADE_LATENCY);
  const [toasts, setToasts] = useState<CascadeToast[]>([]);
  // ticket 05: the most recent segment_boundary trigger's display label, by
  // segmentId. See segmentation.ts's segmentTriggerLabel.
  const [segmentTriggers, setSegmentTriggers] = useState<Record<string, string>>({});
  // ticket 06: the fingerprint the *server* reports for the config it is
  // running, from `tuning_applied`. The panel displays this rather than its own
  // hash of the draft, so the two can never silently disagree.
  const [appliedFingerprint, setAppliedFingerprint] = useState<string | null>(null);
  // ticket 07: how the apply on the wire is going. The `ApplyResult` promise
  // settles once, at the end; this is the running commentary the status line
  // ("attempt 2 of 3") and the failure dialog's attempt log are built from.
  const [applyProgress, setApplyProgress] = useState<ApplyProgress | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const captureContextRef = useRef<AudioContext | null>(null);
  // ticket 12: the RMS gate node, when the config that opened this session had
  // the gate on. Held so a live apply can post it new parameters (story AC 3.3)
  // without touching the graph it sits in.
  const gateNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const gaplessPlayerRef = useRef<GaplessPlayer | null>(null);
  const pendingTtsMetaRef = useRef<{ segmentId: string; sampleRate: number } | null>(null);
  const levelMeterRef = useRef<MicLevelMeter | null>(null);
  const clockSyncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Feedback-loop guard: while our own TTS is audibly playing, mic frames are
  // withheld from the backend instead of being forwarded, so speaker output
  // picked back up by the mic can't be mistaken for a new user segment (see
  // the incident that motivated this: an unmuted mic transcribing the app's
  // own translated reply and re-translating it, looping indefinitely).
  const isPlaybackActiveRef = useRef(false);
  const unmutePlaybackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ticket 07 resilience bookkeeping: the sessionId a resume would need,
  // whether one's already been tried this session, and whether the socket
  // that's about to close was closed *by us* (disconnect()/teardown()) as
  // opposed to dropping unexpectedly. Only the latter should ever attempt a
  // resume. See cascadeResilience.ts for the pure attempt-vs-give-up call.
  const sessionIdRef = useRef<string | null>(null);
  const resumeAttemptedRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const toastIdRef = useRef(0);
  const toastTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // ticket 06 live tuning: applies made while our own TTS is playing are held
  // here rather than sent, because a mid-reply Deepgram reconnect would cut
  // the audio the user is listening to. One slot, so two Applies 200ms apart
  // coalesce into a single update_tuning carrying the later config — they
  // never reach the wire as two.
  const pendingTuningRef = useRef<ModeTuningConfig | null>(null);
  const pendingAppliesRef = useRef<Map<string, PendingApply>>(new Map());
  /** Monotonic send order for `PendingApply.seq`. Never reset: it only has to increase. */
  const applySeqRef = useRef(0);
  // ticket 07: the config we believe the session is running — `connect`'s
  // start-of-session document, then whatever the server last accepted. Diffing
  // the next apply against it is how the client knows, before sending it,
  // whether the server will have to reopen the Deepgram socket.
  const liveTuningRef = useRef<ModeTuningConfig | null>(null);

  const fail = useCallback((message: string) => {
    setStatus('error');
    setErrorMessage(message);
  }, []);

  // A non-blocking toast (ticket 07): pushed for a retryable segment failure,
  // auto-dismissed on its own timer so a run of them doesn't pile up forever.
  const addToast = useCallback((message: string) => {
    const id = `toast-${toastIdRef.current++}`;
    setToasts((current) => [...current, { id, message }]);
    const timeoutId = setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
      toastTimeoutsRef.current.delete(id);
    }, CASCADE_TOAST_DURATION_MS);
    toastTimeoutsRef.current.set(id, timeoutId);
  }, []);

  /** Hands back (and disarms) the apply waiting on this requestId, if any. */
  const takePendingApply = useCallback((requestId: string): PendingApply | undefined => {
    const pending = pendingAppliesRef.current.get(requestId);
    if (!pending) return undefined;
    disarmApply(pending);
    pendingAppliesRef.current.delete(requestId);
    return pending;
  }, []);

  /**
   * Answers one apply and puts the connection state back. The badge is only
   * ever restored to `'connected'` from `'reconnecting'`: if the session has
   * meanwhile errored or been torn down, that is the truer state and this must
   * not overwrite it.
   *
   * A failed settle leaves `applyProgress` in place, because the failure dialog
   * reads its attempt log after the promise has resolved. The next apply
   * overwrites it.
   *
   * **One message can answer several applies.** While a reconnect is parked the
   * server keeps a single `pending` slot and overwrites both it and its
   * `request_id` with each later `update_tuning`
   * (`orchestrator.py::_handle_update_tuning`), so the eventual `tuning_applied`
   * or final `tuning_failed` carries whichever id arrived last and is the only
   * reply any of them will get. The question is therefore not "is this one the
   * reconnect?" but "is a reconnect among the applies this message answers?" —
   * if so, all of them are settled with it. Leaving either side waiting would
   * hang the panel's Apply button, or strand the badge on Reconnecting, over a
   * request the server considers answered.
   */
  const settleApply = useCallback((pending: PendingApply, result: ApplyResult) => {
    const riders = [...pendingAppliesRef.current.entries()];
    const answersReconnect = pending.reconnects || riders.some(([, entry]) => entry.reconnects);
    if (answersReconnect) {
      setStatus((current) => (current === 'reconnecting' ? 'connected' : current));
    }
    const settled = answersReconnect ? [pending, ...riders.map(([, rider]) => rider)] : [pending];
    if (result.ok) {
      // The newest of everything this message answers: the server coalesced
      // them into one slot, and that slot ended up holding the last document
      // sent — which is what the session is now running.
      liveTuningRef.current = settled.reduce((a, b) => (b.seq > a.seq ? b : a)).config;
      setApplyProgress(null);
    }
    pending.settle(result);
    if (!answersReconnect) return;
    for (const [requestId, rider] of riders) {
      pendingAppliesRef.current.delete(requestId);
      disarmApply(rider);
      rider.settle(result);
    }
  }, []);

  /**
   * Hands the running gate worklet its new parameters (ticket 12). The gate is
   * client-side, so this is the whole of applying it: no server leg, nothing
   * reconnects, and a threshold change takes effect on the next render quantum
   * (story AC 3.3).
   *
   * Enabling a gate that was off at connect time is the one exception. The node
   * is inserted while the capture graph is built, so with none there to talk to
   * the change applies at the next connect. Turning a running gate off does work
   * live: the worklet's `enabled: false` is a pass-through rather than a
   * teardown, which is why it has one.
   */
  const postGateParams = useCallback((gate: ClientTuning['rmsGate']) => {
    const node = gateNodeRef.current;
    if (node) {
      node.port.postMessage({ type: 'gateParams', gate: clampGateParams(gate) });
      return;
    }
    if (gate.enabled) {
      console.warn('Cascade: the RMS gate is inserted when the capture graph is built — reconnect to enable it.');
    }
  }, []);

  /**
   * One `update_tuning` on the wire, and the promise that settles when the
   * server answers it.
   *
   * Not every apply is timed. An ordinary one is answered immediately, so a
   * reply that never comes has to become a visible failure rather than a stuck
   * Apply button. A connection-level apply is different: the server only sends
   * `tuning_applied{reconnectedStt:true}` on the **first result from the new
   * Deepgram socket**, and a socket that nobody is speaking into produces no
   * results. An Apply pressed during silence can therefore sit unanswered for
   * minutes and still be succeeding, so timing it would mean opening the
   * failure dialog over a reconnect that worked. It settles on
   * `tuning_applied`, on the final `tuning_failed`, or on teardown. The same
   * holds for anything sent while a reconnect is parked: the server folds it
   * into that reconnect and answers both with the one message.
   */
  const sendUpdateTuning = useCallback(
    (config: ModeTuningConfig): Promise<ApplyResult> => {
      const configFingerprint = fingerprint(config);
      const requestId = newRequestId();
      // Unknown live config (a session connected before the panel had one) is
      // treated as "this might reopen the socket": an amber badge for an apply
      // that turns out not to need one reads exactly like a brief WS blip,
      // whereas a silent reconnect leaves the user watching a frozen transcript
      // with nothing on screen to explain it.
      const live = liveTuningRef.current;
      const reconnects = live === null || diff(live, config).some((path) => CONNECTION_LEVEL_PATHS.has(path));
      // Read from the bookkeeping rather than `status`: an unsettled reconnect
      // is what put the badge on `'reconnecting'` in the first place.
      const reconnectParked = [...pendingAppliesRef.current.values()].some((entry) => entry.reconnects);
      wsRef.current?.send(JSON.stringify({ type: 'update_tuning', requestId, tuning: config }));
      // The client block goes to the worklet *as well as* to the server: the
      // server hashes it into the fingerprint it reports, but only the worklet
      // can act on it (ticket 12). Same moment for both, so a deferred apply
      // defers the whole document rather than half of it.
      postGateParams(config.client.rmsGate);
      setApplyProgress({ attempt: 1, maxAttempts: APPLY_MAX_ATTEMPTS, failures: [] });
      if (reconnects) setStatus((current) => (current === 'connected' ? 'reconnecting' : current));
      return new Promise<ApplyResult>((resolve) => {
        const timeoutId =
          reconnects || reconnectParked
            ? null
            : setTimeout(() => {
                const pending = pendingAppliesRef.current.get(requestId);
                pendingAppliesRef.current.delete(requestId);
                if (!pending) return;
                settleApply(pending, {
                  ok: false,
                  fingerprint: configFingerprint,
                  // Nothing came back at all, so the retry budget is as spent as
                  // we can tell: the panel treats this like an exhausted
                  // reconnect and opens the failure dialog rather than leaving
                  // Apply spinning.
                  attempt: APPLY_MAX_ATTEMPTS,
                  maxAttempts: APPLY_MAX_ATTEMPTS,
                  message: 'No reply from the server.',
                });
              }, TUNING_APPLY_TIMEOUT_MS);
        pendingAppliesRef.current.set(requestId, {
          fingerprint: configFingerprint,
          config,
          reconnects,
          seq: applySeqRef.current++,
          settle: resolve,
          timeoutId,
        });
      });
    },
    [postGateParams, settleApply],
  );

  // Called the moment the playback mute lifts. Sends *one* message for
  // whatever is in the slot — which is the latest config Apply was pressed
  // with, since the slot is overwritten rather than appended to. Nothing is
  // awaiting this promise (the caller was already told `deferred: true`), so a
  // failure here can only be reported to the console.
  //
  // The slot is cleared only once the socket is actually open to take the
  // message, matching `useRealtimeSession`'s flush: a mute that lifts while
  // the socket is down (a drop, or the gap before a reconnect resumes) has to
  // leave the config queued for the next flush rather than discard it.
  const flushPendingTuning = useCallback(() => {
    const config = pendingTuningRef.current;
    if (!config) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    pendingTuningRef.current = null;
    void sendUpdateTuning(config).then((result) => {
      if (!result.ok) console.warn(`Cascade: the deferred tuning apply failed — ${result.message}`);
    });
  }, [sendUpdateTuning]);

  // Prepares (or reuses) a playback AudioContext at the sample rate the
  // server told us for this segment via tts_audio_meta, read dynamically
  // rather than hardcoded, since it need not match the 16kHz capture rate.
  const getGaplessPlayer = useCallback((sampleRate: number): GaplessPlayer => {
    const current = playbackContextRef.current;
    if (current && current.sampleRate === sampleRate && gaplessPlayerRef.current) {
      return gaplessPlayerRef.current;
    }
    void current?.close();
    const playbackContext = new AudioContext({ sampleRate });
    playbackContextRef.current = playbackContext;
    const player = createGaplessPlayer(playbackContext);
    gaplessPlayerRef.current = player;
    return player;
  }, []);

  // Releases the mic, tears down audio contexts, and closes the socket:
  // shared by the explicit disconnect() call, the unmount cleanup effect
  // below, and ticket 07's terminal-failure path. Marks the close as
  // *intentional* first, so the socket's own onclose handler (wired in
  // connect()/wireConnectedSocket below) doesn't mistake this for an
  // unexpected drop and try to resume it.
  const teardown = useCallback(() => {
    intentionalCloseRef.current = true;
    if (clockSyncIntervalRef.current !== null) {
      clearInterval(clockSyncIntervalRef.current);
      clockSyncIntervalRef.current = null;
    }
    levelMeterRef.current?.stop();
    levelMeterRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    const stream = mediaStreamRef.current;
    if (stream) {
      stopMediaStream(stream);
    }
    mediaStreamRef.current = null;
    // Closing the context disposes every node in the graph, the gate included;
    // the ref is dropped so a later apply can't post at a dead worklet.
    gateNodeRef.current = null;
    void captureContextRef.current?.close();
    captureContextRef.current = null;
    void playbackContextRef.current?.close();
    playbackContextRef.current = null;
    gaplessPlayerRef.current = null;
    pendingTtsMetaRef.current = null;
    if (unmutePlaybackTimeoutRef.current !== null) {
      clearTimeout(unmutePlaybackTimeoutRef.current);
      unmutePlaybackTimeoutRef.current = null;
    }
    isPlaybackActiveRef.current = false;
    for (const timeoutId of toastTimeoutsRef.current.values()) {
      clearTimeout(timeoutId);
    }
    toastTimeoutsRef.current.clear();
    setToasts([]);
    // Any apply still waiting on a reply will never get one now; leaving those
    // promises open would leave the panel's Apply button spinning forever.
    for (const pending of pendingAppliesRef.current.values()) {
      disarmApply(pending);
      pending.settle({
        ok: false,
        fingerprint: pending.fingerprint,
        attempt: 1,
        maxAttempts: APPLY_MAX_ATTEMPTS,
        message: 'The session ended before the new settings were applied.',
      });
    }
    pendingAppliesRef.current.clear();
    pendingTuningRef.current = null;
    liveTuningRef.current = null;
    setApplyProgress(null);
  }, []);

  const disconnect = useCallback(() => {
    teardown();
    setStatus('idle');
    setErrorMessage(null);
    setMicLevel(0);
  }, [teardown]);

  // Blocking terminal state (ticket 07): the circuit breaker tripped, or a
  // resume attempt gave up. Either way, this session is over and only a
  // completely fresh connect() (not an automatic retry) can recover. Reuses
  // the same `status: 'error'` + errorMessage rendering as the mic-denied
  // banner, distinguished only by its message text, per the brief's "same UI
  // treatment is fine, distinct message" note.
  const failTerminal = useCallback(
    (message: string) => {
      teardown();
      setStatus('error');
      setErrorMessage(message);
      setMicLevel(0);
    },
    [teardown],
  );

  const handleServerMessage = useCallback(
    (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const meta = pendingTtsMetaRef.current;
        pendingTtsMetaRef.current = null;
        if (!meta) {
          console.warn('Cascade: received a TTS audio frame with no preceding tts_audio_meta; dropping it.');
          return;
        }
        const samples = int16BufferToFloat32(event.data);
        const player = getGaplessPlayer(meta.sampleRate);
        player.schedule(samples, meta.sampleRate);

        // Arm (or extend) the mic mute for exactly as long as this player
        // still has audio queued, so speaker bleed-through can't be picked
        // up as a new segment. Re-armed on every chunk rather than timed
        // once, since one segment's reply can arrive as several chunks.
        isPlaybackActiveRef.current = true;
        if (unmutePlaybackTimeoutRef.current !== null) {
          clearTimeout(unmutePlaybackTimeoutRef.current);
        }
        const playbackContext = playbackContextRef.current;
        const remainingMs = playbackContext
          ? Math.max(0, (player.queuedUntil() - playbackContext.currentTime) * 1000)
          : 0;
        unmutePlaybackTimeoutRef.current = setTimeout(() => {
          isPlaybackActiveRef.current = false;
          unmutePlaybackTimeoutRef.current = null;
          // The reply has finished playing: this is the turn boundary a
          // deferred tuning apply has been waiting for (ticket 06).
          flushPendingTuning();
        }, remainingMs + PLAYBACK_MUTE_TAIL_MS);

        // Report the exact moment this segment's TTS audio was scheduled to
        // play, right after the scheduling call above. The server pairs
        // this against its own speech_end timestamp for the playback_start
        // latency stage (ticket 06).
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'playback_started', segmentId: meta.segmentId, clientTime: Date.now() }));
        }
        return;
      }

      let message: ServerEnvelope;
      try {
        message = JSON.parse(event.data as string) as ServerEnvelope;
      } catch {
        console.warn('Cascade: received a non-JSON text frame; ignoring it.');
        return;
      }

      switch (message.type) {
        case 'source_transcript': {
          const { segmentId, text, speaker, flagged, correctedFrom } = message;
          if (segmentId !== undefined && text !== undefined) {
            // ticket 14: `flagged` marks this as the transcript check's
            // verdict on a segment that was already final — a re-send, not
            // more streamed text. It merges into the existing segment by id
            // (replacing its text, which in `correct` mode is the rewrite),
            // so a checked segment never renders twice.
            if (flagged === true) {
              setSourcePane((pane) =>
                applyTranscriptCheck(pane, { segmentId, text, speaker, flagged: true, correctedFrom }),
              );
            } else {
              setSourcePane((pane) => appendTranscriptSegment(pane, { segmentId, text, speaker }));
            }
          }
          break;
        }
        case 'target_transcript': {
          const { segmentId, text, speaker } = message;
          if (segmentId !== undefined && text !== undefined) {
            setTargetPane((pane) => appendTranscriptSegment(pane, { segmentId, text, speaker }));
          }
          break;
        }
        case 'segment_boundary': {
          // ticket 05: surfaces which segmentation mechanism ended this
          // segment: the LLM clause check, or a Deepgram signal
          // (speech_final / UtteranceEnd, hybrid race or LLM-priority's
          // fallback ceiling alike). `trigger` isn't narrowed to a known set
          // of strings anywhere here; whatever the server sends is logged
          // and labeled as-is (see segmentation.ts's segmentTriggerLabel for
          // the one bit of known-value shortening, itself defaulting to a
          // passthrough).
          console.debug(`Cascade: segment ${message.segmentId ?? '?'} boundary (${message.trigger ?? 'unknown'})`);
          const { segmentId, trigger } = message;
          if (segmentId !== undefined && trigger !== undefined) {
            setSegmentTriggers((current) => ({ ...current, [segmentId]: segmentTriggerLabel(trigger) }));
          }
          break;
        }
        case 'tts_audio_meta':
          if (message.segmentId !== undefined && message.sampleRate !== undefined) {
            pendingTtsMetaRef.current = { segmentId: message.segmentId, sampleRate: message.sampleRate };
          }
          break;
        case 'latency': {
          const { segmentId, stage, ms } = message;
          if (segmentId !== undefined && stage !== undefined && ms !== undefined && isLatencyStage(stage)) {
            setLatencyState((state) => recordLatencyStage(state, { segmentId, stage, ms }));
          }
          break;
        }
        case 'clock_sync_ack':
          // Informational only. Confirms the clock-sync ping/pong is alive.
          // The server owns the offset math; there's nothing to consume here.
          break;
        case 'session_started':
          // ticket 07: stashed for a later resume_session attempt if the
          // browser<->backend WebSocket ever drops unexpectedly.
          if (message.sessionId !== undefined) {
            sessionIdRef.current = message.sessionId;
          }
          break;
        case 'tuning_applied': {
          // Sent once unsolicited right after session_started (requestId null)
          // carrying the start-of-session fingerprint, and again per accepted
          // update_tuning. Either way the fingerprint is the server's answer to
          // "what are you actually running", which is what the panel shows.
          const { requestId, fingerprint: appliedTo, reconnectedStt } = message;
          if (appliedTo !== undefined) {
            setAppliedFingerprint(appliedTo);
          }
          if (typeof requestId === 'string') {
            const pending = takePendingApply(requestId);
            if (pending) {
              settleApply(pending, {
                ok: true,
                fingerprint: appliedTo ?? pending.fingerprint,
                reconnectedStt: reconnectedStt === true,
                deferred: false,
              });
            }
          }
          break;
        }
        case 'tuning_failed': {
          // One of these per failed reconnect attempt (brief §3's failure
          // path). Every one is logged, but only the last one is an answer:
          // until the budget is spent the server is still retrying, and the
          // panel is still showing "Reconnecting STT with the new parameters…".
          const { requestId, attempt, maxAttempts, message: failureText } = message;
          const attemptNumber = attempt ?? 1;
          const budget = maxAttempts ?? APPLY_MAX_ATTEMPTS;
          const reason = failureText ?? 'The new settings could not be applied.';
          console.warn(`Cascade: tuning apply attempt ${attemptNumber}/${budget} failed — ${reason}`);
          if (typeof requestId !== 'string' || !pendingAppliesRef.current.has(requestId)) break;
          // Every attempt lands in the log the failure dialog shows, and moves
          // the status line's "attempt i of n" on to the retry the server is
          // now making — capped, so an exhausted budget doesn't read "attempt
          // 4 of 3" for the instant before the dialog replaces it.
          setApplyProgress((current) => ({
            attempt: Math.min(attemptNumber + 1, budget),
            maxAttempts: budget,
            failures: [...(current?.failures ?? []), { attempt: attemptNumber, message: reason, at: new Date() }],
          }));
          if (attemptNumber >= budget) {
            const pending = takePendingApply(requestId);
            if (pending) {
              settleApply(pending, {
                ok: false,
                fingerprint: message.fingerprint ?? pending.fingerprint,
                attempt: attemptNumber,
                maxAttempts: budget,
                message: reason,
              });
            }
          }
          break;
        }
        case 'error': {
          // ticket 07: a dropped segment (retryable) becomes a toast; a
          // circuit-breaker trip or failed resume (not retryable) becomes
          // the blocking terminal state. See cascadeResilience.ts.
          const { provider, kind, message: errorText, retryable } = message;
          if (provider !== undefined && kind !== undefined && errorText !== undefined && retryable !== undefined) {
            const treatment = routeCascadeError({ provider, kind, message: errorText, retryable });
            if (treatment.kind === 'toast') {
              addToast(treatment.message);
            } else {
              failTerminal(treatment.message);
            }
          }
          break;
        }
        default:
          console.warn(`Cascade: received an unrecognized message type "${message.type}".`);
      }
    },
    [addToast, failTerminal, flushPendingTuning, getGaplessPlayer, settleApply, takePendingApply],
  );

  // Wires a socket that's live and taken over as the session's transport
  // (the initial connect()'s socket, or one that just resumed successfully):
  // normal message handling, and an unexpected close hands off to whatever
  // the caller wants to happen next (ticket 07: attempt one resume) rather
  // than silently ending the session. Takes that handler as a parameter
  // (instead of closing over attemptResumeOrGiveUp directly) since the two
  // are mutually recursive: attemptResumeOrGiveUp re-wires a socket that
  // just resumed successfully via this same function.
  const wireConnectedSocket = useCallback(
    (ws: WebSocket, onUnexpectedClose: () => void) => {
      ws.onmessage = handleServerMessage;
      ws.onclose = () => {
        if (intentionalCloseRef.current) return;
        onUnexpectedClose();
      };
    },
    [handleServerMessage],
  );

  // One resume attempt, never a loop. See cascadeResilience.ts's
  // decideResume for the actual attempt-vs-give-up call.
  const attemptResumeOrGiveUp = useCallback(() => {
    const decision = decideResume({ sessionId: sessionIdRef.current, resumeAttempted: resumeAttemptedRef.current });
    if (decision.type === 'give_up') {
      failTerminal(decision.message);
      return;
    }
    resumeAttemptedRef.current = true;
    setStatus('reconnecting');

    const ws = new WebSocket(CASCADE_WS_ENDPOINT);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resume_session', sessionId: decision.sessionId }));
    };
    // The first reply to resume_session tells us whether it worked: a
    // not_found error means give up; anything else (including real segment
    // data, if the server just resumes streaming) means we're back.
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        let parsed: ServerEnvelope | null = null;
        try {
          parsed = JSON.parse(event.data) as ServerEnvelope;
        } catch {
          parsed = null;
        }
        if (parsed?.type === 'error' && parsed.provider !== undefined && parsed.kind !== undefined && parsed.message !== undefined && parsed.retryable !== undefined) {
          const treatment = routeCascadeError({
            provider: parsed.provider,
            kind: parsed.kind,
            message: parsed.message,
            retryable: parsed.retryable,
          });
          if (treatment.kind === 'terminal') {
            failTerminal(treatment.message);
            return;
          }
          // A retryable error alongside a successful resume: still resumed, just also show the toast.
          setStatus('connected');
          wireConnectedSocket(ws, attemptResumeOrGiveUp);
          addToast(treatment.message);
          return;
        }
      }
      setStatus('connected');
      wireConnectedSocket(ws, attemptResumeOrGiveUp);
      handleServerMessage(event);
    };
    ws.onclose = () => {
      if (intentionalCloseRef.current) return;
      // The resume socket itself never came up (or dropped again before we
      // heard back). decideResume will now say give_up since
      // resumeAttemptedRef is already true, so this can't loop.
      attemptResumeOrGiveUp();
    };
  }, [addToast, failTerminal, handleServerMessage, wireConnectedSocket]);

  const applyTuning = useCallback(
    (config: ModeTuningConfig): Promise<ApplyResult> => {
      const deferred: ApplyResult = {
        ok: true,
        fingerprint: fingerprint(config),
        reconnectedStt: false,
        deferred: true,
      };
      // Not connected: there is nobody to tell. The panel commits locally and
      // the next connect() carries the config in start_session (wireframe §4's
      // "Apply at next connect").
      if (wsRef.current?.readyState !== WebSocket.OPEN) return Promise.resolve(deferred);
      // Mid-reply: hold it in the single slot. Applying now would reopen the
      // Deepgram connection underneath the audio the user is listening to
      // (Step 5 gate outcome 2).
      if (isPlaybackActiveRef.current) {
        pendingTuningRef.current = config;
        return Promise.resolve(deferred);
      }
      return sendUpdateTuning(config);
    },
    [sendUpdateTuning],
  );

  const connect = useCallback(
    (languages: SessionLanguages, tuning?: ModeTuningConfig) => {
      void (async () => {
        setStatus('connecting');
        setErrorMessage(null);
        setSourcePane(EMPTY_TRANSCRIPT_PANE);
        setTargetPane(EMPTY_TRANSCRIPT_PANE);
        setLatencyState(EMPTY_CASCADE_LATENCY);
        for (const timeoutId of toastTimeoutsRef.current.values()) {
          clearTimeout(timeoutId);
        }
        toastTimeoutsRef.current.clear();
        setToasts([]);
        setSegmentTriggers({});
        // The server publishes this again (unsolicited) right after
        // session_started; until then we have no claim to make about what it
        // is running.
        setAppliedFingerprint(null);
        setApplyProgress(null);
        pendingTuningRef.current = null;
        // What start_session is about to put the session on, and therefore what
        // the first live apply's connection-level diff is measured against.
        liveTuningRef.current = tuning ?? null;
        // Fresh session: nothing to resume yet, and any earlier session's
        // resume bookkeeping no longer applies.
        sessionIdRef.current = null;
        resumeAttemptedRef.current = false;
        intentionalCloseRef.current = false;

        // Request mic access first (tied to this same click/user-gesture, per
        // the autoplay-policy note in issue 07). No point opening a backend
        // session if the user denies it.
        //
        // ticket 11: EC/NS/AGC come from the panel. They are `getUserMedia`-time
        // constraints and a running track can't be re-negotiated, so the
        // Microphone section says they take effect on the next connect, and
        // changing one never reconnects anything. The fallback is
        // `DEFAULT_TUNING_CONFIG`'s own copy rather than three literals, so
        // "no config" and "the default config" cannot drift apart. The capture
        // format stays fixed: the worklet and the backend both assume 16 kHz
        // mono, so it is not a knob.
        const microphone = tuning?.client.microphone ?? DEFAULT_TUNING_CONFIG.client.microphone;
        const stream = await requestMicStream(
          {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: microphone.echoCancellation,
            noiseSuppression: microphone.noiseSuppression,
            autoGainControl: microphone.autoGainControl,
          },
          fail,
        );
        if (!stream) {
          return;
        }
        mediaStreamRef.current = stream;

        const ws = new WebSocket(CASCADE_WS_ENDPOINT);
        ws.binaryType = 'arraybuffer';

        try {
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('WebSocket connection failed'));
          });
        } catch {
          fail('Could not connect to the Cascade backend. Is it running?');
          stopMediaStream(stream);
          return;
        }

        // Send start_session as the very first message, strictly before any
        // binary audio frames: worklet setup (and therefore any captured
        // audio) doesn't happen until after this point.
        // ticket 05: segmentationMode is only ever included when the
        // dev-facing ?segMode=llm_priority override resolves to something;
        // otherwise it's omitted entirely, matching (not duplicating) the
        // backend's own default-to-"hybrid" handling when the field is absent.
        // ticket 06: once the panel supplies a `tuning` document it carries
        // its own segmentation mode, so the query-param override is dropped
        // rather than sent alongside — the server would ignore it anyway
        // (tuning.cascade.segmentation.mode wins), and sending both would
        // suggest the URL still had a say.
        const segmentationMode = resolveSegmentationModeOverride(window.location.search);
        ws.send(
          JSON.stringify({
            type: 'start_session',
            languages: [languages.sourceLanguage, languages.targetLanguage],
            ...(tuning ? { tuning } : {}),
            ...(!tuning && segmentationMode ? { segmentationMode } : {}),
          }),
        );
        // Clock-sync ping (ticket 06): once now, then every 30s for the life
        // of the session. The server replies with clock_sync_ack and does
        // the offset math itself.
        ws.send(JSON.stringify({ type: 'clock_sync', clientTime: Date.now() }));
        clockSyncIntervalRef.current = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'clock_sync', clientTime: Date.now() }));
          }
        }, CLOCK_SYNC_INTERVAL_MS);
        wsRef.current = ws;
        wireConnectedSocket(ws, attemptResumeOrGiveUp);

        try {
          // Creating the capture context at 16kHz makes Web Audio resample the
          // mic's native rate (commonly 44.1/48kHz) down to 16kHz inside the
          // graph, so the worklet always sees 16kHz samples regardless of what
          // the mic hardware actually provides. No manual resampling needed.
          //
          // ticket 13: RNNoise is the one exception — it only runs at 48kHz, so
          // with that stage on the whole capture graph moves up to 48kHz and the
          // worklet decimates 3:1 on the way out. With it off the graph is
          // exactly what it was before, at 16kHz.
          const client = tuning?.client ?? DEFAULT_TUNING_CONFIG.client;
          const gate = client.rmsGate;
          const rnnoise = client.rnnoise;
          const captureContext = new AudioContext({
            sampleRate: rnnoise.enabled ? RNNOISE_CONTEXT_SAMPLE_RATE : CASCADE_PCM_TARGET_SAMPLE_RATE,
          });
          captureContextRef.current = captureContext;
          await captureContext.audioWorklet.addModule(CASCADE_PCM_WORKLET_URL);

          // ticket 12: the RMS gate, when the panel has it on. Loaded only then,
          // so the default config pays for neither the module fetch nor the
          // extra node — its measured latency must not move.
          if (gate.enabled) {
            await captureContext.audioWorklet.addModule(GATE_WORKLET_URL);
          }

          // ticket 13. A stage that fails to load is not a failed session: the
          // graph is already at 48kHz and the decimator handles that, so capture
          // carries on without RNNoise and says so in the console, rather than
          // dropping the call the user just placed.
          let rnnoiseNode: AudioWorkletNode | null = null;
          if (rnnoise.enabled) {
            try {
              rnnoiseNode = await createRnnoiseNode(captureContext);
            } catch (err) {
              console.warn('Cascade: RNNoise could not be loaded; capturing without it.', err);
            }
          }

          const micSource = captureContext.createMediaStreamSource(stream);
          const workletNode = new AudioWorkletNode(captureContext, CASCADE_PCM_WORKLET_NAME, {
            processorOptions: { targetSampleRate: CASCADE_PCM_TARGET_SAMPLE_RATE },
          });
          workletNode.port.onmessage = (workletEvent: MessageEvent<ArrayBuffer>) => {
            if (isPlaybackActiveRef.current) return;
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(workletEvent.data);
            }
          };
          // The single insertion point for client-side DSP: micSource ->
          // [gate] -> [rnnoise] -> pcm worklet, in signal order (the panel's
          // Denoise chain lists them the same way round). The analyser below
          // still taps `micSource`, so the level meter keeps showing what the
          // mic hears rather than what survived the gate — which is the only
          // way to see that the threshold is set too high.
          let tail: AudioNode = micSource;
          if (gate.enabled) {
            const gateNode = new AudioWorkletNode(captureContext, GATE_WORKLET_NAME, {
              processorOptions: { gate: clampGateParams(gate) },
            });
            gateNodeRef.current = gateNode;
            tail.connect(gateNode);
            tail = gateNode;
          }
          if (rnnoiseNode) {
            tail.connect(rnnoiseNode);
            tail = rnnoiseNode;
          }
          tail.connect(workletNode);
          // The worklet writes no output samples (silence); connecting to
          // destination just keeps it pulled into the render graph so
          // process() keeps getting called instead of being dropped.
          workletNode.connect(captureContext.destination);

          try {
            // Level metering is a nice-to-have alongside the actual capture
            // pipeline above; a failure here shouldn't fail the whole call.
            levelMeterRef.current = startMicLevelMeter(captureContext, micSource, setMicLevel);
          } catch (err) {
            console.warn('Cascade: mic level metering unavailable.', err);
          }

          setStatus('connected');
        } catch {
          // Deliberately abandoning this session (not a drop). Mark the
          // close as intentional first so wireConnectedSocket's onclose
          // doesn't mistake it for an unexpected close and try to resume.
          intentionalCloseRef.current = true;
          fail('Could not start audio capture.');
          ws.close();
          stopMediaStream(stream);
        }
      })();
    },
    [attemptResumeOrGiveUp, fail, wireConnectedSocket],
  );

  // Release the mic and tear down audio contexts / the socket if the page
  // unmounts mid-session.
  useEffect(() => teardown, [teardown]);

  return {
    status,
    errorMessage,
    sourceText: paneText(sourcePane),
    targetText: paneText(targetPane),
    sourceSegments: sourcePane.segments,
    targetSegments: targetPane.segments,
    micLevel,
    cascadeLatency: currentCascadeLatency(latencyState),
    cascadeToasts: toasts,
    segmentTriggers,
    appliedFingerprint,
    applyProgress,
    connect,
    disconnect,
    applyTuning,
  };
}
