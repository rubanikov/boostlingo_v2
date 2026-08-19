import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockMicStream } from '../test/mockRealtimeApis';
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  installFakeAudioApis,
  installMockGetUserMedia,
  installMockWebSocket,
  MockWebSocket,
} from '../test/mockCascadeApis';
import { installManualAnimationFrame } from '../test/mockAudioAnalysis';
import { loadRnnoiseMock } from '../test/mockRnnoise';
import { CASCADE_PCM_WORKLET_NAME, CASCADE_PCM_WORKLET_URL } from './cascadeConfig';
import { GATE_WORKLET_NAME } from './gateConfig';
import { RNNOISE_WASM_URLS, RNNOISE_WORKLET_NAME, RNNOISE_WORKLET_URL } from './rnnoiseConfig';
import type { ApplyResult } from './sessionHandle';
import { DEFAULT_TUNING_CONFIG, projectMode, type ClientTuning, type ModeTuningConfig } from './tuningConfig';
import { useCascadeSession } from './useCascadeSession';

// jsdom has no AudioWorklet and no wasm to fetch; the package's node class also
// subclasses the real `AudioWorkletNode` at module-evaluation time. See
// `mockRnnoise.ts` for why the package is mocked and not `rnnoiseConfig.ts`.
vi.mock('@sapphi-red/web-noise-suppressor', async () => {
  const { createRnnoiseModuleMock } = await import('../test/mockRnnoise');
  return createRnnoiseModuleMock();
});

const LANGUAGES = { sourceLanguage: 'en', targetLanguage: 'es' };

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('no MockWebSocket instance was created');
  return socket;
}

/** The projected Cascade document the panel would hand `connect`/`applyTuning`. */
function cascadeTuning(endpointingMs = 500): ModeTuningConfig {
  const config = structuredClone(DEFAULT_TUNING_CONFIG);
  config.cascade.deepgram.endpointingMs = endpointingMs;
  return projectMode(config, 'cascade');
}

