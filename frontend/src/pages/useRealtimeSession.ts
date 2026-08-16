import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GATE_WORKLET_NAME, GATE_WORKLET_URL } from './gateConfig';
import { requestMicStream, stopMediaStream } from './mediaStream';
import { startMicLevelMeter, type MicLevelMeter } from './micLevel';
import {
  OPENAI_REALTIME_CALLS_ENDPOINT,
  REALTIME_SESSION_ENDPOINT,
  TRANSCRIPT_CHECK_ENDPOINT,
} from './realtimeConfig';
import { RNNOISE_CONTEXT_SAMPLE_RATE, createRnnoiseNode } from './rnnoiseConfig';
import {
  EMPTY_REALTIME_LATENCY,
  onResponseAudioTranscriptDelta,
  onSpeechStopped,
  type RealtimeLatencyState,
} from './realtimeLatency';
import type {
  ApplyResult,
  ApplyTuning,
  ConnectionStatus,
  SessionHandle,
  SessionLanguages,
} from './sessionHandle';
import {
  DEFAULT_TUNING_CONFIG,
  clampGateParams,
  fingerprint,
  type ClientTuning,
  type ModeTuningConfig,
  type RealtimeTuning,
} from './tuningConfig';

export type { ConnectionStatus } from './sessionHandle';

// Extra time to keep the mic muted past response.done before re-enabling the
// local track: covers WebRTC/decode buffering so the tail of the model's own
// voice output doesn't get sent back as new input. Mirrors the same guard in
// useCascadeSession.ts (PLAYBACK_MUTE_TAIL_MS), applied here to the local
// MediaStreamTrack instead of a withheld WebSocket frame, since Realtime
// mode has no server-side segmentation of its own to protect from feedback.
const REALTIME_MUTE_TAIL_MS = 300;

/**
 * The server's own cap on `POST /api/tuning/transcript-check`'s `text`
 * (`backend/app/api/tuning.py`'s `MAX_TEXT_CHARS`), over which it answers 400.
 * A settled Realtime turn is never remotely this long, but truncating here
 * means a pathological one costs a badge, not a console error.
 */
const MAX_CHECK_TEXT_CHARS = 2000;

// Shape of our backend's POST /api/realtime/session response: the ephemeral
// token lives in `client_secret`. See backend/app/api/realtime.py's
// RealtimeSessionResponse (reconciled against ticket 01's contract).
interface RealtimeSessionResponse {
  client_secret: string;
  expires_at: number;
  model: string;
  voice: string;
  /**
   * Ticket 04. Both are optional: a server that predates the tuning contract
   * answers with the four fields above and nothing else, and that has to keep
   * working rather than blanking the session.
   */
  fingerprint?: string;
  appliedTuning?: ModeTuningConfig;
}

/**
 * One JSON event from the `oai-events` WebRTC data channel. Only the
 * transcript-delta events we handle below are typed further; every other
 * event type (session.*, response.*, ...) is ignored for this ticket.
 *
 * `transcript` belongs to
 * `conversation.item.input_audio_transcription.completed` (ticket 15), which
 * carries the whole settled turn rather than one more delta.
 */
interface OaiEvent {
  type: string;
  delta?: string;
  transcript?: string;
}

/** `POST /api/tuning/transcript-check`'s 200 body (ticket 15). */
interface TranscriptCheckResponse {
  flagged: boolean;
  correctedText: string | null;
  elapsedMs: number;
  /** Present only when the provider didn't answer; the verdict is then a no-op. */
  failed?: boolean;
}

/**
 * `session.audio.input.turn_detection` as OpenAI's GA Realtime API takes it
 * (snake_case, unlike our own camelCase config). Every knob is optional and
 * absent means "leave the provider's own default alone" — the same
 * absent-key idiom the session-create path uses (`realtime.py`'s
 * `_turn_detection`), which is why nothing here is ever written as `null`.
 */
