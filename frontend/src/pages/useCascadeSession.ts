import { useCallback, useEffect, useRef, useState } from 'react';
import { decideResume, routeCascadeError } from './cascadeResilience';
import { CASCADE_PCM_WORKLET_NAME, CASCADE_PCM_WORKLET_URL, CASCADE_WS_ENDPOINT } from './cascadeConfig';
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
import type { CascadeToast, ConnectionStatus, SessionHandle, SessionLanguages } from './sessionHandle';
import { EMPTY_TRANSCRIPT_PANE, appendTranscriptSegment, paneText, type TranscriptPaneState } from './transcriptPane';

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

interface ServerEnvelope {
  type: string;
  segmentId?: string;
  text?: string;
  isFinal?: boolean;
  trigger?: string;
  sampleRate?: number;
  /** Diarized speaker index (ticket 04): additive on source_transcript/target_transcript/tts_audio_meta. */
  speaker?: number | null;
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
}

export type UseCascadeSessionResult = SessionHandle;

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

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const captureContextRef = useRef<AudioContext | null>(null);
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
          const { segmentId, text, speaker } = message;
          if (segmentId !== undefined && text !== undefined) {
            setSourcePane((pane) => appendTranscriptSegment(pane, { segmentId, text, speaker }));
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
    [addToast, failTerminal, getGaplessPlayer],
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

  const connect = useCallback(
    (languages: SessionLanguages) => {
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
        // Fresh session: nothing to resume yet, and any earlier session's
        // resume bookkeeping no longer applies.
        sessionIdRef.current = null;
        resumeAttemptedRef.current = false;
        intentionalCloseRef.current = false;

        // Request mic access first (tied to this same click/user-gesture, per
        // the autoplay-policy note in issue 07). No point opening a backend
        // session if the user denies it.
        const stream = await requestMicStream(
          { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
        const segmentationMode = resolveSegmentationModeOverride(window.location.search);
        ws.send(
          JSON.stringify({
            type: 'start_session',
            languages: [languages.sourceLanguage, languages.targetLanguage],
            ...(segmentationMode ? { segmentationMode } : {}),
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
          const captureContext = new AudioContext({ sampleRate: 16000 });
          captureContextRef.current = captureContext;
          await captureContext.audioWorklet.addModule(CASCADE_PCM_WORKLET_URL);

          const micSource = captureContext.createMediaStreamSource(stream);
          const workletNode = new AudioWorkletNode(captureContext, CASCADE_PCM_WORKLET_NAME);
          workletNode.port.onmessage = (workletEvent: MessageEvent<ArrayBuffer>) => {
            if (isPlaybackActiveRef.current) return;
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(workletEvent.data);
            }
          };
          micSource.connect(workletNode);
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
    connect,
    disconnect,
  };
}
