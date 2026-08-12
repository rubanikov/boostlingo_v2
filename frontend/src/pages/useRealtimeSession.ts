import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestMicStream, stopMediaStream } from './mediaStream';
import { startMicLevelMeter, type MicLevelMeter } from './micLevel';
import { OPENAI_REALTIME_CALLS_ENDPOINT, REALTIME_SESSION_ENDPOINT } from './realtimeConfig';
import {
  EMPTY_REALTIME_LATENCY,
  onResponseAudioTranscriptDelta,
  onSpeechStopped,
  type RealtimeLatencyState,
} from './realtimeLatency';
import type { ConnectionStatus, SessionHandle, SessionLanguages } from './sessionHandle';

export type { ConnectionStatus } from './sessionHandle';

// Shape of our backend's POST /api/realtime/session response: the ephemeral
// token lives in `client_secret`. See backend/app/api/realtime.py's
// RealtimeSessionResponse (reconciled against ticket 01's contract).
interface RealtimeSessionResponse {
  client_secret: string;
  expires_at: number;
  model: string;
  voice: string;
}

/**
 * One JSON event from the `oai-events` WebRTC data channel. Only the
 * transcript-delta events we handle below are typed further; every other
 * event type (session.*, response.*, ...) is ignored for this ticket.
 */
interface OaiEvent {
  type: string;
  delta?: string;
}

export interface UseRealtimeSessionResult extends SessionHandle {
  audioRef: RefObject<HTMLAudioElement | null>;
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
  const [latencyState, setLatencyState] = useState<RealtimeLatencyState>(EMPTY_REALTIME_LATENCY);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const levelAudioContextRef = useRef<AudioContext | null>(null);
  const levelMeterRef = useRef<MicLevelMeter | null>(null);

  const fail = useCallback((message: string) => {
    setStatus('error');
    setErrorMessage(message);
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
      case 'response.output_audio_transcript.delta':
        if (typeof message.delta === 'string') {
          setTargetText((text) => text + message.delta);
        }
        setLatencyState((state) => onResponseAudioTranscriptDelta(state, Date.now()));
        break;
      default:
        break;
    }
  }, []);

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
    dataChannelRef.current = null;
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    const stream = mediaStreamRef.current;
    if (stream) {
      stopMediaStream(stream);
    }
    mediaStreamRef.current = null;
  }, [stopLevelMetering]);

  const disconnect = useCallback(() => {
    teardown();
    setStatus('idle');
    setErrorMessage(null);
    setMicLevel(0);
  }, [teardown]);

  const connect = useCallback(
    (languages: SessionLanguages) => {
      void (async () => {
        setStatus('connecting');
        setErrorMessage(null);
        setSourceText('');
        setTargetText('');
        setLatencyState(EMPTY_REALTIME_LATENCY);

        const stream = await requestMicStream(true, fail);
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
            body: JSON.stringify({ sourceLanguage: languages.sourceLanguage, targetLanguage: languages.targetLanguage }),
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

        const pc = new RTCPeerConnection();
        peerConnectionRef.current = pc;

        pc.ontrack = (event) => {
          if (audioRef.current) {
            audioRef.current.srcObject = event.streams[0] ?? null;
          }
        };

        try {
          pc.addTrack(stream.getTracks()[0], stream);
          const dataChannel = pc.createDataChannel('oai-events');
          dataChannel.onmessage = handleOaiEvent;
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
          stopMediaStream(stream);
        }
      })();
    },
    [fail, handleOaiEvent, stopLevelMetering],
  );

  // Release the mic and tear down the peer connection if the page unmounts
  // mid-session.
  useEffect(() => teardown, [teardown]);

  return {
    status,
    errorMessage,
    sourceText,
    targetText,
    micLevel,
    endToEndLatencyMs: latencyState.endToEndMs,
    connect,
    disconnect,
    audioRef,
  };
}