interface TurnDetectionPayload {
  type: RealtimeTuning['turnDetection']['type'];
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
  eagerness?: NonNullable<RealtimeTuning['turnDetection']['eagerness']>;
  interrupt_response?: boolean;
}

/**
 * `session.audio.input`. `noise_reduction` is the one field where an explicit
 * `null` is meaningful: the SDK documents it as the way to turn the feature
 * off, as opposed to omitting the key, which leaves the provider's default in
 * place.
 */
interface AudioInputPayload {
  turn_detection?: TurnDetectionPayload;
  noise_reduction?: { type: 'near_field' | 'far_field' } | null;
}

/**
 * One `session.update` client event for the `oai-events` data channel, in the
 * GA shape verified against the pinned SDK (`session_update_event.py`,
 * `realtime_session_create_request.py`: `session.type` is a required
 * `"realtime"`). Only the fields present in the event are updated, so it
 * carries `audio.input` and nothing else.
 */
export interface SessionUpdateEvent {
  type: 'session.update';
  session: { type: 'realtime'; audio: { input: AudioInputPayload } };
}

/**
 * The live-updatable projection of a tuning document (ticket 05). Pure, and
 * exported for its own unit tests.
 *
 * `model` and `voice` are never included: the SDK documents both as not
 * updatable over `session.update` (`voice` only before any audio output has
 * been produced), which is why the panel marks those rows "applies at next
 * connect".
 */
export function sessionUpdateEvent(config: ModeTuningConfig): SessionUpdateEvent {
  const input: AudioInputPayload = {};
  // A cascade document carries no realtime knobs, so it updates none. This is
  // unreachable through the panel, which always projects the mode it shows.
  if (config.mode === 'realtime') {
    const { turnDetection, noiseReduction } = config.realtime;
    const turn: TurnDetectionPayload = { type: turnDetection.type };
    if (turnDetection.type === 'server_vad') {
      if (turnDetection.threshold !== undefined) turn.threshold = turnDetection.threshold;
      if (turnDetection.prefixPaddingMs !== undefined) turn.prefix_padding_ms = turnDetection.prefixPaddingMs;
      if (turnDetection.silenceDurationMs !== undefined) turn.silence_duration_ms = turnDetection.silenceDurationMs;
    } else if (turnDetection.eagerness !== undefined) {
      turn.eagerness = turnDetection.eagerness;
    }
    // Valid on both turn-detection types, so it is not inside either branch.
    if (turnDetection.interruptResponse !== undefined) turn.interrupt_response = turnDetection.interruptResponse;
    input.turn_detection = turn;

    if (noiseReduction !== undefined) {
      input.noise_reduction = noiseReduction === 'off' ? null : { type: noiseReduction };
    }
  }
  return { type: 'session.update', session: { type: 'realtime', audio: { input } } };
}

export interface UseRealtimeSessionResult extends SessionHandle {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Realtime confirms its own applies: there is no server in the loop after connect. */
  appliedFingerprint: string | null;
  applyTuning: ApplyTuning;
}

/**
 * Drives the WebRTC voice-in/voice-out flow directly against OpenAI's
 * Realtime API: mic capture, ephemeral-token exchange with our backend, SDP
 * offer/answer with OpenAI, remote-audio playback, and live source/target
 * transcripts over the `oai-events` data channel.
 */