/** Every JSON frame the client sent, parsed. Binary mic frames are skipped. */
function sentMessages(socket: MockWebSocket): Record<string, unknown>[] {
  return socket.sent
    .filter((entry): entry is string => typeof entry === 'string')
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function sentOfType(socket: MockWebSocket, type: string): Record<string, unknown>[] {
  return sentMessages(socket).filter((message) => message.type === type);
}

describe('useCascadeSession', () => {
  beforeEach(() => {
    installMockWebSocket();
    installFakeAudioApis();
    installMockGetUserMedia(async () => createMockMicStream().stream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('starts idle with no error and a zero mic level', () => {
    const { result } = renderHook(() => useCascadeSession());
    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.micLevel).toBe(0);
  });

  it('sends the connect()-supplied language pair in start_session, not a hardcoded one', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect({ sourceLanguage: 'en', targetLanguage: 'fr' });
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    expect(JSON.parse(latestSocket().sent[0] as string)).toEqual({
      type: 'start_session',
      languages: ['en', 'fr'],
    });
  });

  it('updates micLevel from the analyser data on each animation frame', async () => {
    const rafStub = installManualAnimationFrame();
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const analyser = FakeAudioContext.instances.flatMap((ctx) => ctx.createdAnalysers).at(-1);
    if (!analyser) throw new Error('expected an analyser to have been created');
    analyser.setNextData(new Uint8Array([128, 0])); // loud sample -> level 1

    act(() => rafStub.flush());

    await waitFor(() => expect(result.current.micLevel).toBe(1));
  });

  it('disconnect() tears the session down and resets to idle without unmounting', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = latestSocket();
    act(() => socket.emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => {
      result.current.disconnect();
    });

    expect(socket.close).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.micLevel).toBe(0);
  });

  it('carries a diarized speaker through to sourceSegments/targetSegments, alongside the flat text', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => {
      latestSocket().emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hi', isFinal: true, speaker: 0 }),
      );
      latestSocket().emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's2', text: 'Hola', isFinal: true, speaker: 1 }),
      );
      latestSocket().emitMessage(
        JSON.stringify({ type: 'target_transcript', segmentId: 's1', text: 'Hola', isFinal: true, speaker: 0 }),
      );
    });

    await waitFor(() => expect(result.current.sourceSegments).toEqual([
      { id: 's1', text: 'Hi', speaker: 0 },
      { id: 's2', text: 'Hola', speaker: 1 },
    ]));
    expect(result.current.sourceText).toBe('Hi Hola');
    expect(result.current.targetSegments).toEqual([{ id: 's1', text: 'Hola', speaker: 0 }]);
  });

  it('defaults sourceSegments/targetSegments speaker to null when the server omits the field', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => {
      latestSocket().emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: true }));
    });

    await waitFor(() => expect(result.current.sourceSegments).toEqual([{ id: 's1', text: 'Hello', speaker: null }]));
  });

  it('sends a clock_sync ping immediately after start_session, and schedules a 30s recurring one (ticket 06)', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const sentTypes = latestSocket().sent.map((raw) => (JSON.parse(raw as string) as { type: string }).type);
    expect(sentTypes).toEqual(['start_session', 'clock_sync']);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);

    setIntervalSpy.mockRestore();
  });

  it('the scheduled clock_sync callback sends another ping while still connected', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = latestSocket();
    act(() => socket.emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    // Find our 30s interval specifically — testing-library's own waitFor()
    // polling also goes through setInterval, so the first call isn't
    // necessarily ours.
    const clockSyncCall = setIntervalSpy.mock.calls.find(([, delay]) => delay === 30_000);
    const scheduledCallback = clockSyncCall?.[0] as (() => void) | undefined;
    if (!scheduledCallback) throw new Error('expected a clock_sync interval to have been scheduled');
    act(() => scheduledCallback());

    const sentTypes = socket.sent.map((raw) => (JSON.parse(raw as string) as { type: string }).type);
    expect(sentTypes).toEqual(['start_session', 'clock_sync', 'clock_sync']);

    setIntervalSpy.mockRestore();
  });

  it('clears the clock_sync interval on disconnect()', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    // Find our 30s interval specifically — testing-library's own waitFor()
    // polling also goes through setInterval, so the first call isn't
    // necessarily ours.
    const clockSyncCallIndex = setIntervalSpy.mock.calls.findIndex(([, delay]) => delay === 30_000);
    if (clockSyncCallIndex === -1) throw new Error('expected a clock_sync interval to have been scheduled');
    const intervalId = setIntervalSpy.mock.results[clockSyncCallIndex]?.value;

    act(() => {
      result.current.disconnect();
    });

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('starts with cascadeLatency null, and null again once connected before any segment completes', async () => {
    const { result } = renderHook(() => useCascadeSession());
    expect(result.current.cascadeLatency).toBeNull();

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    expect(result.current.cascadeLatency).toBeNull();
  });

  it('accumulates incoming latency messages and only surfaces cascadeLatency once playback_start arrives for that segment', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => {
      latestSocket().emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'speech_end', ms: 0 }));
      latestSocket().emitMessage(
        JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'translation_first_token', ms: 150 }),
      );
    });
    // Still building — not "completed" until playback_start lands.
    expect(result.current.cascadeLatency).toBeNull();

    act(() => {
      latestSocket().emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'playback_start', ms: 650 }));
    });

    await waitFor(() =>
      expect(result.current.cascadeLatency).toEqual({
        segmentId: 's1',
        stages: { speech_end: 0, translation_first_token: 150, playback_start: 650 },
      }),
    );
  });

  it('switches cascadeLatency to whichever segment most recently completed', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => {
      latestSocket().emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'playback_start', ms: 650 }));
    });
    await waitFor(() => expect(result.current.cascadeLatency?.segmentId).toBe('s1'));

    act(() => {
      latestSocket().emitMessage(JSON.stringify({ type: 'latency', segmentId: 's2', stage: 'playback_start', ms: 500 }));
    });
    await waitFor(() =>
      expect(result.current.cascadeLatency).toEqual({ segmentId: 's2', stages: { playback_start: 500 } }),
    );
  });

  it('ignores clock_sync_ack messages without throwing or altering state', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    expect(() => {
      act(() => {
        latestSocket().emitMessage(JSON.stringify({ type: 'clock_sync_ack', clientTime: 1000, serverTime: 1005 }));
      });
    }).not.toThrow();
    expect(result.current.status).toBe('connected');
  });

  it('sends playback_started with the segment id the moment its TTS audio is scheduled to play', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = latestSocket();
    act(() => socket.emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => {
      socket.emitMessage(JSON.stringify({ type: 'tts_audio_meta', segmentId: 's1', sampleRate: 16000 }));
      socket.emitMessage(new ArrayBuffer(4)); // two int16 samples
    });

    await waitFor(() => {
      const playbackStarted = socket.sent
        .map((raw) => JSON.parse(raw as string) as { type: string; segmentId?: string; clientTime?: number })
        .find((message) => message.type === 'playback_started');
      expect(playbackStarted).toMatchObject({ type: 'playback_started', segmentId: 's1' });
      expect(typeof playbackStarted?.clientTime).toBe('number');
    });
  });

  it('withholds mic frames from the backend while TTS audio is playing, then resumes once it finishes', async () => {
    // Regression test for a real feedback loop found via manual testing: an
    // unmuted mic transcribed the app's own translated reply off the
    // speakers and re-translated it, looping indefinitely.
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = latestSocket();
    act(() => socket.emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const captureWorklet = FakeAudioWorkletNode.instances[0];
    if (!captureWorklet) throw new Error('expected a capture AudioWorkletNode to have been created');
    const emitMicFrame = () => {
      captureWorklet.port.onmessage?.({ data: new ArrayBuffer(4) } as MessageEvent<ArrayBuffer>);
    };
    const forwardedFrameCount = () => socket.sent.filter((entry) => entry instanceof ArrayBuffer).length;

    act(emitMicFrame);
    expect(forwardedFrameCount()).toBe(1); // baseline: forwarded before any TTS plays

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      act(() => {
        socket.emitMessage(JSON.stringify({ type: 'tts_audio_meta', segmentId: 's1', sampleRate: 16000 }));
        socket.emitMessage(new ArrayBuffer(4)); // two int16 samples -> 0.125ms of "audio"
      });

      act(emitMicFrame);
      expect(forwardedFrameCount()).toBe(1); // still muted: no new frame forwarded

      // PLAYBACK_MUTE_TAIL_MS (200ms) comfortably covers this segment's ~0.125ms
      // of queued audio; advancing past it should lift the mute.
      act(() => {
        vi.advanceTimersByTime(250);
      });

      act(emitMicFrame);
      expect(forwardedFrameCount()).toBe(2); // unmuted again
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears prior transcript text on a fresh connect()', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => {
      latestSocket().emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: true }));
    });
    await waitFor(() => expect(result.current.sourceText).toBe('Hello'));

    act(() => {
      result.current.disconnect();
    });
    act(() => {
      result.current.connect(LANGUAGES);
    });

    expect(result.current.sourceText).toBe('');
  });

  it('clears prior cascadeLatency on a fresh connect()', async () => {
    const { result } = renderHook(() => useCascadeSession());

    act(() => {
      result.current.connect(LANGUAGES);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => latestSocket().emitOpen());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => {
      latestSocket().emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'playback_start', ms: 650 }));
    });
    await waitFor(() => expect(result.current.cascadeLatency?.segmentId).toBe('s1'));

    act(() => {
      result.current.disconnect();
    });
    act(() => {
      result.current.connect(LANGUAGES);
    });

    expect(result.current.cascadeLatency).toBeNull();
  });

  describe('ticket 05: LLM-hybrid segmentation mode toggle & trigger surfacing', () => {
    it('omits segmentationMode from start_session when the URL has no ?segMode param', async () => {
      const { result } = renderHook(() => useCascadeSession());

      act(() => {
        result.current.connect(LANGUAGES);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      act(() => latestSocket().emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));

      expect(JSON.parse(latestSocket().sent[0] as string)).toEqual({
        type: 'start_session',
        languages: ['en', 'es'],
      });
    });

    it('omits segmentationMode when ?segMode is set to something other than "llm_priority"', async () => {
      window.history.pushState({}, '', '/?segMode=hybrid');
      const { result } = renderHook(() => useCascadeSession());

      act(() => {
        result.current.connect(LANGUAGES);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      act(() => latestSocket().emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));

      expect(JSON.parse(latestSocket().sent[0] as string)).toEqual({
        type: 'start_session',
        languages: ['en', 'es'],
      });
    });

    it('includes segmentationMode: "llm_priority" in start_session when ?segMode=llm_priority is in the URL', async () => {
      window.history.pushState({}, '', '/?segMode=llm_priority');
      const { result } = renderHook(() => useCascadeSession());

      act(() => {
        result.current.connect(LANGUAGES);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      act(() => latestSocket().emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));

      expect(JSON.parse(latestSocket().sent[0] as string)).toEqual({
        type: 'start_session',
        languages: ['en', 'es'],
        segmentationMode: 'llm_priority',
      });
    });

    it('starts with an empty segmentTriggers map', () => {
      const { result } = renderHook(() => useCascadeSession());
      expect(result.current.segmentTriggers).toEqual({});
    });

    it('records a short label per segmentId from segment_boundary, keeping every trigger value it sees rather than filtering to one', async () => {
      const { result } = renderHook(() => useCascadeSession());

      act(() => {
        result.current.connect(LANGUAGES);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      act(() => latestSocket().emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));

      act(() => {
        latestSocket().emitMessage(JSON.stringify({ type: 'segment_boundary', segmentId: 's1', trigger: 'llm' }));
        latestSocket().emitMessage(
          JSON.stringify({ type: 'segment_boundary', segmentId: 's2', trigger: 'deepgram_speech_final' }),
        );
        latestSocket().emitMessage(
          JSON.stringify({ type: 'segment_boundary', segmentId: 's3', trigger: 'deepgram_utterance_end' }),
        );
        // An unrecognized trigger value (e.g. a future backend addition) is
        // still recorded, not silently dropped.
        latestSocket().emitMessage(
          JSON.stringify({ type: 'segment_boundary', segmentId: 's4', trigger: 'something_new' }),
        );
      });

      await waitFor(() =>
        expect(result.current.segmentTriggers).toEqual({
          s1: 'llm',
          s2: 'pause',
          s3: 'pause',
          s4: 'something_new',
        }),
      );
    });

    it('clears prior segmentTriggers on a fresh connect()', async () => {
      const { result } = renderHook(() => useCascadeSession());

      act(() => {
        result.current.connect(LANGUAGES);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      act(() => latestSocket().emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));

      act(() => {
        latestSocket().emitMessage(JSON.stringify({ type: 'segment_boundary', segmentId: 's1', trigger: 'llm' }));
      });
      await waitFor(() => expect(result.current.segmentTriggers).toEqual({ s1: 'llm' }));

      act(() => {
        result.current.disconnect();
      });
      act(() => {
        result.current.connect(LANGUAGES);
      });

      expect(result.current.segmentTriggers).toEqual({});
    });
  });

  describe('ticket 06: start-of-session tuning & live apply', () => {
    async function connectAndOpen(
      result: { current: ReturnType<typeof useCascadeSession> },
      tuning?: ModeTuningConfig,
    ) {
      act(() => {
        result.current.connect(LANGUAGES, tuning);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = latestSocket();
      act(() => socket.emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));
      return socket;
    }

    it('carries the tuning document inside start_session, as the first message on the socket (AC 1.4)', async () => {
      const tuning = cascadeTuning(300);
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, tuning);

      expect(JSON.parse(socket.sent[0] as string)).toEqual({
        type: 'start_session',
        languages: ['en', 'es'],
        tuning,
      });
    });

    it('omits tuning entirely when connect() is called without one', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);

      expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'start_session', languages: ['en', 'es'] });
    });

    it('still honours the legacy ?segMode override when no tuning is supplied', async () => {
      window.history.pushState({}, '', '/?segMode=llm_priority');
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);

      expect(JSON.parse(socket.sent[0] as string)).toEqual({
        type: 'start_session',
        languages: ['en', 'es'],
        segmentationMode: 'llm_priority',
      });
    });

    it('lets tuning win over the ?segMode override rather than sending both', async () => {
      window.history.pushState({}, '', '/?segMode=llm_priority');
      const tuning = cascadeTuning();
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, tuning);

      const startSession = JSON.parse(socket.sent[0] as string) as Record<string, unknown>;
      expect(startSession.tuning).toEqual(tuning);
      expect(startSession).not.toHaveProperty('segmentationMode');
    });

    it('takes the start-of-session fingerprint from the unsolicited tuning_applied the server sends after session_started', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning());
      expect(result.current.appliedFingerprint).toBeNull();

      act(() => {
        socket.emitMessage(JSON.stringify({ type: 'session_started', sessionId: 'sess-1' }));
        socket.emitMessage(
          JSON.stringify({ type: 'tuning_applied', requestId: null, fingerprint: 'cfg:7f3a9c21', reconnectedStt: false }),
        );
      });

      await waitFor(() => expect(result.current.appliedFingerprint).toBe('cfg:7f3a9c21'));
    });

    it('applyTuning sends one update_tuning with a requestId and resolves when that request is applied (AC 1.6)', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning());
      const next = cascadeTuning(300);

      let settled: unknown;
      act(() => {
        void result.current.applyTuning(next).then((value) => {
          settled = value;
        });
      });

      const [update] = sentOfType(socket, 'update_tuning');
      expect(update).toEqual({ type: 'update_tuning', requestId: expect.any(String), tuning: next });

      act(() => {
        socket.emitMessage(
          JSON.stringify({
            type: 'tuning_applied',
            requestId: update.requestId,
            fingerprint: 'cfg:1234abcd',
            reconnectedStt: false,
          }),
        );
      });

      await waitFor(() =>
        expect(settled).toEqual({ ok: true, fingerprint: 'cfg:1234abcd', reconnectedStt: false, deferred: false }),
      );
      expect(result.current.appliedFingerprint).toBe('cfg:1234abcd');
    });

    it('reports reconnectedStt back to the panel when the server had to reopen the STT connection', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning());

      let settled: { reconnectedStt?: boolean } | undefined;
      act(() => {
        void result.current.applyTuning(cascadeTuning(300)).then((value) => {
          settled = value as { reconnectedStt?: boolean };
        });
      });
      const [update] = sentOfType(socket, 'update_tuning');
      act(() => {
        socket.emitMessage(
          JSON.stringify({
            type: 'tuning_applied',
            requestId: update.requestId,
            fingerprint: 'cfg:1234abcd',
            reconnectedStt: true,
          }),
        );
      });

      await waitFor(() => expect(settled?.reconnectedStt).toBe(true));
    });

    it('logs every tuning_failed attempt, and only answers the apply once the retry budget is spent', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { result } = renderHook(() => useCascadeSession());
        const socket = await connectAndOpen(result, cascadeTuning());

        let settled: unknown;
        act(() => {
          void result.current.applyTuning(cascadeTuning(300)).then((value) => {
            settled = value;
          });
        });
        const [update] = sentOfType(socket, 'update_tuning');
        const failure = (attempt: number) =>
          JSON.stringify({
            type: 'tuning_failed',
            requestId: update.requestId,
            attempt,
            maxAttempts: 3,
            message: 'The connection to the provider was lost.',
          });

        // Attempts 1 and 2: logged, but the server is still retrying, so the
        // panel must stay on "Reconnecting STT with the new parameters…".
        act(() => {
          socket.emitMessage(failure(1));
          socket.emitMessage(failure(2));
        });
        await waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
        expect(settled).toBeUndefined();

        act(() => {
          socket.emitMessage(failure(3));
        });

        await waitFor(() =>
          expect(settled).toEqual({
            ok: false,
            fingerprint: expect.stringMatching(/^cfg:[0-9a-f]{8}$/),
            attempt: 3,
            maxAttempts: 3,
            message: 'The connection to the provider was lost.',
          }),
        );
        expect(warn).toHaveBeenCalledTimes(3);
      } finally {
        warn.mockRestore();
      }
    });

    it('defers an apply made while disconnected instead of sending it', async () => {
      const { result } = renderHook(() => useCascadeSession());

      const settled = await result.current.applyTuning(cascadeTuning(300));

      expect(settled).toEqual({
        ok: true,
        fingerprint: expect.stringMatching(/^cfg:[0-9a-f]{8}$/),
        reconnectedStt: false,
        deferred: true,
      });
      expect(MockWebSocket.instances).toHaveLength(0);
    });

    it('E1 — holds an apply made during TTS playback, coalesces a second one into it, and sends exactly one update_tuning when playback clears', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning());

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        act(() => {
          socket.emitMessage(JSON.stringify({ type: 'tts_audio_meta', segmentId: 's1', sampleRate: 16000 }));
          socket.emitMessage(new ArrayBuffer(4)); // playback is now active
        });

        const first = cascadeTuning(300);
        const second = cascadeTuning(800);
        let firstResult: unknown;
        let secondResult: unknown;
        await act(async () => {
          firstResult = await result.current.applyTuning(first);
          secondResult = await result.current.applyTuning(second);
        });

        // Nothing on the wire while our own reply is still audible.
        expect(sentOfType(socket, 'update_tuning')).toHaveLength(0);

        act(() => {
          vi.advanceTimersByTime(250); // past PLAYBACK_MUTE_TAIL_MS
        });

        // One message, carrying the *later* config: the two Applies coalesced
        // in the single pending slot rather than opening two reconnects.
        const updates = sentOfType(socket, 'update_tuning');
        expect(updates).toHaveLength(1);
        expect(updates[0].tuning).toEqual(second);

        expect(firstResult).toMatchObject({ ok: true, deferred: true });
        expect(secondResult).toMatchObject({ ok: true, deferred: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a deferred apply queued when the mute lifts while the socket is down, and sends it at the next flush', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning());

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        act(() => {
          socket.emitMessage(JSON.stringify({ type: 'tts_audio_meta', segmentId: 's1', sampleRate: 16000 }));
          socket.emitMessage(new ArrayBuffer(4)); // playback is now active
        });

        const config = cascadeTuning(300);
        await act(async () => {
          await result.current.applyTuning(config);
        });
        expect(sentOfType(socket, 'update_tuning')).toHaveLength(0);

        // The reply finishes playing while the socket is not open (a drop, or
        // the gap before a reconnect resumes). Nothing can be sent — but the
        // slot must survive rather than be cleared on the way past.
        socket.readyState = MockWebSocket.CLOSED;
        act(() => {
          vi.advanceTimersByTime(250); // past PLAYBACK_MUTE_TAIL_MS
        });
        expect(sentOfType(socket, 'update_tuning')).toHaveLength(0);

        // Next turn boundary with the socket back: the config is still queued,
        // and goes out exactly once.
        socket.readyState = MockWebSocket.OPEN;
        act(() => {
          socket.emitMessage(JSON.stringify({ type: 'tts_audio_meta', segmentId: 's2', sampleRate: 16000 }));
          socket.emitMessage(new ArrayBuffer(4));
        });
        act(() => {
          vi.advanceTimersByTime(250);
        });

        const updates = sentOfType(socket, 'update_tuning');
        expect(updates).toHaveLength(1);
        expect(updates[0].tuning).toEqual(config);
      } finally {
        vi.useRealTimers();
      }
    });

    it('E16 — warns and ignores a server message type it does not know', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { result } = renderHook(() => useCascadeSession());
        const socket = await connectAndOpen(result, cascadeTuning());

        act(() => {
          socket.emitMessage(JSON.stringify({ type: 'tuning_partially_applied', requestId: 'a1b2c3d4' }));
        });

        expect(warn).toHaveBeenCalledWith(
          'Cascade: received an unrecognized message type "tuning_partially_applied".',
        );
        expect(result.current.status).toBe('connected');
        expect(result.current.errorMessage).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });
  });

  /**
   * The client half of the deliberate Deepgram reconnect. The server reopens
   * the STT socket behind a running session; from here that is visible as the
   * existing amber `reconnecting` badge, a per-attempt progress readout, and a
   * single answer once the retry budget is spent.
   */
  describe('ticket 07: connection-level apply, reconnect progress', () => {
    async function connectAndOpen(
      result: { current: ReturnType<typeof useCascadeSession> },
      tuning?: ModeTuningConfig,
    ) {
      act(() => {
        result.current.connect(LANGUAGES, tuning ?? cascadeTuning());
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = latestSocket();
      act(() => socket.emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));
      return socket;
    }

    /** Starts an apply and hands back its requestId plus the settled result. */
    function startApply(
      result: { current: ReturnType<typeof useCascadeSession> },
      socket: MockWebSocket,
      config: ModeTuningConfig,
    ) {
      const settled: { value?: ApplyResult } = {};
      act(() => {
        void result.current.applyTuning(config).then((value) => {
          settled.value = value;
        });
      });
      const update = sentOfType(socket, 'update_tuning').at(-1);
      if (!update) throw new Error('expected an update_tuning on the wire');
      return { requestId: update.requestId as string, settled };
    }

    /** A document that differs only in a knob the server applies without reopening anything. */
    function segmentationTuning(): ModeTuningConfig {
      const config = structuredClone(DEFAULT_TUNING_CONFIG);
      config.cascade.segmentation.mode = 'llm_priority';
      return projectMode(config, 'cascade');
    }

    function failure(requestId: string, attempt: number, maxAttempts = 3) {
      return JSON.stringify({
        type: 'tuning_failed',
        requestId,
        attempt,
        maxAttempts,
        message: 'The connection to the provider was lost.',
      });
    }

    it('shows the reconnecting status for a connection-level apply and returns to connected once it lands', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning(500));

      // endpointingMs is one of DEEPGRAM_CONNECTION_LEVEL_PATHS, so the server
      // can only apply this by reopening the Deepgram socket.
      const { requestId, settled } = startApply(result, socket, cascadeTuning(300));
      expect(result.current.status).toBe('reconnecting');

      act(() => {
        socket.emitMessage(
          JSON.stringify({ type: 'tuning_applied', requestId, fingerprint: 'cfg:1234abcd', reconnectedStt: true }),
        );
      });

      await waitFor(() => expect(result.current.status).toBe('connected'));
      expect(settled.value).toEqual({
        ok: true,
        fingerprint: 'cfg:1234abcd',
        reconnectedStt: true,
        deferred: false,
      });
      // Nothing left to report: the apply landed.
      expect(result.current.applyProgress).toBeNull();
    });

    it('leaves the badge alone for an apply the server can make without reopening anything', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning());

      startApply(result, socket, segmentationTuning());

      expect(result.current.status).toBe('connected');
    });

    it('never times out a reconnect: the reply waits on the next thing the user says', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning(500));

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { requestId, settled } = startApply(result, socket, cascadeTuning(300));

        // Apply pressed into silence. The server only sends tuning_applied on
        // the first result from the *new* Deepgram socket, so nothing comes
        // back until somebody speaks — long past any reply timeout.
        await act(async () => {
          vi.advanceTimersByTime(120_000);
        });

        expect(settled.value).toBeUndefined();
        expect(result.current.status).toBe('reconnecting');
        expect(result.current.applyProgress).toEqual({ attempt: 1, maxAttempts: 3, failures: [] });

        // …and when the user finally does speak, it lands.
        await act(async () => {
          socket.emitMessage(
            JSON.stringify({ type: 'tuning_applied', requestId, fingerprint: 'cfg:1234abcd', reconnectedStt: true }),
          );
        });

        expect(settled.value).toMatchObject({ ok: true, reconnectedStt: true });
        expect(result.current.status).toBe('connected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('still times out an ordinary apply, which the server answers straight away or not at all', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning());

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { settled } = startApply(result, socket, segmentationTuning());

        await act(async () => {
          vi.advanceTimersByTime(20_000);
        });

        expect(settled.value).toEqual({
          ok: false,
          fingerprint: expect.stringMatching(/^cfg:[0-9a-f]{8}$/),
          attempt: 3,
          maxAttempts: 3,
          message: 'No reply from the server.',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('answers an apply that rode along behind a parked reconnect with the reconnect\'s own reply', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning(500));

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const reconnect = startApply(result, socket, cascadeTuning(300));
        // Sent while the reconnect is parked: the server folds it into the same
        // `pending` slot, so it never gets a reply of its own — and must not be
        // timed out waiting for one.
        const rider = startApply(result, socket, segmentationTuning());

        await act(async () => {
          vi.advanceTimersByTime(120_000);
        });
        expect(rider.settled.value).toBeUndefined();

        await act(async () => {
          socket.emitMessage(
            JSON.stringify({
              type: 'tuning_applied',
              requestId: reconnect.requestId,
              fingerprint: 'cfg:1234abcd',
              reconnectedStt: true,
            }),
          );
        });

        expect(reconnect.settled.value).toMatchObject({ ok: true, fingerprint: 'cfg:1234abcd' });
        expect(rider.settled.value).toMatchObject({ ok: true, fingerprint: 'cfg:1234abcd' });
        expect(result.current.status).toBe('connected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('answers both when the server echoes the *rider\'s* requestId rather than the reconnect\'s', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, cascadeTuning(500));

      const reconnect = startApply(result, socket, cascadeTuning(300));
      const rider = startApply(result, socket, segmentationTuning());
      expect(rider.requestId).not.toBe(reconnect.requestId);
      expect(result.current.status).toBe('reconnecting');

      // `_handle_update_tuning` overwrites `tuning.request_id` along with the
      // pending config, so the one reply carries whichever id arrived last.
      await act(async () => {
        socket.emitMessage(
          JSON.stringify({
            type: 'tuning_applied',
            requestId: rider.requestId,
            fingerprint: 'cfg:1234abcd',
            reconnectedStt: true,
          }),
        );
      });

      expect(reconnect.settled.value).toMatchObject({ ok: true, fingerprint: 'cfg:1234abcd' });
      expect(rider.settled.value).toMatchObject({ ok: true, fingerprint: 'cfg:1234abcd' });
      expect(result.current.status).toBe('connected');
      expect(result.current.applyProgress).toBeNull();

      // The rider was the newest document, so it — not the reconnect's — is
      // what the next apply's connection-level diff is measured against: this
      // one changes no Deepgram field, so no second reconnect is claimed.
      startApply(result, socket, segmentationTuning());
      expect(result.current.status).toBe('connected');
    });

    it('surfaces each failed attempt as progress the status line can read, warning on every one', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { result } = renderHook(() => useCascadeSession());
        const socket = await connectAndOpen(result, cascadeTuning(500));
        const { requestId, settled } = startApply(result, socket, cascadeTuning(300));

        expect(result.current.applyProgress).toEqual({ attempt: 1, maxAttempts: 3, failures: [] });

        act(() => socket.emitMessage(failure(requestId, 1)));

        // Attempt 1 failed, so the server is on attempt 2 — which is what the
        // panel's "(attempt 2 of 3)" has to say while the retry is running.
        await waitFor(() => expect(result.current.applyProgress?.attempt).toBe(2));
        expect(result.current.applyProgress?.failures).toEqual([
          { attempt: 1, message: 'The connection to the provider was lost.', at: expect.any(Date) },
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(settled.value).toBeUndefined();
        expect(result.current.status).toBe('reconnecting');

        act(() => socket.emitMessage(failure(requestId, 2)));
        await waitFor(() => expect(result.current.applyProgress?.attempt).toBe(3));

        act(() => socket.emitMessage(failure(requestId, 3)));

        await waitFor(() =>
          expect(settled.value).toEqual({
            ok: false,
            fingerprint: expect.stringMatching(/^cfg:[0-9a-f]{8}$/),
            attempt: 3,
            maxAttempts: 3,
            message: 'The connection to the provider was lost.',
          }),
        );
        expect(warn).toHaveBeenCalledTimes(3);
        // The session survives an exhausted reconnect: the server reverted to
        // the previous params rather than ending it.
        expect(result.current.status).toBe('connected');
        expect(result.current.errorMessage).toBeNull();
        // The attempt log outlives the failure — it is what the dialog shows.
        expect(result.current.applyProgress?.failures.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
        // "attempt 4 of 3" is not a thing to render, even for an instant.
        expect(result.current.applyProgress?.attempt).toBe(3);
      } finally {
        warn.mockRestore();
      }
    });

    it('starts a second apply from a clean slate rather than appending to the last failure log', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { result } = renderHook(() => useCascadeSession());
        const socket = await connectAndOpen(result, cascadeTuning(500));
        const first = startApply(result, socket, cascadeTuning(300));
        act(() => socket.emitMessage(failure(first.requestId, 3)));
        await waitFor(() => expect(result.current.applyProgress?.failures).toHaveLength(1));

        startApply(result, socket, cascadeTuning(200));

        expect(result.current.applyProgress).toEqual({ attempt: 1, maxAttempts: 3, failures: [] });
      } finally {
        warn.mockRestore();
      }
    });

    it('ignores a tuning_failed for a request that is no longer in flight, but still logs it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { result } = renderHook(() => useCascadeSession());
        const socket = await connectAndOpen(result, cascadeTuning());

        act(() => socket.emitMessage(failure('never-sent', 1)));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(result.current.applyProgress).toBeNull();
        expect(result.current.status).toBe('connected');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('ticket 07: error handling & session resilience', () => {
    async function connectAndOpen(result: { current: ReturnType<typeof useCascadeSession> }) {
      act(() => {
        result.current.connect(LANGUAGES);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = latestSocket();
      act(() => socket.emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));
      return socket;
    }

    it('routes a retryable provider error to a toast, carrying the server message, without ending the session', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);

      act(() => {
        socket.emitMessage(
          JSON.stringify({ type: 'error', provider: 'stt', kind: 'rate_limit', message: 'Deepgram rate limited', retryable: true }),
        );
      });

      await waitFor(() => expect(result.current.cascadeToasts).toEqual([{ id: 'toast-0', message: 'Deepgram rate limited' }]));
      expect(result.current.status).toBe('connected');
      expect(result.current.errorMessage).toBeNull();
    });

    it('auto-dismisses a toast on its own timer without user interaction', async () => {
      // waitFor()'s own polling needs real timers, so connect (which uses
      // waitFor internally) happens before switching to fake ones — only the
      // toast's own dismiss timer needs to be under our control here.
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        act(() => {
          socket.emitMessage(
            JSON.stringify({ type: 'error', provider: 'tts', kind: 'timeout', message: 'ElevenLabs timed out', retryable: true }),
          );
        });
        expect(result.current.cascadeToasts).toEqual([{ id: 'toast-0', message: 'ElevenLabs timed out' }]);

        act(() => {
          vi.advanceTimersByTime(5_000);
        });

        expect(result.current.cascadeToasts).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('routes a circuit_open error to the blocking terminal state, headlined "Interpretation unavailable", and tears the session down', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);

      act(() => {
        socket.emitMessage(
          JSON.stringify({
            type: 'error',
            provider: 'orchestrator',
            kind: 'circuit_open',
            message: '5 consecutive segment failures',
            retryable: false,
          }),
        );
      });

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.errorMessage).toBe('Interpretation unavailable — 5 consecutive segment failures');
      expect(socket.close).toHaveBeenCalled();
    });

    it('stores the sessionId from session_started, and attempts exactly one resume when the socket drops unexpectedly', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);

      act(() => {
        socket.emitMessage(JSON.stringify({ type: 'session_started', sessionId: 'sess-42' }));
      });

      act(() => {
        socket.emitClose(); // unexpected — not our own disconnect()
      });

      await waitFor(() => expect(result.current.status).toBe('reconnecting'));
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));

      const resumeSocket = MockWebSocket.instances[1];
      act(() => resumeSocket.emitOpen());

      await waitFor(() => expect(resumeSocket.sent).toHaveLength(1));
      expect(JSON.parse(resumeSocket.sent[0] as string)).toEqual({ type: 'resume_session', sessionId: 'sess-42' });
    });

    it('a successful resume (any non-error reply) flips status back to connected and keeps streaming normally', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);
      act(() => socket.emitMessage(JSON.stringify({ type: 'session_started', sessionId: 'sess-1' })));
      act(() => socket.emitClose());
      await waitFor(() => expect(result.current.status).toBe('reconnecting'));

      const resumeSocket = MockWebSocket.instances[1];
      act(() => resumeSocket.emitOpen());
      act(() => {
        resumeSocket.emitMessage(
          JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: true }),
        );
      });

      await waitFor(() => expect(result.current.status).toBe('connected'));
      expect(result.current.sourceText).toBe('Hello');

      // The resumed socket is now the live transport for further messages too.
      act(() => {
        resumeSocket.emitMessage(
          JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello world', isFinal: true }),
        );
      });
      await waitFor(() => expect(result.current.sourceText).toBe('Hello world'));
    });

    it('a not_found reply to resume_session gives up: terminal "Session ended" state, no further resume attempts', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);
      act(() => socket.emitMessage(JSON.stringify({ type: 'session_started', sessionId: 'sess-1' })));
      act(() => socket.emitClose());
      await waitFor(() => expect(result.current.status).toBe('reconnecting'));

      const resumeSocket = MockWebSocket.instances[1];
      act(() => resumeSocket.emitOpen());
      act(() => {
        resumeSocket.emitMessage(
          JSON.stringify({ type: 'error', provider: 'session', kind: 'not_found', message: 'Unknown session', retryable: false }),
        );
      });

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.errorMessage).toBe('Session ended — Unknown session');
      expect(MockWebSocket.instances).toHaveLength(2); // no third (retry) socket was ever opened
    });

    it('gives up immediately, without opening a second socket, when the drop happens before session_started ever arrived', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);
      // No session_started emitted this time.

      act(() => socket.emitClose());

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.errorMessage).toBe('Session ended. Start a new session to continue.');
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('gives up rather than looping when the resumed connection itself drops again', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);
      act(() => socket.emitMessage(JSON.stringify({ type: 'session_started', sessionId: 'sess-1' })));
      act(() => socket.emitClose());
      await waitFor(() => expect(result.current.status).toBe('reconnecting'));

      const resumeSocket = MockWebSocket.instances[1];
      act(() => resumeSocket.emitOpen());
      act(() => resumeSocket.emitMessage(JSON.stringify({ type: 'clock_sync_ack', clientTime: 0, serverTime: 0 })));
      await waitFor(() => expect(result.current.status).toBe('connected'));

      // Drops a second time after a successful resume.
      act(() => resumeSocket.emitClose());

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.errorMessage).toBe('Session ended. Start a new session to continue.');
      expect(MockWebSocket.instances).toHaveLength(2); // still no third socket — one resume attempt, ever
    });

    it('an intentional disconnect() never attempts a resume, even mid-teardown', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result);
      act(() => socket.emitMessage(JSON.stringify({ type: 'session_started', sessionId: 'sess-1' })));

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.status).toBe('idle');
      expect(MockWebSocket.instances).toHaveLength(1); // no resume socket opened
    });
  });

  /**
   * S21 / story AC 3.1. The three browser constraints are `getUserMedia`-time,
   * so the only place they are observable is the call itself — which is also
   * why the panel says they take effect on the next connect.
   */
  describe('ticket 11: microphone constraints', () => {
    function micTuning(microphone: ClientTuning['microphone']): ModeTuningConfig {
      const config = structuredClone(DEFAULT_TUNING_CONFIG);
      config.client.microphone = microphone;
      return projectMode(config, 'cascade');
    }

    it('asks getUserMedia for exactly the constraints the panel set, not hardcoded trues (S21)', async () => {
      const getUserMedia = installMockGetUserMedia(async () => createMockMicStream().stream);
      const { result } = renderHook(() => useCascadeSession());

      act(() => {
        result.current.connect(
          LANGUAGES,
          micTuning({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
        );
      });

      await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    });

    it('carries each constraint independently rather than one flag for all three', async () => {
      const getUserMedia = installMockGetUserMedia(async () => createMockMicStream().stream);
      const { result } = renderHook(() => useCascadeSession());

      act(() => {
        result.current.connect(
          LANGUAGES,
          micTuning({ echoCancellation: false, noiseSuppression: true, autoGainControl: false }),
        );
      });

      await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
    });

    it('keeps the pre-tuning all-on constraints when connect() is given no config', async () => {
      const getUserMedia = installMockGetUserMedia(async () => createMockMicStream().stream);
      const { result } = renderHook(() => useCascadeSession());

      act(() => {
        result.current.connect(LANGUAGES);
      });

      await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    });
  });

  describe('ticket 12: RMS gate in the capture graph (S23)', () => {
    function gateTuning(overrides: Partial<ClientTuning['rmsGate']> = {}): ModeTuningConfig {
      const config = structuredClone(DEFAULT_TUNING_CONFIG);
      config.client.rmsGate = { ...config.client.rmsGate, enabled: true, ...overrides };
      return projectMode(config, 'cascade');
    }

    async function connectAndOpen(
      result: { current: ReturnType<typeof useCascadeSession> },
      tuning?: ModeTuningConfig,
    ) {
      act(() => {
        result.current.connect(LANGUAGES, tuning);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = latestSocket();
      act(() => socket.emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));
      return socket;
    }

    function gateNode() {
      return FakeAudioWorkletNode.ofType(GATE_WORKLET_NAME);
    }

    it('inserts the gate between the mic and the capture worklet, carrying its parameters at construction', async () => {
      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, gateTuning({ thresholdDbfs: -50 }));

      const gate = gateNode();
      expect(gate).toBeDefined();
      expect(gate?.processorOptions).toEqual({
        gate: { ...DEFAULT_TUNING_CONFIG.client.rmsGate, enabled: true, thresholdDbfs: -50 },
      });
      // Feeding the capture worklet, which is what reaches the socket.
      expect(gate?.connect).toHaveBeenCalledWith(FakeAudioWorkletNode.ofType(CASCADE_PCM_WORKLET_NAME));
    });

    it('builds no gate node, and loads no gate worklet, when the gate is off', async () => {
      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, cascadeTuning());

      expect(gateNode()).toBeUndefined();
      const addModule = FakeAudioContext.instances[0].audioWorklet.addModule;
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(addModule).toHaveBeenCalledWith(CASCADE_PCM_WORKLET_URL);
    });

    it('S23: a threshold change on a connected session posts gateParams to the worklet and reconnects nothing', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectAndOpen(result, gateTuning({ thresholdDbfs: -50 }));
      const gate = gateNode();
      if (!gate) throw new Error('expected a gate worklet node');

      const next = gateTuning({ thresholdDbfs: -30 });
      await act(async () => {
        void result.current.applyTuning(next);
      });

      expect(gate.port.postMessage).toHaveBeenCalledTimes(1);
      expect(gate.port.postMessage).toHaveBeenCalledWith({
        type: 'gateParams',
        gate: { ...DEFAULT_TUNING_CONFIG.client.rmsGate, enabled: true, thresholdDbfs: -30 },
      });
      // Client-side, but still on the wire: the server hashes the client block
      // into the fingerprint it reports, so it has to see the same document.
      expect(sentOfType(socket, 'update_tuning')).toHaveLength(1);
      // No reconnect of anything: same socket, same capture context.
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(socket.close).not.toHaveBeenCalled();
      expect(FakeAudioContext.instances).toHaveLength(1);
      expect(result.current.status).toBe('connected');
    });

    it('clamps what it posts, so the worklet and the fingerprint can never disagree', async () => {
      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, gateTuning());
      const gate = gateNode();

      await act(async () => {
        void result.current.applyTuning(gateTuning({ thresholdDbfs: -400, holdMs: 204 }));
      });

      expect(gate?.port.postMessage).toHaveBeenCalledWith({
        type: 'gateParams',
        gate: expect.objectContaining({ thresholdDbfs: -80, holdMs: 200 }),
      });
    });

    it('turns a running gate off live — the worklet passes through rather than being removed', async () => {
      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, gateTuning());
      const gate = gateNode();

      await act(async () => {
        void result.current.applyTuning(gateTuning({ enabled: false }));
      });

      expect(gate?.port.postMessage).toHaveBeenCalledWith({
        type: 'gateParams',
        gate: expect.objectContaining({ enabled: false }),
      });
    });

    it('says so rather than pretending, when the gate is enabled on a session that has no gate node', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, cascadeTuning());

      await act(async () => {
        void result.current.applyTuning(gateTuning());
      });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reconnect to enable it'));
      warn.mockRestore();
    });
  });

  describe('ticket 13: RNNoise and the 48 kHz capture graph (E9, AC 3.4)', () => {
    beforeEach(() => {
      loadRnnoiseMock.mockClear();
    });

    /** A Cascade document with RNNoise on, and optionally the gate too. */
    function rnnoiseTuning(withGate = false): ModeTuningConfig {
      const config = structuredClone(DEFAULT_TUNING_CONFIG);
      config.client.rnnoise = { ...config.client.rnnoise, enabled: true };
      if (withGate) config.client.rmsGate = { ...config.client.rmsGate, enabled: true };
      return projectMode(config, 'cascade');
    }

    async function connectAndOpen(
      result: { current: ReturnType<typeof useCascadeSession> },
      tuning?: ModeTuningConfig,
    ) {
      act(() => {
        result.current.connect(LANGUAGES, tuning);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      act(() => latestSocket().emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));
    }

    const captureContext = () => FakeAudioContext.instances[0];
    const pcmNode = () => FakeAudioWorkletNode.ofType(CASCADE_PCM_WORKLET_NAME);
    const rnnoiseNode = () => FakeAudioWorkletNode.ofType(RNNOISE_WORKLET_NAME);

    it('runs the capture context at 48 kHz and tells the worklet what to decimate to', async () => {
      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, rnnoiseTuning());

      expect(captureContext().sampleRate).toBe(48000);
      // The 16 kHz half of the contract does not move with the context: the
      // worklet is told the target rate and decimates 3:1 on the way out.
      expect(pcmNode()?.processorOptions).toEqual({ targetSampleRate: 16000 });
    });

    it('registers the package worklet and fetches both wasm binaries, then inserts the node', async () => {
      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, rnnoiseTuning());

      expect(captureContext().audioWorklet.addModule).toHaveBeenCalledWith(RNNOISE_WORKLET_URL);
      expect(loadRnnoiseMock).toHaveBeenCalledWith(RNNOISE_WASM_URLS);
      // Mono mic, and the wasm binary the load call produced.
      expect(rnnoiseNode()?.processorOptions).toEqual({ maxChannels: 1, wasmBinary: expect.any(ArrayBuffer) });

      // mic -> rnnoise -> pcm worklet, with no gate in between.
      expect(captureContext().createdSources[0].connect).toHaveBeenCalledWith(rnnoiseNode());
      expect(rnnoiseNode()?.connect).toHaveBeenCalledWith(pcmNode());
    });

    it('puts RNNoise after the gate, the order the panel lists them in', async () => {
      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, rnnoiseTuning(true));

      const gate = FakeAudioWorkletNode.ofType(GATE_WORKLET_NAME);
      expect(captureContext().createdSources[0].connect).toHaveBeenCalledWith(gate);
      expect(gate?.connect).toHaveBeenCalledWith(rnnoiseNode());
      expect(rnnoiseNode()?.connect).toHaveBeenCalledWith(pcmNode());
    });

    it('leaves the graph at 16 kHz, with no RNNoise module loaded, when the stage is off', async () => {
      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, cascadeTuning());

      expect(captureContext().sampleRate).toBe(16000);
      expect(rnnoiseNode()).toBeUndefined();
      expect(loadRnnoiseMock).not.toHaveBeenCalled();
      const addModule = captureContext().audioWorklet.addModule;
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(addModule).toHaveBeenCalledWith(CASCADE_PCM_WORKLET_URL);
      // Still told the target rate — the worklet compares it against its own
      // context rate and decimates only when the two actually differ.
      expect(pcmNode()?.processorOptions).toEqual({ targetSampleRate: 16000 });
    });

    it('keeps the session when RNNoise fails to load, and says what it dropped', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadRnnoiseMock.mockRejectedValueOnce(new Error('404'));

      const { result } = renderHook(() => useCascadeSession());
      await connectAndOpen(result, rnnoiseTuning(true));

      expect(result.current.status).toBe('connected');
      expect(rnnoiseNode()).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('capturing without it'), expect.any(Error));
      // The rest of the chain is intact, and the 48 kHz context is still
      // decimated, so audio keeps flowing at the rate the backend expects.
      expect(captureContext().sampleRate).toBe(48000);
      expect(FakeAudioWorkletNode.ofType(GATE_WORKLET_NAME)?.connect).toHaveBeenCalledWith(pcmNode());
      warn.mockRestore();
    });
  });

  describe('ticket 14: transcript check verdicts (S27)', () => {
    /** Connects, opens the socket, and streams one final segment in — what every verdict arrives after. */
    async function connectWithFinalSegment(
      result: { current: ReturnType<typeof useCascadeSession> },
      text = 'I scream for ice cream',
    ) {
      act(() => {
        result.current.connect(LANGUAGES);
      });
      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = latestSocket();
      act(() => socket.emitOpen());
      await waitFor(() => expect(result.current.status).toBe('connected'));

      act(() => {
        socket.emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text, isFinal: true, speaker: 0 }));
      });
      await waitFor(() => expect(result.current.sourceSegments).toHaveLength(1));
      return socket;
    }

    it('merges a flag re-send into the existing segment: flagged, same text, no duplicate', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectWithFinalSegment(result);

      act(() => {
        socket.emitMessage(
          JSON.stringify({
            type: 'source_transcript',
            segmentId: 's1',
            text: 'I scream for ice cream',
            isFinal: true,
            speaker: 0,
            flagged: true,
          }),
        );
      });

      await waitFor(() => expect(result.current.sourceSegments).toEqual([
        { id: 's1', text: 'I scream for ice cream', speaker: 0, flagged: true },
      ]));
      expect(result.current.sourceText).toBe('I scream for ice cream');
    });

    it('a correct re-send replaces the segment text and records correctedFrom, still without duplicating it', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectWithFinalSegment(result);

      act(() => {
        socket.emitMessage(
          JSON.stringify({
            type: 'source_transcript',
            segmentId: 's1',
            text: 'Ice cream for ice cream',
            isFinal: true,
            speaker: 0,
            flagged: true,
            correctedFrom: 'I scream for ice cream',
          }),
        );
      });

      await waitFor(() => expect(result.current.sourceSegments).toEqual([
        {
          id: 's1',
          text: 'Ice cream for ice cream',
          speaker: 0,
          flagged: true,
          correctedFrom: 'I scream for ice cream',
        },
      ]));
      expect(result.current.sourceText).toBe('Ice cream for ice cream');
    });

    it('leaves an unchecked segment with no flagged/correctedFrom fields at all', async () => {
      const { result } = renderHook(() => useCascadeSession());
      await connectWithFinalSegment(result, 'Hello there');

      expect(result.current.sourceSegments).toEqual([{ id: 's1', text: 'Hello there', speaker: 0 }]);
      expect(result.current.sourceSegments?.[0]).not.toHaveProperty('flagged');
    });

    it('records the transcript_check latency stage against its segment', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectWithFinalSegment(result);

      act(() => {
        socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'speech_end', ms: 0 }));
        socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'transcript_check', ms: 240 }));
        socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'playback_start', ms: 900 }));
      });

      await waitFor(() => expect(result.current.cascadeLatency).toEqual({
        segmentId: 's1',
        stages: { speech_end: 0, transcript_check: 240, playback_start: 900 },
      }));
    });

    it('routes a transcript_check provider failure to a toast, leaving the session and its transcript alone', async () => {
      const { result } = renderHook(() => useCascadeSession());
      const socket = await connectWithFinalSegment(result);

      act(() => {
        socket.emitMessage(
          JSON.stringify({
            type: 'error',
            provider: 'transcript_check',
            kind: 'UNKNOWN',
            message: 'The transcript check could not run for this segment.',
            retryable: true,
          }),
        );
      });

      await waitFor(() => expect(result.current.cascadeToasts).toEqual([
        { id: 'toast-0', message: 'The transcript check could not run for this segment.' },
      ]));
      expect(result.current.status).toBe('connected');
      expect(result.current.errorMessage).toBeNull();
      expect(socket.close).not.toHaveBeenCalled();
      // The original text stands, unflagged — nothing was corrected.
      expect(result.current.sourceSegments).toEqual([{ id: 's1', text: 'I scream for ice cream', speaker: 0 }]);
    });
  });
});
