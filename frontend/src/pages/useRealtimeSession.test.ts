import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  MockRTCDataChannel,
  MockRTCPeerConnection,
  createMockMicStream,
  createRealtimeFetchRouter,
  installFakeAudioApis,
  installMockRTCPeerConnection,
  jsonResponse,
  textResponse,
} from '../test/mockRealtimeApis';
import { installMockGetUserMedia } from '../test/mockCascadeApis';
import { installManualAnimationFrame } from '../test/mockAudioAnalysis';
import { loadRnnoiseMock } from '../test/mockRnnoise';
import { GATE_WORKLET_NAME, GATE_WORKLET_URL } from './gateConfig';
import { RNNOISE_WASM_URLS, RNNOISE_WORKLET_NAME, RNNOISE_WORKLET_URL } from './rnnoiseConfig';
import {
  OPENAI_REALTIME_CALLS_ENDPOINT,
  REALTIME_SESSION_ENDPOINT,
  TRANSCRIPT_CHECK_ENDPOINT,
} from './realtimeConfig';
import {
  DEFAULT_TUNING_CONFIG,
  fingerprint,
  projectMode,
  type ClientTuning,
  type ModeTuningConfig,
  type RealtimeTuning,
  type TuningConfig,
} from './tuningConfig';
import { sessionUpdateEvent, useRealtimeSession } from './useRealtimeSession';

// jsdom has no AudioWorklet and no wasm to fetch; the package's node class also
// subclasses the real `AudioWorkletNode` at module-evaluation time. See
// `mockRnnoise.ts` for why the package is mocked and not `rnnoiseConfig.ts`.
vi.mock('@sapphi-red/web-noise-suppressor', async () => {
  const { createRnnoiseModuleMock } = await import('../test/mockRnnoise');
  return createRnnoiseModuleMock();
});

const LANGUAGES = { sourceLanguage: 'en', targetLanguage: 'es' };

/** A realtime config with one turn-detection key set and the rest still absent. */
function tunedRealtimeConfig(): ModeTuningConfig {
  const config = structuredClone(DEFAULT_TUNING_CONFIG);
  config.realtime.turnDetection.silenceDurationMs = 300;
  return projectMode(config, 'realtime');
}

/** A realtime config whose `realtime` block is edited in place by `edit`. */
function realtimeConfigWith(edit: (realtime: RealtimeTuning) => void): ModeTuningConfig {
  const config: TuningConfig = structuredClone(DEFAULT_TUNING_CONFIG);
  edit(config.realtime);
  return projectMode(config, 'realtime');
}

/** A session response whose `fingerprint` is the server's own, not ours to guess. */
function confirmingBody(serverFingerprint: string) {
  return {
    client_secret: 'ek_test_token',
    expires_at: 1893456000,
    model: 'gpt-realtime',
    voice: 'alloy',
    fingerprint: serverFingerprint,
  };
}

function confirmingSession(serverFingerprint: string) {
  return jsonResponse(confirmingBody(serverFingerprint));
}

function sessionRequestBody(fetchMock: ReturnType<typeof createRealtimeFetchRouter>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]) => url === REALTIME_SESSION_ENDPOINT);
  if (!call) throw new Error('no session request was made');
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

/** Every client event the hook put on the data channel, parsed back. */
function sentEvents(channel: MockRTCDataChannel): unknown[] {
  return channel.send.mock.calls.map(([payload]) => JSON.parse(String(payload)) as unknown);
}

function stubMediaDevices(getUserMedia: (...args: unknown[]) => unknown) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
    writable: true,
  });
}

