import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeAudioContext,
  MockRTCPeerConnection,
  createMockMicStream,
  createRealtimeFetchRouter,
  installFakeAudioApis,
  installMockRTCPeerConnection,
  textResponse,
} from '../test/mockRealtimeApis';
import { installManualAnimationFrame } from '../test/mockAudioAnalysis';
import { OPENAI_REALTIME_CALLS_ENDPOINT, REALTIME_SESSION_ENDPOINT } from './realtimeConfig';
import { useRealtimeSession } from './useRealtimeSession';

const LANGUAGES = { sourceLanguage: 'en', targetLanguage: 'es' };

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
