import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockMicStream } from '../test/mockRealtimeApis';
import {
  FakeAudioContext,
  installFakeAudioApis,
  installMockGetUserMedia,
  installMockWebSocket,
  MockWebSocket,
} from '../test/mockCascadeApis';
import { installManualAnimationFrame } from '../test/mockAudioAnalysis';
import { useCascadeSession } from './useCascadeSession';

const LANGUAGES = { sourceLanguage: 'en', targetLanguage: 'es' };

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('no MockWebSocket instance was created');
  return socket;
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
});