function stubHappyPathFetch(...args: Parameters<typeof createRealtimeFetchRouter>) {
  const fetchMock = createRealtimeFetchRouter(...args);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useRealtimeSession', () => {
  it('starts idle with no error and a zero mic level', () => {
    const { result } = renderHook(() => useRealtimeSession());
    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.micLevel).toBe(0);
  });

  it('shows an inline error and does not throw when mic permission is denied', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    stubMediaDevices(getUserMedia);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });

    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.errorMessage).toMatch(/microphone access was denied/i);
    // Denial should short-circuit before any network calls are made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a generic error for non-permission mic failures', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('device not found'));
    stubMediaDevices(getUserMedia);
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toMatch(/could not access the microphone/i);
  });

  it('connects through the full offer/answer flow, sending the chosen languages and only the ephemeral token, and wires remote audio', async () => {
    const { stream, track } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    const fetchMock = stubHappyPathFetch();
    installMockRTCPeerConnection();

    const { result } = renderHook(() => useRealtimeSession());

    const fakeAudioEl = { srcObject: null } as unknown as HTMLAudioElement;
    result.current.audioRef.current = fakeAudioEl;

    act(() => {
      result.current.connect(LANGUAGES);
    });

    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(result.current.errorMessage).toBeNull();

    expect(fetchMock).toHaveBeenCalledWith(REALTIME_SESSION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'es' }),
    });

    const pc = MockRTCPeerConnection.instances[0];
    expect(pc.addTrack).toHaveBeenCalledWith(track, stream);
    expect(pc.createDataChannel).toHaveBeenCalledWith('oai-events');
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'v=0\r\no=- fake-answer\r\n',
    });

    const sdpCall = fetchMock.mock.calls.find(([url]) => url === OPENAI_REALTIME_CALLS_ENDPOINT);
    const init = sdpCall?.[1];
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer ek_test_token', 'Content-Type': 'application/sdp' },
      body: 'v=0\r\no=- fake-offer\r\n',
    });

    // Simulate OpenAI's remote audio track arriving over the peer connection.
    const remoteStream = { id: 'remote-stream' } as unknown as MediaStream;
    act(() => {
      pc.emitTrack(remoteStream);
    });
    expect(fakeAudioEl.srcObject).toBe(remoteStream);
  });

  it('accumulates source and target transcripts from oai-events deltas independently, appended not re-rendered', async () => {
    const { stream } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    stubHappyPathFetch();
    installMockRTCPeerConnection();

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const pc = MockRTCPeerConnection.instances[0];
    const dataChannel = pc.dataChannel;
    if (!dataChannel) throw new Error('expected a data channel to have been created');

    act(() => {
      dataChannel.emitMessage(
        JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hi' }),
      );
      dataChannel.emitMessage(
        JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: ' there' }),
      );
      dataChannel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));
    });

    expect(result.current.sourceText).toBe('Hi there');
    expect(result.current.targetText).toBe('Hola');

    // Unrecognized/irrelevant event types are ignored, not thrown on.
    act(() => {
      dataChannel.emitMessage(JSON.stringify({ type: 'response.done' }));
      dataChannel.emitMessage('not json');
    });
    expect(result.current.sourceText).toBe('Hi there');
  });

  it('disables the local mic track while the model is speaking, then re-enables it once its reply finishes', async () => {
    // Regression test for a real feedback loop found via manual testing: an
    // unmuted mic transcribed the app's own translated reply off the
    // speakers and re-translated it, looping indefinitely.
    const { stream, track } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    stubHappyPathFetch();
    installMockRTCPeerConnection();

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(track.enabled).not.toBe(false); // not muted before the model has said anything

    const pc = MockRTCPeerConnection.instances[0];
    const dataChannel = pc.dataChannel;
    if (!dataChannel) throw new Error('expected a data channel to have been created');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      act(() => {
        dataChannel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));
      });
      expect(track.enabled).toBe(false); // muted the instant the model starts talking

      act(() => {
        dataChannel.emitMessage(JSON.stringify({ type: 'response.done' }));
      });
      expect(track.enabled).toBe(false); // still muted immediately after response.done

      act(() => {
        vi.advanceTimersByTime(400); // past REALTIME_MUTE_TAIL_MS
      });
      expect(track.enabled).toBe(true); // unmuted once the trailing buffer clears
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts with endToEndLatencyMs null', () => {
    const { result } = renderHook(() => useRealtimeSession());
    expect(result.current.endToEndLatencyMs).toBeNull();
  });

  it('computes endToEndLatencyMs from speech_stopped to the first response transcript delta after it (ticket 06)', async () => {
    const { stream } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    stubHappyPathFetch();
    installMockRTCPeerConnection();

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const pc = MockRTCPeerConnection.instances[0];
    const dataChannel = pc.dataChannel;
    if (!dataChannel) throw new Error('expected a data channel to have been created');

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000); // speech_stopped
    act(() => {
      dataChannel.emitMessage(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    });
    expect(result.current.endToEndLatencyMs).toBeNull();

    nowSpy.mockReturnValueOnce(1_420); // first response transcript delta after it
    act(() => {
      dataChannel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));
    });
    expect(result.current.endToEndLatencyMs).toBe(420);

    // A later delta from the same response keeps streaming text in but must
    // not re-measure/overwrite this turn's latency number.
    nowSpy.mockReturnValueOnce(1_900);
    act(() => {
      dataChannel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: ' mundo' }));
    });
    expect(result.current.endToEndLatencyMs).toBe(420);
    expect(result.current.targetText).toBe('Hola mundo');

    nowSpy.mockRestore();
  });

  it('resets endToEndLatencyMs to null at the start of the next turn', async () => {
    const { stream } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    stubHappyPathFetch();
    installMockRTCPeerConnection();

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const pc = MockRTCPeerConnection.instances[0];
    const dataChannel = pc.dataChannel;
    if (!dataChannel) throw new Error('expected a data channel to have been created');

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000);
    act(() => {
      dataChannel.emitMessage(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    });
    nowSpy.mockReturnValueOnce(1_300);
    act(() => {
      dataChannel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));
    });
    expect(result.current.endToEndLatencyMs).toBe(300);

    nowSpy.mockReturnValueOnce(5_000); // next turn's speech_stopped
    act(() => {
      dataChannel.emitMessage(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    });
    expect(result.current.endToEndLatencyMs).toBeNull();

    nowSpy.mockRestore();
  });

  it('exposes a live mic level derived from an AnalyserNode on the mic stream', async () => {
    installFakeAudioApis();
    const rafStub = installManualAnimationFrame();
    const { stream } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    stubHappyPathFetch();
    installMockRTCPeerConnection();

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const analyser = FakeAudioContext.instances.flatMap((ctx) => ctx.createdAnalysers).at(-1);
    if (!analyser) throw new Error('expected an analyser to have been created');
    analyser.setNextData(new Uint8Array([128, 0])); // loud sample -> level 1

    act(() => rafStub.flush());

    await waitFor(() => expect(result.current.micLevel).toBe(1));
  });

  it('surfaces an error and releases the mic when the backend session request fails', async () => {
    const { stream, stop } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => '' }),
    );
    installMockRTCPeerConnection();

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toMatch(/could not start a realtime session/i);
    // Never got as far as building a peer connection.
    expect(MockRTCPeerConnection.instances).toHaveLength(0);
    expect(stop).toHaveBeenCalled();
  });

  it('surfaces an error and tears down the connection when the OpenAI SDP exchange fails', async () => {
    const { stream, stop } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    stubHappyPathFetch({ callsResponse: textResponse('bad request', 400) });
    installMockRTCPeerConnection();

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toMatch(/could not establish the realtime connection/i);

    const pc = MockRTCPeerConnection.instances[0];
    expect(pc.close).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it('closes the peer connection and stops the mic on unmount', async () => {
    const { stream, stop } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    stubHappyPathFetch();
    installMockRTCPeerConnection();

    const { result, unmount } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const pc = MockRTCPeerConnection.instances[0];
    unmount();

    expect(pc.close).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  describe('start-of-session tuning (ticket 04)', () => {
    async function connectWith(tuning?: ModeTuningConfig) {
      const { stream } = createMockMicStream();
      stubMediaDevices(vi.fn().mockResolvedValue(stream));
      installMockRTCPeerConnection();
      const { result } = renderHook(() => useRealtimeSession());
      act(() => {
        result.current.connect(LANGUAGES, tuning);
      });
      await waitFor(() => expect(result.current.status).toBe('connected'));
      return result;
    }

    it('sends the config it was given as a nested `tuning` field, alongside the languages', async () => {
      const fetchMock = stubHappyPathFetch();
      const tuning = tunedRealtimeConfig();

      await connectWith(tuning);

      expect(sessionRequestBody(fetchMock)).toEqual({
        sourceLanguage: 'en',
        targetLanguage: 'es',
        tuning,
      });
    });

    it('omits the `tuning` key entirely when it has no config, so the server keeps its own defaults', async () => {
      const fetchMock = stubHappyPathFetch();

      await connectWith(undefined);

      const body = sessionRequestBody(fetchMock);
      expect(body).not.toHaveProperty('tuning');
      expect(body).toEqual({ sourceLanguage: 'en', targetLanguage: 'es' });
    });

    it('preserves an unset knob as an absent key rather than sending a default value for it', async () => {
      const fetchMock = stubHappyPathFetch();

      await connectWith(tunedRealtimeConfig());

      const sent = (sessionRequestBody(fetchMock).tuning as ModeTuningConfig & { realtime: { turnDetection: object } })
        .realtime.turnDetection;
      expect(sent).toEqual({ type: 'server_vad', silenceDurationMs: 300 });
      expect(sent).not.toHaveProperty('threshold');
      expect(sessionRequestBody(fetchMock).tuning).not.toHaveProperty('realtime.noiseReduction');
    });

    it('adopts the fingerprint the server confirms it applied, in preference to anything computed locally', async () => {
      stubHappyPathFetch({ sessionResponse: confirmingSession('cfg:5eeded01') });

      const result = await connectWith(tunedRealtimeConfig());

      expect(result.current.appliedFingerprint).toBe('cfg:5eeded01');
    });

    it('reports no confirmed fingerprint when the server does not send one', async () => {
      // An older server: the four original fields and nothing else. The shell
      // falls back to its own fingerprint rather than showing a wrong one.
      stubHappyPathFetch({
        sessionResponse: jsonResponse({
          client_secret: 'ek_test_token',
          expires_at: 1893456000,
          model: 'gpt-realtime',
          voice: 'alloy',
        }),
      });

      const result = await connectWith(tunedRealtimeConfig());

      expect(result.current.appliedFingerprint).toBeNull();
    });

    it('warns when the config the server echoed back does not hash to the fingerprint it reported', async () => {
      // The one failure that would silently join benchmark rows to the wrong
      // config: the server dropped or renamed a key on the way in.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubHappyPathFetch({
        sessionResponse: jsonResponse({
          ...confirmingBody('cfg:deadbeef'),
          appliedTuning: projectMode(DEFAULT_TUNING_CONFIG, 'realtime'),
        }),
      });

      const result = await connectWith(tunedRealtimeConfig());

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cfg:deadbeef'), expect.any(String));
      // The server's own word still wins: it is the thing that ran.
      expect(result.current.appliedFingerprint).toBe('cfg:deadbeef');
      warn.mockRestore();
    });

    it('clears the confirmed fingerprint on disconnect — nothing is running any more', async () => {
      stubHappyPathFetch({ sessionResponse: confirmingSession('cfg:5eeded01') });

      const result = await connectWith(tunedRealtimeConfig());
      expect(result.current.appliedFingerprint).toBe('cfg:5eeded01');

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.appliedFingerprint).toBeNull();
    });
  });

  /**
   * S21 / story AC 3.1. Realtime's constraints are the three browser flags and
   * nothing else — WebRTC negotiates the rate and channel count itself, so
   * unlike Cascade there is no capture format to pin here.
   */
  describe('ticket 11: microphone constraints', () => {
    function micTuning(microphone: ClientTuning['microphone']): ModeTuningConfig {
      const config = structuredClone(DEFAULT_TUNING_CONFIG);
      config.client.microphone = microphone;
      return projectMode(config, 'realtime');
    }

    async function connectWithMic(tuning?: ModeTuningConfig) {
      const getUserMedia = installMockGetUserMedia(async () => createMockMicStream().stream);
      stubHappyPathFetch();
      installMockRTCPeerConnection();
      const { result } = renderHook(() => useRealtimeSession());
      act(() => {
        result.current.connect(LANGUAGES, tuning);
      });
      await waitFor(() => expect(result.current.status).toBe('connected'));
      return getUserMedia;
    }

    it('asks getUserMedia for exactly the constraints the panel set, not hardcoded trues (S21)', async () => {
      const getUserMedia = await connectWithMic(
        micTuning({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
      );

      expect(getUserMedia).toHaveBeenCalledWith({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    });

    it('carries each constraint independently rather than one flag for all three', async () => {
      const getUserMedia = await connectWithMic(
        micTuning({ echoCancellation: false, noiseSuppression: true, autoGainControl: false }),
      );

      expect(getUserMedia).toHaveBeenCalledWith({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
      });
    });

    it('keeps the pre-tuning all-on constraints when connect() is given no config', async () => {
      const getUserMedia = await connectWithMic();

      expect(getUserMedia).toHaveBeenCalledWith({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    });
  });

  describe('live apply (ticket 05)', () => {
    /** Connects, and hands back the data channel OpenAI would be talking over. */
    async function connectedSession() {
      const { stream } = createMockMicStream();
      stubMediaDevices(vi.fn().mockResolvedValue(stream));
      stubHappyPathFetch();
      installMockRTCPeerConnection();

      const { result } = renderHook(() => useRealtimeSession());
      act(() => {
        result.current.connect(LANGUAGES);
      });
      await waitFor(() => expect(result.current.status).toBe('connected'));

      const channel = MockRTCPeerConnection.instances[0].dataChannel;
      if (!channel) throw new Error('expected a data channel to have been created');
      return { result, channel };
    }

    it('S7: sends exactly one session.update in the GA shape on a connected session, without tearing it down', async () => {
      const { result, channel } = await connectedSession();
      act(() => channel.emitOpen());
      const config = tunedRealtimeConfig();

      let applied: Awaited<ReturnType<NonNullable<typeof result.current.applyTuning>>> | undefined;
      await act(async () => {
        applied = await result.current.applyTuning(config);
      });

      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(sentEvents(channel)[0]).toEqual({
        type: 'session.update',
        session: {
          type: 'realtime',
          audio: { input: { turn_detection: { type: 'server_vad', silence_duration_ms: 300 } } },
        },
      });
      expect(applied).toEqual({
        ok: true,
        fingerprint: fingerprint(config),
        reconnectedStt: false,
        deferred: false,
      });
      // The panel's chip follows the apply: Realtime confirms its own, there
      // being no server in the loop after connect.
      expect(result.current.appliedFingerprint).toBe(fingerprint(config));
      // The whole point of a live apply: no reconnect, no teardown.
      expect(result.current.status).toBe('connected');
      expect(MockRTCPeerConnection.instances[0].close).not.toHaveBeenCalled();
      expect(MockRTCPeerConnection.instances).toHaveLength(1);
    });

    it('E2: queues an apply made mid-reply and sends one event, with the later config, after response.done + the mute tail', async () => {
      const { result, channel } = await connectedSession();
      act(() => channel.emitOpen());
      const first = realtimeConfigWith((realtime) => {
        realtime.turnDetection.silenceDurationMs = 300;
      });
      const second = realtimeConfigWith((realtime) => {
        realtime.turnDetection.silenceDurationMs = 700;
      });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        act(() => {
          channel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));
        });

        let firstResult: Awaited<ReturnType<NonNullable<typeof result.current.applyTuning>>> | undefined;
        await act(async () => {
          firstResult = await result.current.applyTuning(first);
          await result.current.applyTuning(second);
        });

        expect(firstResult).toEqual({
          ok: true,
          fingerprint: fingerprint(first),
          reconnectedStt: false,
          deferred: true,
        });
        expect(channel.send).not.toHaveBeenCalled();

        act(() => {
          channel.emitMessage(JSON.stringify({ type: 'response.done' }));
        });
        expect(channel.send).not.toHaveBeenCalled(); // the tail is still running

        await act(async () => {
          vi.advanceTimersByTime(400); // past REALTIME_MUTE_TAIL_MS
        });

        // Two rapid Applies, one event: the pending slot is overwritten, never
        // appended to.
        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(sentEvents(channel)[0]).toEqual({
          type: 'session.update',
          session: {
            type: 'realtime',
            audio: { input: { turn_detection: { type: 'server_vad', silence_duration_ms: 700 } } },
          },
        });
        expect(result.current.appliedFingerprint).toBe(fingerprint(second));
      } finally {
        vi.useRealTimers();
      }
    });

    it('E3: queues an apply made while the data channel is still connecting and flushes it once on open', async () => {
      const { result, channel } = await connectedSession();
      expect(channel.readyState).toBe('connecting');
      const config = tunedRealtimeConfig();

      let queued: Awaited<ReturnType<NonNullable<typeof result.current.applyTuning>>> | undefined;
      await act(async () => {
        queued = await result.current.applyTuning(config);
      });

      expect(queued).toEqual({
        ok: true,
        fingerprint: fingerprint(config),
        reconnectedStt: false,
        deferred: true,
      });
      expect(channel.send).not.toHaveBeenCalled();

      act(() => channel.emitOpen());

      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(sentEvents(channel)[0]).toMatchObject({
        session: { audio: { input: { turn_detection: { silence_duration_ms: 300 } } } },
      });
      expect(result.current.appliedFingerprint).toBe(fingerprint(config));
    });

    it('reports a deferred apply without sending anything when there is no session', async () => {
      const { result } = renderHook(() => useRealtimeSession());
      const config = tunedRealtimeConfig();

      let applied: Awaited<ReturnType<NonNullable<typeof result.current.applyTuning>>> | undefined;
      await act(async () => {
        applied = await result.current.applyTuning(config);
      });

      // "Apply at next connect": the panel commits locally and connect()
      // carries the config as the session's starting config.
      expect(applied).toEqual({
        ok: true,
        fingerprint: fingerprint(config),
        reconnectedStt: false,
        deferred: true,
      });
      expect(result.current.appliedFingerprint).toBeNull();
    });

    it('does not send a queued apply against a session that has been disconnected', async () => {
      const { result, channel } = await connectedSession();
      await act(async () => {
        await result.current.applyTuning(tunedRealtimeConfig());
      });

      act(() => {
        result.current.disconnect();
      });
      act(() => channel.emitOpen());

      expect(channel.send).not.toHaveBeenCalled();
    });
  });

  /**
   * ticket 15 / story ACs 4.2, 4.3 (Realtime half). Cascade's transcript check
   * runs on the backend; Realtime's is a round trip from the browser, so what
   * these cover is the round trip itself: that it happens exactly when a turn
   * settles under `flag`, carries what the server's contract asks for, and can
   * fail without taking anything else with it.
   */
  describe('transcript check (ticket 15)', () => {
    const CHECK_MODEL = DEFAULT_TUNING_CONFIG.realtime.transcriptCheck.model;

    function flagConfig(): ModeTuningConfig {
      return realtimeConfigWith((realtime) => {
        realtime.transcriptCheck.mode = 'flag';
      });
    }

    async function connectedSession(
      tuning?: ModeTuningConfig,
      overrides?: Parameters<typeof createRealtimeFetchRouter>[0],
    ) {
      // Level metering warns on a missing AudioContext, and two of these tests
      // assert on exactly which warnings the check produced.
      installFakeAudioApis();
      const { stream } = createMockMicStream();
      stubMediaDevices(vi.fn().mockResolvedValue(stream));
      const fetchMock = stubHappyPathFetch(overrides);
      installMockRTCPeerConnection();

      const { result } = renderHook(() => useRealtimeSession());
      act(() => {
        result.current.connect(LANGUAGES, tuning);
      });
      await waitFor(() => expect(result.current.status).toBe('connected'));

      const channel = MockRTCPeerConnection.instances[0].dataChannel;
      if (!channel) throw new Error('expected a data channel to have been created');
      return { result, channel, fetchMock };
    }

    /** Every `POST /api/tuning/transcript-check` this session made. */
    function checkCalls(fetchMock: ReturnType<typeof createRealtimeFetchRouter>) {
      return fetchMock.mock.calls.filter(([url]) => url === TRANSCRIPT_CHECK_ENDPOINT);
    }

    function checkBody(fetchMock: ReturnType<typeof createRealtimeFetchRouter>, index = 0): Record<string, unknown> {
      const call = checkCalls(fetchMock)[index];
      if (!call) throw new Error(`no transcript check was posted at index ${index}`);
      return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
    }

    /** The transcription of one user turn finishing — the settle point. */
    function settleTurn(channel: MockRTCDataChannel, transcript: string) {
      act(() => {
        channel.emitMessage(
          JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript }),
        );
      });
    }

    /** Lets whatever the settle kicked off run to completion. */
    async function flushCheck() {
      await act(async () => {
        await Promise.resolve();
      });
    }

    it('posts exactly one check for a settled turn, carrying the turn text, the source language and the panel’s model', async () => {
      const { channel, fetchMock } = await connectedSession(flagConfig());

      settleTurn(channel, 'I scream for ice cream');

      await waitFor(() => expect(checkCalls(fetchMock)).toHaveLength(1));
      expect(checkCalls(fetchMock)[0][1]).toMatchObject({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(checkBody(fetchMock)).toEqual({
        text: 'I scream for ice cream',
        language: 'en',
        mode: 'flag',
        model: CHECK_MODEL,
      });
    });

    it('badges the source text once the server comes back flagged', async () => {
      const { result, channel } = await connectedSession(flagConfig(), {
        transcriptCheckResponse: jsonResponse({ flagged: true, correctedText: null, elapsedMs: 120 }),
      });
      expect(result.current.sourceFlagged).toBe(false);

      settleTurn(channel, 'I scream for ice cream');

      await waitFor(() => expect(result.current.sourceFlagged).toBe(true));
    });

    it('leaves the text unbadged when the server finds nothing wrong with it', async () => {
      const { result, channel, fetchMock } = await connectedSession(flagConfig());

      settleTurn(channel, 'Hello there');

      await waitFor(() => expect(checkCalls(fetchMock)).toHaveLength(1));
      await flushCheck();
      expect(result.current.sourceFlagged).toBe(false);
    });

    it('clears the badge when the next turn starts', async () => {
      const { result, channel } = await connectedSession(flagConfig(), {
        transcriptCheckResponse: jsonResponse({ flagged: true, correctedText: null, elapsedMs: 120 }),
      });

      settleTurn(channel, 'I scream for ice cream');
      await waitFor(() => expect(result.current.sourceFlagged).toBe(true));

      act(() => {
        channel.emitMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      });

      expect(result.current.sourceFlagged).toBe(false);
    });

    it('drops a verdict that only lands after the next turn has begun', async () => {
      let answer: (verdict: unknown) => void = () => {};
      const { result, channel } = await connectedSession(flagConfig(), {
        transcriptCheckResponse: {
          ok: true,
          status: 200,
          json: () =>
            new Promise<unknown>((resolve) => {
              answer = resolve;
            }),
          text: async () => '',
        },
      });

      settleTurn(channel, 'I scream for ice cream');
      act(() => {
        channel.emitMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      });

      await act(async () => {
        answer({ flagged: true, correctedText: null, elapsedMs: 900 });
      });
      expect(result.current.sourceFlagged).toBe(false);
    });

    it('posts nothing at all in `off` mode — no call is what off means', async () => {
      const { result, channel, fetchMock } = await connectedSession(projectMode(DEFAULT_TUNING_CONFIG, 'realtime'));

      settleTurn(channel, 'I scream for ice cream');
      await flushCheck();

      expect(checkCalls(fetchMock)).toHaveLength(0);
      expect(result.current.sourceFlagged).toBe(false);
    });

    it('posts nothing when connect() was given no config, and nothing for an empty turn', async () => {
      const { channel, fetchMock } = await connectedSession();
      settleTurn(channel, 'anything');
      await flushCheck();
      expect(checkCalls(fetchMock)).toHaveLength(0);

      const flagged = await connectedSession(flagConfig());
      settleTurn(flagged.channel, '   ');
      await flushCheck();
      expect(checkCalls(flagged.fetchMock)).toHaveLength(0);
    });

    it('truncates the turn to the server’s 2000-character cap rather than earning a 400', async () => {
      const { channel, fetchMock } = await connectedSession(flagConfig());
      const longTurn = 'a'.repeat(2500);

      settleTurn(channel, longTurn);

      await waitFor(() => expect(checkCalls(fetchMock)).toHaveLength(1));
      const text = String(checkBody(fetchMock).text);
      expect(text).toHaveLength(2000);
      expect(text).toBe(longTurn.slice(0, 2000));
    });

    it('warns and drops the verdict when the check comes back non-2xx, without throwing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, channel } = await connectedSession(flagConfig(), {
        transcriptCheckResponse: { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' },
      });

      settleTurn(channel, 'I scream for ice cream');
      await waitFor(() => expect(warn).toHaveBeenCalled());

      expect(warn.mock.calls[0][0]).toMatch(/transcript check could not run/i);
      expect(result.current.sourceFlagged).toBe(false);
      expect(result.current.status).toBe('connected');
    });

    it('warns and drops the verdict when the request itself fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, channel } = await connectedSession(flagConfig(), {
        transcriptCheckResponse: {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('network down');
          },
          text: async () => '',
        },
      });

      settleTurn(channel, 'I scream for ice cream');
      await waitFor(() => expect(warn).toHaveBeenCalled());

      expect(result.current.sourceFlagged).toBe(false);
      expect(result.current.status).toBe('connected');
    });

    it('AC 4.3: keeps streaming transcripts and measuring latency while a check hangs', async () => {
      const { result, channel } = await connectedSession(flagConfig(), {
        transcriptCheckResponse: {
          ok: true,
          status: 200,
          json: () => new Promise<unknown>(() => {}), // never settles
          text: async () => '',
        },
      });

      settleTurn(channel, 'I scream for ice cream');

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1_000);
      act(() => {
        channel.emitMessage(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
      });
      nowSpy.mockReturnValueOnce(1_250);
      act(() => {
        channel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));
      });

      expect(result.current.targetText).toBe('Hola');
      expect(result.current.endToEndLatencyMs).toBe(250);
      expect(result.current.sourceFlagged).toBe(false);
      nowSpy.mockRestore();
    });

    it('S25: a live apply switching the mode to flag reaches the very next settled turn', async () => {
      const { result, channel, fetchMock } = await connectedSession();

      settleTurn(channel, 'first turn');
      await flushCheck();
      expect(checkCalls(fetchMock)).toHaveLength(0);

      act(() => channel.emitOpen());
      await act(async () => {
        await result.current.applyTuning(flagConfig());
      });

      settleTurn(channel, 'second turn');

      await waitFor(() => expect(checkCalls(fetchMock)).toHaveLength(1));
      expect(checkBody(fetchMock).text).toBe('second turn');
    });

    it('does not badge a session that has been disconnected out from under the check', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let answer: (verdict: unknown) => void = () => {};
      const { result, channel } = await connectedSession(flagConfig(), {
        transcriptCheckResponse: {
          ok: true,
          status: 200,
          json: () =>
            new Promise<unknown>((resolve) => {
              answer = resolve;
            }),
          text: async () => '',
        },
      });

      settleTurn(channel, 'I scream for ice cream');
      act(() => {
        result.current.disconnect();
      });

      await act(async () => {
        answer({ flagged: true, correctedText: null, elapsedMs: 900 });
      });
      expect(result.current.sourceFlagged).toBe(false);
      // Our own abort is not a failure: nothing to warn about.
      expect(warn).not.toHaveBeenCalled();
    });
  });

  /**
   * S24 / story AC 3.5 — the single most likely silent regression in this
   * feature: with a client stage on, the track WebRTC carries is the DSP
   * graph's output, and the mute-during-reply has to target *that* one.
   */
  describe('ticket 12: client DSP graph and the sent track', () => {
    function gateTuning(overrides: Partial<ClientTuning['rmsGate']> = {}): ModeTuningConfig {
      const config = structuredClone(DEFAULT_TUNING_CONFIG);
      config.client.rmsGate = { ...config.client.rmsGate, enabled: true, ...overrides };
      return projectMode(config, 'realtime');
    }

    async function connectWithGate(tuning?: ModeTuningConfig) {
      installFakeAudioApis();
      const mic = createMockMicStream();
      stubMediaDevices(vi.fn().mockResolvedValue(mic.stream));
      stubHappyPathFetch();
      installMockRTCPeerConnection();

      const { result } = renderHook(() => useRealtimeSession());
      act(() => {
        result.current.connect(LANGUAGES, tuning);
      });
      await waitFor(() => expect(result.current.status).toBe('connected'));

      const pc = MockRTCPeerConnection.instances[0];
      const channel = pc.dataChannel;
      if (!channel) throw new Error('expected a data channel to have been created');
      return { result, pc, channel, mic };
    }

    /** The DSP context is the one with a destination node; the other meters levels. */
    function dspContext() {
      return FakeAudioContext.instances.find((context) => context.createdDestinations.length > 0);
    }

    it('S24: sends the destination track, not the raw mic track, when the gate is on', async () => {
      const { pc, mic } = await connectWithGate(gateTuning({ thresholdDbfs: -50 }));

      const context = dspContext();
      const destination = context?.createdDestinations[0];
      expect(destination).toBeDefined();
      expect(pc.addTrack).toHaveBeenCalledWith(destination?.track, destination?.stream);
      expect(pc.addTrack).not.toHaveBeenCalledWith(mic.track, mic.stream);

      // mic -> gate -> destination, with the gate's parameters at construction.
      const gate = FakeAudioWorkletNode.ofType(GATE_WORKLET_NAME);
      expect(gate?.processorOptions).toEqual({
        gate: { ...DEFAULT_TUNING_CONFIG.client.rmsGate, enabled: true, thresholdDbfs: -50 },
      });
      expect(gate?.connect).toHaveBeenCalledWith(destination);
    });

    it('S24: mutes the sent track — not the raw mic track — while the model is replying', async () => {
      const { channel, mic } = await connectWithGate(gateTuning());
      const sentTrack = dspContext()?.createdDestinations[0].track;
      if (!sentTrack) throw new Error('expected a destination track');

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        act(() => {
          channel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));
        });

        expect(sentTrack.enabled).toBe(false);
        // Muting the raw track would silence nothing that is on the wire.
        expect(mic.track.enabled).toBeUndefined();

        act(() => {
          channel.emitMessage(JSON.stringify({ type: 'response.done' }));
          vi.advanceTimersByTime(400); // past REALTIME_MUTE_TAIL_MS
        });

        expect(sentTrack.enabled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the raw track and builds no DSP context at all when no client stage is enabled', async () => {
      const { pc, mic } = await connectWithGate(projectMode(DEFAULT_TUNING_CONFIG, 'realtime'));

      expect(pc.addTrack).toHaveBeenCalledWith(mic.track, mic.stream);
      // Exactly one AudioContext — the level meter's, which is unchanged.
      expect(FakeAudioContext.instances).toHaveLength(1);
      expect(dspContext()).toBeUndefined();
      expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    });

    it('closes the DSP context on disconnect, alongside stopping the mic', async () => {
      const { result, mic } = await connectWithGate(gateTuning());
      const context = dspContext();

      act(() => {
        result.current.disconnect();
      });

      expect(context?.close).toHaveBeenCalled();
      expect(mic.stop).toHaveBeenCalled();
    });

    it('falls back to the raw track, and still connects, when the browser has no AudioContext', async () => {
      // No fake audio APIs installed: jsdom has no Web Audio at all, which is
      // the same shape of failure as a page that has run out of contexts.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mic = createMockMicStream();
      stubMediaDevices(vi.fn().mockResolvedValue(mic.stream));
      stubHappyPathFetch();
      installMockRTCPeerConnection();

      const { result } = renderHook(() => useRealtimeSession());
      act(() => {
        result.current.connect(LANGUAGES, gateTuning());
      });
      await waitFor(() => expect(result.current.status).toBe('connected'));

      expect(MockRTCPeerConnection.instances[0].addTrack).toHaveBeenCalledWith(mic.track, mic.stream);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('client-side audio processing is unavailable'),
        expect.anything(),
      );
      warn.mockRestore();
    });

    it('S23: a live apply posts gateParams to the gate worklet without tearing the session down', async () => {
      const { result, channel, pc } = await connectWithGate(gateTuning({ thresholdDbfs: -50 }));
      act(() => channel.emitOpen());
      const gate = FakeAudioWorkletNode.ofType(GATE_WORKLET_NAME);
      if (!gate) throw new Error('expected a gate worklet node');

      await act(async () => {
        await result.current.applyTuning(gateTuning({ thresholdDbfs: -30 }));
      });

      expect(gate.port.postMessage).toHaveBeenCalledWith({
        type: 'gateParams',
        gate: { ...DEFAULT_TUNING_CONFIG.client.rmsGate, enabled: true, thresholdDbfs: -30 },
      });
      // The gate is ours, so nothing about it goes to OpenAI — but the apply
      // still carries the Realtime knobs, and the session survives it.
      expect(JSON.stringify(sentEvents(channel))).not.toContain('rmsGate');
      expect(result.current.status).toBe('connected');
      expect(pc.close).not.toHaveBeenCalled();
    });

    it('holds a mid-reply gate change until the turn boundary, like every other apply', async () => {
      const { result, channel } = await connectWithGate(gateTuning());
      act(() => channel.emitOpen());
      const gate = FakeAudioWorkletNode.ofType(GATE_WORKLET_NAME);

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        act(() => {
          channel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));
        });
        await act(async () => {
          await result.current.applyTuning(gateTuning({ thresholdDbfs: -30 }));
        });

        expect(gate?.port.postMessage).not.toHaveBeenCalled();

        await act(async () => {
          channel.emitMessage(JSON.stringify({ type: 'response.done' }));
          vi.advanceTimersByTime(400);
        });

        expect(gate?.port.postMessage).toHaveBeenCalledWith({
          type: 'gateParams',
          gate: expect.objectContaining({ thresholdDbfs: -30 }),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    describe('ticket 13: RNNoise in the same graph (AC 3.4)', () => {
      beforeEach(() => {
        loadRnnoiseMock.mockClear();
      });

      function rnnoiseTuning(withGate = false): ModeTuningConfig {
        const config = structuredClone(DEFAULT_TUNING_CONFIG);
        config.client.rnnoise = { ...config.client.rnnoise, enabled: true };
        if (withGate) config.client.rmsGate = { ...config.client.rmsGate, enabled: true };
        return projectMode(config, 'realtime');
      }

      const rnnoiseNode = () => FakeAudioWorkletNode.ofType(RNNOISE_WORKLET_NAME);

      it('builds the DSP graph for RNNoise alone, at 48 kHz, and sends its output track', async () => {
        const { pc, mic } = await connectWithGate(rnnoiseTuning());
        const context = dspContext();
        const destination = context?.createdDestinations[0];

        // Native 48 kHz: no resampling of any kind on the Realtime side, which
        // is the whole reason this context is created at an explicit rate.
        expect(context?.sampleRate).toBe(48000);
        expect(context?.audioWorklet.addModule).toHaveBeenCalledWith(RNNOISE_WORKLET_URL);
        expect(loadRnnoiseMock).toHaveBeenCalledWith(RNNOISE_WASM_URLS);

        // mic -> rnnoise -> destination, and the destination's track is sent.
        expect(context?.createdSources[0].connect).toHaveBeenCalledWith(rnnoiseNode());
        expect(rnnoiseNode()?.connect).toHaveBeenCalledWith(destination);
        expect(pc.addTrack).toHaveBeenCalledWith(destination?.track, destination?.stream);
        expect(pc.addTrack).not.toHaveBeenCalledWith(mic.track, mic.stream);
        // No gate asked for, no gate module fetched.
        expect(context?.audioWorklet.addModule).not.toHaveBeenCalledWith(GATE_WORKLET_URL);
      });

      it('chains gate then RNNoise, in the order the panel lists them', async () => {
        await connectWithGate(rnnoiseTuning(true));
        const context = dspContext();
        const gate = FakeAudioWorkletNode.ofType(GATE_WORKLET_NAME);

        expect(context?.createdSources[0].connect).toHaveBeenCalledWith(gate);
        expect(gate?.connect).toHaveBeenCalledWith(rnnoiseNode());
        expect(rnnoiseNode()?.connect).toHaveBeenCalledWith(context?.createdDestinations[0]);
      });

      it('keeps the gate, and the session, when RNNoise fails to load', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        loadRnnoiseMock.mockRejectedValueOnce(new Error('404'));

        const { result, pc } = await connectWithGate(rnnoiseTuning(true));
        const context = dspContext();
        const destination = context?.createdDestinations[0];

        expect(result.current.status).toBe('connected');
        expect(rnnoiseNode()).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('sending the track without it'), expect.any(Error));
        // The gate still reaches the destination, and that track is still what
        // WebRTC carries — a failed stage is not a failed graph.
        expect(FakeAudioWorkletNode.ofType(GATE_WORKLET_NAME)?.connect).toHaveBeenCalledWith(destination);
        expect(pc.addTrack).toHaveBeenCalledWith(destination?.track, destination?.stream);
        warn.mockRestore();
      });

      it('still builds no context at all when neither client stage is on', async () => {
        await connectWithGate(projectMode(DEFAULT_TUNING_CONFIG, 'realtime'));

        expect(dspContext()).toBeUndefined();
        expect(loadRnnoiseMock).not.toHaveBeenCalled();
      });
    });
  });

  it('disconnect() tears the session down and resets to idle without unmounting', async () => {
    const { stream, stop } = createMockMicStream();
    stubMediaDevices(vi.fn().mockResolvedValue(stream));
    stubHappyPathFetch();
    installMockRTCPeerConnection();

    const { result } = renderHook(() => useRealtimeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const pc = MockRTCPeerConnection.instances[0];

    act(() => {
      result.current.disconnect();
    });

    expect(pc.close).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.micLevel).toBe(0);
  });
});