export function useRealtimeSession(): UseRealtimeSessionResult {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [targetText, setTargetText] = useState('');
  const [micLevel, setMicLevel] = useState(0);
  // ticket 15: the transcript check's verdict on the most recently settled
  // turn. One boolean rather than a per-segment flag because Realtime has no
  // segments: `sourceText` is one accumulated string, and the badge the pane
  // renders after it belongs to the turn that just finished.
  const [sourceFlagged, setSourceFlagged] = useState(false);
  const [latencyState, setLatencyState] = useState<RealtimeLatencyState>(EMPTY_REALTIME_LATENCY);
  // The server's word on which config this session started with (ticket 04),
  // so the panel's chip can never silently disagree with what OpenAI was
  // actually asked for. `null` while nothing is running, and while the server
  // doesn't report one. A live apply (ticket 05) moves it on from there: the
  // backend has no visibility into the session after minting the token, so
  // from that point the sent `session.update` is the only word there is.
  const [appliedFingerprint, setAppliedFingerprint] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  /**
   * The raw `getUserMedia` stream. Kept **only** so teardown can stop the
   * hardware track (ticket 12): with a client DSP stage on it is not the stream
   * WebRTC is sending, so it is never the thing to mute.
   */
  const mediaStreamRef = useRef<MediaStream | null>(null);
  /**
   * The track `pc.addTrack` was actually given — the DSP graph's output when a
   * client stage is enabled, the raw mic track otherwise. Every mute/unmute
   * targets *this* (story AC 3.5). Muting `mediaStreamRef`'s track instead
   * would silence nothing that is on the wire, and the model would hear its own
   * reply back through the user's speakers.
   */
  const sentTrackRef = useRef<MediaStreamTrack | null>(null);
  /** The client-DSP AudioContext, created only when a client stage is on. */
  const dspContextRef = useRef<AudioContext | null>(null);
  /** The RMS gate node inside that context, for live parameter posts. */
  const gateNodeRef = useRef<AudioWorkletNode | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const levelAudioContextRef = useRef<AudioContext | null>(null);
  const levelMeterRef = useRef<MicLevelMeter | null>(null);
  // Feedback-loop guard: disables the local mic track while the model's own
  // reply is being spoken, so the WebRTC connection sends silence instead of
  // whatever the speakers just played back into the mic. See the matching
  // guard (and the incident that motivated it) in useCascadeSession.ts.
  const unmuteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True from the model's first transcript delta until the mute tail after
  // `response.done` clears — the window in which a `session.update` would
  // re-parameterise turn detection underneath a reply the user is listening
  // to. The Cascade equivalent is `isPlaybackActiveRef`.
  const isReplyActiveRef = useRef(false);
  // Set by `response.done`, consumed by the next output transcript delta: the
  // target pane is one running string, and this is what puts a space between
  // one reply and the next.
  const targetNeedsSeparatorRef = useRef(false);
  // ticket 05 live tuning: an apply that can't go out yet (mid-reply, or the
  // data channel hasn't opened) waits here. One slot, so two Applies 200 ms
  // apart coalesce into a single session.update carrying the later config —
  // they never reach the wire as two.
  const pendingTuningRef = useRef<ModeTuningConfig | null>(null);
  /**
   * ticket 15: the config this session is running on, as a ref rather than
   * state because the only reader is the data-channel event handler, which is
   * built once at connect. Set by connect() and moved on by applyTuning().
   */
  const liveTuningRef = useRef<ModeTuningConfig | null>(null);
  /** The pair connect() was called with: the check needs the source language. */
  const languagesRef = useRef<SessionLanguages | null>(null);
  /**
   * Which turn is on screen, bumped when the user starts speaking again. A
   * check is a round trip: without this, a verdict that lands after the next
   * turn has begun would badge text it never saw.
   */
  const turnSeqRef = useRef(0);
  /** Aborts any check still in flight when the session goes away. */
  const checkAbortRef = useRef<AbortController | null>(null);

  const fail = useCallback((message: string) => {
    setStatus('error');
    setErrorMessage(message);
  }, []);

  /** Closes the client-DSP graph, if this session built one. */
  const stopClientDsp = useCallback(() => {
    gateNodeRef.current = null;
    void dspContextRef.current?.close();
    dspContextRef.current = null;
  }, []);

  /**
   * Builds `mic -> [gate] -> [rnnoise] -> MediaStreamAudioDestinationNode` and
   * hands back the track to send, or `null` when nothing is enabled — in which
   * case **no AudioContext is created at all**, so the default config's
   * measured latency is exactly what it was before this existed.
   *
   * The context runs at 48 kHz whenever it is built at all, not only when
   * RNNoise is on (ticket 13; ticket 12 took the browser's default rate). One
   * rate is one code path, RNNoise requires this one, and WebRTC's Opus encoder
   * works at 48 kHz regardless, so nothing downstream prefers the alternative.
   *
   * A failure here is not a failed call: the browser can refuse an AudioContext
   * (jsdom has none; a page can hit the per-tab limit) and the right answer is
   * to send the raw mic track rather than fail the session.
   */
  const buildClientDsp = useCallback(
    async (stream: MediaStream, client: ClientTuning): Promise<MediaStream | null> => {
      if (!client.rmsGate.enabled && !client.rnnoise.enabled) return null;
      try {
        const dspContext = new AudioContext({ sampleRate: RNNOISE_CONTEXT_SAMPLE_RATE });
        dspContextRef.current = dspContext;
        const source = dspContext.createMediaStreamSource(stream);
        const destination = dspContext.createMediaStreamDestination();
        let tail: AudioNode = source;

        if (client.rmsGate.enabled) {
          await dspContext.audioWorklet.addModule(GATE_WORKLET_URL);
          const gateNode = new AudioWorkletNode(dspContext, GATE_WORKLET_NAME, {
            processorOptions: { gate: clampGateParams(client.rmsGate) },
          });
          tail.connect(gateNode);
          tail = gateNode;
          gateNodeRef.current = gateNode;
        }

        // A stage that won't load is not a reason to throw away the stages that
        // did. Unlike Cascade there is nothing to decimate afterwards, so the
        // rest of the graph is unaffected by its absence.
        if (client.rnnoise.enabled) {
          try {
            const rnnoiseNode = await createRnnoiseNode(dspContext);
            tail.connect(rnnoiseNode);
            tail = rnnoiseNode;
          } catch (err) {
            console.warn('Realtime: RNNoise could not be loaded; sending the track without it.', err);
          }
        }

        tail.connect(destination);
        return destination.stream;
      } catch (err) {
        console.warn('Realtime: client-side audio processing is unavailable; sending the raw mic track.', err);
        stopClientDsp();
        return null;
      }
    },
    [stopClientDsp],
  );

  /**
   * Live gate parameters (ticket 12). Client-side and instant: unlike the
   * Realtime knobs there is no `session.update` involved, and unlike Cascade
   * there is no server to confirm it. Enabling a gate that was off at connect
   * time applies at the next connect — there is no node in the graph to talk
   * to, and inserting one would mean renegotiating the track WebRTC is sending.
   */
  const postGateParams = useCallback((gate: ClientTuning['rmsGate']) => {
    const node = gateNodeRef.current;
    if (node) {
      node.port.postMessage({ type: 'gateParams', gate: clampGateParams(gate) });
      return;
    }
    if (gate.enabled) {
      console.warn('Realtime: the RMS gate is inserted when the sent track is built — reconnect to enable it.');
    }
  }, []);

  /**
   * Sends one `session.update`, or reports that it couldn't. A data channel is
   * `'connecting'` until the peer opens it and `send()` on it throws, so the
   * gate is `readyState`, the channel's own state rather than a copy of it.
   *
   * Realtime has no server leg to confirm an apply (the backend sees nothing
   * after minting the token), so a successful send *is* the confirmation, and
   * the fingerprint the panel displays moves here.
   */
  const sendSessionUpdate = useCallback(
    (config: ModeTuningConfig): boolean => {
      const channel = dataChannelRef.current;
      if (channel?.readyState !== 'open') return false;
      channel.send(JSON.stringify(sessionUpdateEvent(config)));
      // The shared `client` block never goes to OpenAI — it is ours to apply,
      // and the gate worklet is where it lands (ticket 12). Sent at the same
      // moment as the provider knobs so a deferred apply defers the whole
      // document rather than half of it.
      postGateParams(config.client.rmsGate);
      setAppliedFingerprint(fingerprint(config));
      return true;
    },
    [postGateParams],
  );

  /**
   * Called at both flush points — the channel opening, and the mute tail after
   * `response.done`. Sends at most one event, for whatever is in the slot,
   * which is the latest config Apply was pressed with. The slot is only
   * cleared once the send actually happened, so a flush that arrives while the
   * channel is down leaves the config queued for the next one.
   */
  const flushPendingTuning = useCallback(() => {
    const config = pendingTuningRef.current;
    if (!config) return;
    if (sendSessionUpdate(config)) pendingTuningRef.current = null;
  }, [sendSessionUpdate]);

  /**
   * Live mid-session apply (ticket 05). Client-only: unlike Cascade there is
   * no request/reply with a backend, so this never fails and never reports
   * `reconnectedStt` — a Realtime `session.update` reconfigures the running
   * session in place instead of reopening anything.
   */
  const applyTuning = useCallback(
    (config: ModeTuningConfig): Promise<ApplyResult> => {
      const configFingerprint = fingerprint(config);
      const deferred: ApplyResult = {
        ok: true,
        fingerprint: configFingerprint,
        reconnectedStt: false,
        deferred: true,
      };
      // The transcript check (ticket 15) runs from here, not from OpenAI, so it
      // moves as soon as Apply is pressed rather than waiting for the turn
      // boundary a `session.update` needs: there is no reply mid-flight for it
      // to reconfigure underneath, and nothing audible changes.
      liveTuningRef.current = config;
      const channel = dataChannelRef.current;
      // No session: there is nobody to tell. The panel commits locally and the
      // next connect() carries the config in POST /api/realtime/session
      // (wireframe §4's "Apply at next connect"). Nothing is queued, because
      // connect() applies it as the session's starting config anyway.
      if (!channel) return Promise.resolve(deferred);
      // Mid-reply, or the channel isn't open yet: hold it in the single slot
      // (Step 5 gate outcome 2 — queued to the next turn boundary).
      if (isReplyActiveRef.current || channel.readyState !== 'open') {
        pendingTuningRef.current = config;
        return Promise.resolve(deferred);
      }
      sendSessionUpdate(config);
      return Promise.resolve({
        ok: true,
        fingerprint: configFingerprint,
        reconnectedStt: false,
        deferred: false,
      });
    },
    [sendSessionUpdate],
  );

  /**
   * ticket 15: asks the backend whether a settled turn looks misrecognised.
   *
   * Cascade runs the same `TranscriptChecker` inline, but a Realtime session is
   * browser-to-OpenAI: this is the only seam there is, and the browser has no
   * API key of its own. Hence a round trip, best-effort at both ends:
   * fire-and-forget here, `200 {"failed": true}` there. Nothing about the
   * transcript, the audio or the latency measurement waits on it, and a failure
   * costs a badge, never a turn (story AC 4.3).
   */
  const runTranscriptCheck = useCallback((turnText: string) => {
    const tuning = liveTuningRef.current;
    // `correct` is unavailable in Realtime (locked decision 4), so `flag` is
    // the only mode that calls anything; `off` is the absence of a call.
    const check = tuning?.mode === 'realtime' ? tuning.realtime.transcriptCheck : undefined;
    if (check?.mode !== 'flag') return;
    const text = turnText.trim();
    const language = languagesRef.current?.sourceLanguage;
    if (!text || !language) return;

    const controller = checkAbortRef.current;
    const turn = turnSeqRef.current;
    void (async () => {
      try {
        const response = await fetch(TRANSCRIPT_CHECK_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text.slice(0, MAX_CHECK_TEXT_CHARS),
            language,
            mode: 'flag',
            model: check.model,
          }),
          signal: controller?.signal,
        });
        if (!response.ok) {
          throw new Error(`Transcript check failed with status ${response.status}`);
        }
        const verdict = (await response.json()) as TranscriptCheckResponse;
        // The session is gone, or the pane has moved on: either way this
        // verdict is about text nobody is looking at any more.
        if (controller?.signal.aborted || turn !== turnSeqRef.current) return;
        if (verdict.flagged) setSourceFlagged(true);
      } catch (err) {
        // Teardown aborting our own request is not a failure worth a line.
        if (controller?.signal.aborted) return;
        console.warn('Realtime: the transcript check could not run for this turn; leaving it unflagged.', err);
      }
    })();
  }, []);

  const handleOaiEvent = useCallback((event: MessageEvent) => {
    let message: OaiEvent;
    try {
      message = JSON.parse(event.data as string) as OaiEvent;
    } catch {
      console.warn('Realtime: received a non-JSON oai-events message; ignoring it.');
      return;
    }

    switch (message.type) {
      // What the user said, as it's transcribed.
      case 'conversation.item.input_audio_transcription.delta':
        if (typeof message.delta === 'string') {
          setSourceText((text) => text + message.delta);
        }
        break;
      // The turn's transcription is finished — the settle point ticket 15's
      // check runs on. It carries the whole turn (`transcript`), so there is
      // nothing to reassemble from the deltas above. Chosen over
      // `speech_stopped`/`response.done` because those say when the audio ended,
      // not when there was a final transcript to check.
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof message.transcript === 'string') {
          runTranscriptCheck(message.transcript);
        }
        break;
      // The user is talking again: whatever the last turn was flagged for is no
      // longer what the pane is about. The pane is one running string with no
      // segment boundaries, so this is also where turns get a space between
      // them ("…desde aquí? Sure…" rather than "…desde aquí?Sure…").
      case 'input_audio_buffer.speech_started':
        turnSeqRef.current += 1;
        setSourceFlagged(false);
        setSourceText((text) => (text && !text.endsWith(' ') ? `${text} ` : text));
        break;
      // The user stopped talking: our "speech end" reference point for the
      // end-to-end latency measurement (ticket 06). There is no backend
      // visibility in Realtime mode, so this and the transcript delta below
      // are measured entirely client-side from data-channel events.
      case 'input_audio_buffer.speech_stopped':
        setLatencyState((state) => onSpeechStopped(state, Date.now()));
        break;
      // What the model is saying back, as it's synthesized. Its first
      // occurrence after speech_stopped is our proxy for "the response has
      // started"; see realtimeLatency.ts for why this is an approximation,
      // not a precise playback-start timestamp.
      case 'response.output_audio_transcript.delta': {
        // The model has started (or is still) talking: mute the track we are
        // sending so its own voice, if picked up by the mic off the speakers,
        // can't be sent back as new input. Re-armed on every delta rather
        // than once, so a late-arriving unmute from a previous, shorter gap
        // in deltas can't re-enable the mic mid-response.
        const sentTrack = sentTrackRef.current;
        if (sentTrack) sentTrack.enabled = false;
        isReplyActiveRef.current = true;
        if (unmuteTimeoutRef.current !== null) {
          clearTimeout(unmuteTimeoutRef.current);
          unmuteTimeoutRef.current = null;
        }
        if (typeof message.delta === 'string') {
          // Same running-string join as the source pane: the first delta of a
          // new response follows the previous one with a space.
          const delta = message.delta;
          const separator = targetNeedsSeparatorRef.current ? ' ' : '';
          targetNeedsSeparatorRef.current = false;
          setTargetText((text) => (text ? `${text}${separator}${delta}` : delta));
        }
        setLatencyState((state) => onResponseAudioTranscriptDelta(state, Date.now()));
        break;
      }
      case 'response.done':
        targetNeedsSeparatorRef.current = true;
        unmuteTimeoutRef.current = setTimeout(() => {
          const sentTrack = sentTrackRef.current;
          if (sentTrack) sentTrack.enabled = true;
          unmuteTimeoutRef.current = null;
          // The reply has finished playing out: this is the turn boundary a
          // deferred tuning apply has been waiting for (ticket 05).
          isReplyActiveRef.current = false;
          flushPendingTuning();
        }, REALTIME_MUTE_TAIL_MS);
        break;
      default:
        break;
    }
  }, [flushPendingTuning, runTranscriptCheck]);

  // Stops the level meter and closes its dedicated AudioContext: needed
  // both by full teardown and by connect()'s own failure paths, since level
  // metering starts before the call is known to succeed.
  const stopLevelMetering = useCallback(() => {
    levelMeterRef.current?.stop();
    levelMeterRef.current = null;
    void levelAudioContextRef.current?.close();
    levelAudioContextRef.current = null;
  }, []);

  // Releases the mic and tears down the peer connection / level-metering
  // audio context: shared by both the explicit disconnect() call and the
  // unmount cleanup effect below.
  const teardown = useCallback(() => {
    stopLevelMetering();
    stopClientDsp();
    sentTrackRef.current = null;
    if (unmuteTimeoutRef.current !== null) {
      clearTimeout(unmuteTimeoutRef.current);
      unmuteTimeoutRef.current = null;
    }
    isReplyActiveRef.current = false;
    // Nothing queued survives the session it was queued against: the panel was
    // told `deferred`, and the config it holds is what the next connect() sends.
    pendingTuningRef.current = null;
    // A check still in flight has nothing left to badge (ticket 15).
    checkAbortRef.current?.abort();
    checkAbortRef.current = null;
    liveTuningRef.current = null;
    languagesRef.current = null;
    dataChannelRef.current = null;
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    const stream = mediaStreamRef.current;
    if (stream) {
      stopMediaStream(stream);
    }
    mediaStreamRef.current = null;
  }, [stopClientDsp, stopLevelMetering]);

  const disconnect = useCallback(() => {
    teardown();
    setStatus('idle');
    setErrorMessage(null);
    setMicLevel(0);
    setAppliedFingerprint(null);
    setSourceFlagged(false);
  }, [teardown]);

  const connect = useCallback(
    (languages: SessionLanguages, tuning?: ModeTuningConfig) => {
      void (async () => {
        setStatus('connecting');
        setErrorMessage(null);
        setSourceText('');
        setTargetText('');
        setLatencyState(EMPTY_REALTIME_LATENCY);
        setAppliedFingerprint(null);
        setSourceFlagged(false);
        pendingTuningRef.current = null;
        isReplyActiveRef.current = false;
        sentTrackRef.current = null;
        // ticket 15: the config and language pair the checks for this session
        // run under, and the controller that cancels them at teardown.
        liveTuningRef.current = tuning ?? null;
        languagesRef.current = languages;
        turnSeqRef.current = 0;
        checkAbortRef.current = new AbortController();

        // ticket 11: EC/NS/AGC come from the panel, defaulting to the same
        // all-on constraints this hook has always requested (that is what
        // `DEFAULT_TUNING_CONFIG.client.microphone` records). They are
        // `getUserMedia`-time, so a change only reaches the track on the next
        // connect — no renegotiation, no reconnect. Realtime pins no capture
        // format: WebRTC negotiates rate and channel count itself.
        const microphone = tuning?.client.microphone ?? DEFAULT_TUNING_CONFIG.client.microphone;
        const stream = await requestMicStream(
          {
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

        try {
          // Level metering is a nice-to-have alongside the actual call setup
          // below; a failure here shouldn't fail the whole connection.
          const levelAudioContext = new AudioContext();
          levelAudioContextRef.current = levelAudioContext;
          const micSource = levelAudioContext.createMediaStreamSource(stream);
          levelMeterRef.current = startMicLevelMeter(levelAudioContext, micSource, setMicLevel);
        } catch (err) {
          console.warn('Realtime: mic level metering unavailable.', err);
        }

        let session: RealtimeSessionResponse;
        try {
          const response = await fetch(REALTIME_SESSION_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // The key is omitted, not sent as null, when there is no config:
            // absent means "the server's own defaults", which is exactly the
            // behaviour every call site had before tuning existed.
            body: JSON.stringify({
              sourceLanguage: languages.sourceLanguage,
              targetLanguage: languages.targetLanguage,
              ...(tuning ? { tuning } : {}),
            }),
          });
          if (!response.ok) {
            throw new Error(`Session request failed with status ${response.status}`);
          }
          session = await response.json();
        } catch {
          fail('Could not start a realtime session. Is the backend running?');
          stopLevelMetering();
          stopMediaStream(stream);
          return;
        }

        // The server is the authority on what it applied. `appliedTuning` is
        // its echo of the document, absent keys still absent, so it must hash
        // to the fingerprint it just reported — if it doesn't, one side dropped
        // or renamed a key and every benchmark row from this session would be
        // joined to the wrong config. Worth a line in the console; not worth
        // refusing to start a session over.
        setAppliedFingerprint(session.fingerprint ?? null);
        if (session.fingerprint && session.appliedTuning) {
          const echoed = fingerprint(session.appliedTuning);
          if (echoed !== session.fingerprint) {
            console.warn(
              `Realtime: the server reported ${session.fingerprint} but the config it echoed back hashes to`,
              echoed,
            );
          }
        }

        // ticket 12: with a client DSP stage enabled the track WebRTC carries is
        // the processed one, not the mic's own. Built here rather than earlier
        // so the two failure paths above (mic denied, session request refused)
        // never leave an AudioContext open behind them.
        const client = tuning?.client ?? DEFAULT_TUNING_CONFIG.client;
        const processedStream = await buildClientDsp(stream, client);
        const sentStream = processedStream ?? stream;
        const sentTrack = sentStream.getAudioTracks()[0];
        sentTrackRef.current = sentTrack;

        const pc = new RTCPeerConnection();
        peerConnectionRef.current = pc;

        pc.ontrack = (event) => {
          if (audioRef.current) {
            audioRef.current.srcObject = event.streams[0] ?? null;
          }
        };

        try {
          pc.addTrack(sentTrack, sentStream);
          const dataChannel = pc.createDataChannel('oai-events');
          dataChannel.onmessage = handleOaiEvent;
          // The channel is receive-only until it opens; an apply made while
          // the session was still coming up goes out here (ticket 05, E3).
          dataChannel.onopen = () => flushPendingTuning();
          dataChannelRef.current = dataChannel;

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          const sdpResponse = await fetch(OPENAI_REALTIME_CALLS_ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.client_secret}`,
              'Content-Type': 'application/sdp',
            },
            body: offer.sdp,
          });

          if (!sdpResponse.ok) {
            throw new Error(`OpenAI SDP exchange failed with status ${sdpResponse.status}`);
          }

          const answerSdp = await sdpResponse.text();
          await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

          setStatus('connected');
        } catch {
          fail('Could not establish the realtime connection. Please try again.');
          pc.close();
          peerConnectionRef.current = null;
          stopLevelMetering();
          stopClientDsp();
          sentTrackRef.current = null;
          stopMediaStream(stream);
        }
      })();
    },
    [buildClientDsp, fail, flushPendingTuning, handleOaiEvent, stopClientDsp, stopLevelMetering],
  );

  // Release the mic and tear down the peer connection if the page unmounts
  // mid-session.
  useEffect(() => teardown, [teardown]);

  return {
    status,
    errorMessage,
    sourceText,
    targetText,
    sourceFlagged,
    micLevel,
    endToEndLatencyMs: latencyState.endToEndMs,
    appliedFingerprint,
    applyTuning,
    connect,
    disconnect,
    audioRef,
  };
}