describe('sessionUpdateEvent', () => {
  /** `session.audio.input` of the event built for `config`. */
  function audioInput(config: ModeTuningConfig): Record<string, unknown> {
    return sessionUpdateEvent(config).session.audio.input as Record<string, unknown>;
  }

  it('carries only session.audio.input, under the required session.type', () => {
    const event = sessionUpdateEvent(tunedRealtimeConfig());

    expect(event.type).toBe('session.update');
    expect(event.session.type).toBe('realtime');
    expect(Object.keys(event.session)).toEqual(['type', 'audio']);
    expect(Object.keys(event.session.audio)).toEqual(['input']);
  });

  it('maps the server_vad knobs to their wire names and omits the ones that were never set', () => {
    const config = realtimeConfigWith((realtime) => {
      realtime.turnDetection.threshold = 0.6;
      realtime.turnDetection.prefixPaddingMs = 300;
      realtime.turnDetection.silenceDurationMs = 500;
      realtime.turnDetection.interruptResponse = false;
    });

    expect(audioInput(config).turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.6,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
      interrupt_response: false,
    });
  });

  it('sends a bare server_vad when no turn-detection knob is set', () => {
    // Absent means "the provider's own default", which is not the same as
    // re-stating that default on the wire.
    expect(audioInput(projectMode(DEFAULT_TUNING_CONFIG, 'realtime')).turn_detection).toEqual({
      type: 'server_vad',
    });
  });

  it('sends eagerness only for semantic_vad, and never the server_vad-only knobs', () => {
    const config = realtimeConfigWith((realtime) => {
      realtime.turnDetection = {
        type: 'semantic_vad',
        eagerness: 'high',
        interruptResponse: true,
        // Left over from a previous server_vad selection: valid on the other
        // type only, so it must not reach OpenAI.
        threshold: 0.6,
      };
    });

    expect(audioInput(config).turn_detection).toEqual({
      type: 'semantic_vad',
      eagerness: 'high',
      interrupt_response: true,
    });
  });

  it('drops eagerness when the type is server_vad', () => {
    const config = realtimeConfigWith((realtime) => {
      realtime.turnDetection = { type: 'server_vad', eagerness: 'low' };
    });

    expect(audioInput(config).turn_detection).toEqual({ type: 'server_vad' });
  });

  it('omits noise_reduction entirely when the panel is on "provider default"', () => {
    expect(audioInput(tunedRealtimeConfig())).not.toHaveProperty('noise_reduction');
  });

  it('sends an explicit null for noise_reduction "off" — the documented way to turn it off', () => {
    const input = audioInput(
      realtimeConfigWith((realtime) => {
        realtime.noiseReduction = 'off';
      }),
    );

    expect(input).toHaveProperty('noise_reduction');
    expect(input.noise_reduction).toBeNull();
    expect(JSON.stringify(input)).toContain('"noise_reduction":null');
  });

  it('sends noise_reduction as {type} for near_field and far_field', () => {
    for (const value of ['near_field', 'far_field'] as const) {
      const input = audioInput(
        realtimeConfigWith((realtime) => {
          realtime.noiseReduction = value;
        }),
      );
      expect(input.noise_reduction).toEqual({ type: value });
    }
  });

  it('never carries model or voice — neither is live-updatable over session.update', () => {
    const config = realtimeConfigWith((realtime) => {
      realtime.model = 'gpt-realtime-mini';
      realtime.voice = 'marin';
    });

    const json = JSON.stringify(sessionUpdateEvent(config));
    expect(json).not.toContain('gpt-realtime-mini');
    expect(json).not.toContain('marin');
    expect(json).not.toContain('"model"');
    expect(json).not.toContain('"voice"');
  });

  it('carries no realtime knobs for a cascade document, since it has none', () => {
    expect(audioInput(projectMode(DEFAULT_TUNING_CONFIG, 'cascade'))).toEqual({});
  });
});
