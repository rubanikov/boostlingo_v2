import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFakeAudioApis,
  installMockGetUserMedia,
  installMockWebSocket,
  MockWebSocket,
} from '../test/mockCascadeApis';
import {
  MockRTCPeerConnection,
  createMockMicStream,
  createRealtimeFetchRouter,
  installMockRTCPeerConnection,
} from '../test/mockRealtimeApis';
import { REALTIME_SESSION_ENDPOINT } from './realtimeConfig';
import { WorkbenchPage } from './WorkbenchPage';

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('no MockWebSocket instance was created');
  return socket;
}

function micButton() {
  // The button's accessible name changes with connection status, so match
  // loosely rather than pinning one exact label.
  return screen.getByRole('button', { name: /microphone|connection/i });
}

async function connectCascade(user: ReturnType<typeof userEvent.setup>) {
  await user.click(micButton());
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  latestSocket().emitOpen();
  await screen.findByText('Connected');
  return latestSocket();
}

describe('WorkbenchPage', () => {
  beforeEach(() => {
    installMockWebSocket();
    installFakeAudioApis(); // also stubs AudioWorkletNode; a superset of what useRealtimeSession needs.
    installMockGetUserMedia(async () => createMockMicStream().stream);
    installMockRTCPeerConnection();
    vi.stubGlobal('fetch', createRealtimeFetchRouter());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders idle with Cascade selected, English ↔ Spanish as the default language pair, and empty transcript panes', () => {
    render(<WorkbenchPage />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Cascade', 'Realtime']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');

    expect(screen.getByRole('combobox', { name: /language pair/i })).toHaveValue('en-es');
    expect(screen.getByText('English ↔ Spanish')).toBeInTheDocument();

    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByTestId('source-transcript')).toHaveTextContent('');
    expect(screen.getByTestId('target-transcript')).toHaveTextContent('');
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Target')).toBeInTheDocument();
  });

  it('does not reference WebSocket/RTCPeerConnection instances at idle — no transport has been created yet', () => {
    render(<WorkbenchPage />);
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(MockRTCPeerConnection.instances).toHaveLength(0);
  });

  it('switches mode before a session starts: connecting after switching to Realtime uses fetch, not a WebSocket', async () => {
    const user = userEvent.setup();
    render(<WorkbenchPage />);

    await user.click(screen.getByRole('tab', { name: 'Realtime' }));
    expect(screen.getByRole('tab', { name: 'Realtime' })).toHaveAttribute('aria-selected', 'true');

    await user.click(micButton());

    await waitFor(() => expect(MockRTCPeerConnection.instances).toHaveLength(1));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('streams Cascade transcripts live, appended incrementally, and shows the Connected badge', async () => {
    const user = userEvent.setup();
    render(<WorkbenchPage />);

    const socket = await connectCascade(user);

    socket.emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: false }));
    await screen.findByText('Hello');

    socket.emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello world', isFinal: true }));
    socket.emitMessage(JSON.stringify({ type: 'target_transcript', segmentId: 's1', text: 'Hola mundo', isFinal: true }));

    await waitFor(() => expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hello world'));
    expect(screen.getByTestId('target-transcript')).toHaveTextContent('Hola mundo');
  });

  it('streams Realtime transcripts live over the oai-events data channel, source and target independently', async () => {
    const user = userEvent.setup();
    render(<WorkbenchPage />);

    await user.click(screen.getByRole('tab', { name: 'Realtime' }));
    await user.click(micButton());

    await waitFor(() => expect(MockRTCPeerConnection.instances).toHaveLength(1));
    await screen.findByText('Connected');

    const pc = MockRTCPeerConnection.instances[0];
    const dataChannel = pc.dataChannel;
    if (!dataChannel) throw new Error('expected a data channel to have been created');

    dataChannel.emitMessage(
      JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hi' }),
    );
    dataChannel.emitMessage(
      JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: ' there' }),
    );
    dataChannel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));

    await waitFor(() => expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hi there'));
    expect(screen.getByTestId('target-transcript')).toHaveTextContent('Hola');
  });

  it('switches mode mid-session: tears down the live Cascade session, leaves Realtime idle, and does not auto-reconnect', async () => {
    const user = userEvent.setup();
    render(<WorkbenchPage />);

    const socket = await connectCascade(user);

    await user.click(screen.getByRole('tab', { name: 'Realtime' }));

    expect(socket.close).toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Realtime' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    // No auto-reconnect: switching modes alone must not open a new transport.
    expect(MockRTCPeerConnection.instances).toHaveLength(0);
  });

  it('shows an actionable error and an error-toned badge when microphone permission is denied', async () => {
    installMockGetUserMedia(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const user = userEvent.setup();
    render(<WorkbenchPage />);

    await user.click(micButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/microphone access was denied/i);
    expect(screen.getAllByText('Error')).toHaveLength(2); // navbar connection badge + mic-row status badge
  });

  it('the mic-denied banner\'s "Try again" button re-attempts getUserMedia() and connects, without a full page reload', async () => {
    const getUserMediaMock = installMockGetUserMedia(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const user = userEvent.setup();
    render(<WorkbenchPage />);

    await user.click(micButton());
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/microphone access was denied/i);

    // The next getUserMedia() call succeeds — simulating the user having
    // granted permission in the browser prompt shown by the retry.
    getUserMediaMock.mockImplementation(async () => createMockMicStream().stream);

    await user.click(within(banner).getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    latestSocket().emitOpen();

    await screen.findByText('Connected');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('drives the level meter bar width from the live mic level, starting at 0%', () => {
    render(<WorkbenchPage />);
    expect(screen.getByTestId('mic-level-bar')).toHaveStyle({ width: '0%' });
  });

  it('sends the selected language pair to connect(), not a value hardcoded past the UI', async () => {
    const user = userEvent.setup();
    const fetchMock = createRealtimeFetchRouter();
    vi.stubGlobal('fetch', fetchMock);
    render(<WorkbenchPage />);

    await user.click(screen.getByRole('tab', { name: 'Realtime' }));
    await user.click(micButton());

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        REALTIME_SESSION_ENDPOINT,
        expect.objectContaining({ body: JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'es' }) }),
      ),
    );
  });

  it('mic button click while connected disconnects the active session', async () => {
    const user = userEvent.setup();
    render(<WorkbenchPage />);

    const socket = await connectCascade(user);
    await user.click(micButton());

    expect(socket.close).toHaveBeenCalled();
    await screen.findByText('Not connected');
  });

  describe('Cascade diarization speaker badges (ticket 04)', () => {
    it('labels two alternating speakers with distinct, color-coded badges in both panes', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hi there', isFinal: true, speaker: 0 }),
      );
      socket.emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's2', text: 'Hola', isFinal: true, speaker: 1 }),
      );
      socket.emitMessage(
        JSON.stringify({ type: 'target_transcript', segmentId: 's1', text: 'Hola', isFinal: true, speaker: 0 }),
      );
      socket.emitMessage(
        JSON.stringify({ type: 'target_transcript', segmentId: 's2', text: 'Hi there', isFinal: true, speaker: 1 }),
      );

      // Wait for all four messages to land before reading the panes: the
      // container swaps from a plain <p> (empty/fallback) to a <div> of
      // segments the moment the first message arrives, so grab references
      // to source-transcript/target-transcript only after that settles.
      await waitFor(() => expect(screen.getAllByText('Speaker A')).toHaveLength(2));
      const sourcePane = screen.getByTestId('source-transcript');
      const targetPane = screen.getByTestId('target-transcript');

      expect(within(sourcePane).getByText('Hi there')).toBeInTheDocument();
      expect(within(targetPane).getByText('Hola')).toBeInTheDocument();
      expect(within(targetPane).getByText('Hi there')).toBeInTheDocument();

      // Consistent speaker -> label mapping in both panes.
      expect(within(sourcePane).getByText('Speaker A')).toBeInTheDocument();
      expect(within(sourcePane).getByText('Speaker B')).toBeInTheDocument();
      expect(within(targetPane).getByText('Speaker A')).toBeInTheDocument();
      expect(within(targetPane).getByText('Speaker B')).toBeInTheDocument();

      // Color-coded per the approved prototype: speaker 0 blue, speaker 1 orange.
      expect(within(sourcePane).getByText('Speaker A')).toHaveClass('speakerA-badge');
      expect(within(sourcePane).getByText('Speaker B')).toHaveClass('speakerB-badge');
    });

    it('falls back to a plain, badge-free paragraph for a segment with no diarized speaker', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: true }));

      await waitFor(() => expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hello'));
      expect(screen.queryByText(/^Speaker/)).not.toBeInTheDocument();
    });

    it('keeps a segment under its badge as interim text streams in incrementally', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hi', isFinal: false, speaker: 0 }),
      );
      await screen.findByText('Speaker A');
      expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hi');

      socket.emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hi there', isFinal: true, speaker: 0 }),
      );
      await waitFor(() => expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hi there'));
      // Still exactly one badge — the same segment was updated in place, not duplicated.
      expect(screen.getAllByText('Speaker A')).toHaveLength(1);
    });

    it('never shows speaker badges in Realtime mode', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await user.click(screen.getByRole('tab', { name: 'Realtime' }));
      await user.click(micButton());
      await waitFor(() => expect(MockRTCPeerConnection.instances).toHaveLength(1));
      await screen.findByText('Connected');

      const pc = MockRTCPeerConnection.instances[0];
      const dataChannel = pc.dataChannel;
      if (!dataChannel) throw new Error('expected a data channel to have been created');

      dataChannel.emitMessage(
        JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hi there' }),
      );

      await waitFor(() => expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hi there'));
      expect(screen.queryByText(/^Speaker/)).not.toBeInTheDocument();
    });
  });

  describe('LLM-hybrid segmentation trigger annotation (ticket 05)', () => {
    it('annotates a segment with its segment_boundary trigger once one arrives, in both panes', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: true }));
      socket.emitMessage(JSON.stringify({ type: 'target_transcript', segmentId: 's1', text: 'Hola', isFinal: true }));
      await screen.findByText('Hello');

      socket.emitMessage(JSON.stringify({ type: 'segment_boundary', segmentId: 's1', trigger: 'llm' }));

      await waitFor(() => expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hello (llm)'));
      expect(screen.getByTestId('target-transcript')).toHaveTextContent('Hola (llm)');
    });

    it('shows a segment with no trigger yet — and a Deepgram-triggered one — without a misleading annotation', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: true }));
      await screen.findByText('Hello');
      expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hello'); // no "(...)" yet

      socket.emitMessage(
        JSON.stringify({ type: 'segment_boundary', segmentId: 's1', trigger: 'deepgram_speech_final' }),
      );

      await waitFor(() => expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hello (pause)'));
    });
  });

  describe('latency instrumentation (ticket 06)', () => {
    it('shows no latency strip or badge before a segment/turn has completed, in either mode', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await connectCascade(user);
      expect(screen.queryByTestId('cascade-latency-strip')).not.toBeInTheDocument();
      expect(screen.queryByTestId('realtime-latency-badge')).not.toBeInTheDocument();
    });

    it('renders the Cascade latency strip once a segment completes, with a badge per stage and the biggest jump flagged', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'speech_end', ms: 0 }));
      socket.emitMessage(
        JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'translation_first_token', ms: 150 }),
      );
      socket.emitMessage(
        JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'translation_complete', ms: 400 }),
      );
      socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'tts_first_byte', ms: 600 }));
      socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'playback_start', ms: 650 }));

      const strip = await screen.findByTestId('cascade-latency-strip');
      expect(within(strip).getByText('speech end 0ms')).toBeInTheDocument();
      expect(within(strip).getByText('translation 150ms')).toBeInTheDocument();
      expect(within(strip).getByText('translation done 400ms')).toBeInTheDocument();
      expect(within(strip).getByText('TTS first byte 600ms')).toBeInTheDocument();
      expect(within(strip).getByText('playback 650ms')).toBeInTheDocument();

      // Biggest inter-stage jump (150 -> 400 = 250ms) flagged as the bottleneck.
      expect(within(strip).getByText('translation done 400ms')).toHaveClass('badge-warning');
      // playback_start is always the highlighted final benchmark number.
      expect(within(strip).getByText('playback 650ms')).toHaveClass('badge-primary');

      expect(screen.queryByTestId('realtime-latency-badge')).not.toBeInTheDocument();
    });

    it('switches the Cascade latency strip to whichever segment most recently completed', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'playback_start', ms: 650 }));
      await screen.findByText('playback 650ms');

      socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's2', stage: 'playback_start', ms: 500 }));
      await screen.findByText('playback 500ms');
      expect(screen.queryByText('playback 650ms')).not.toBeInTheDocument();
    });

    it('renders the Realtime latency badge once the turn completes, against the 1500ms target', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await user.click(screen.getByRole('tab', { name: 'Realtime' }));
      await user.click(micButton());
      await waitFor(() => expect(MockRTCPeerConnection.instances).toHaveLength(1));
      await screen.findByText('Connected');

      const pc = MockRTCPeerConnection.instances[0];
      const dataChannel = pc.dataChannel;
      if (!dataChannel) throw new Error('expected a data channel to have been created');

      const badge = await screen.findByTestId('realtime-latency-badge');
      expect(badge).toHaveTextContent('—');
      expect(badge).toHaveTextContent('1500ms target');

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1_000);
      dataChannel.emitMessage(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
      nowSpy.mockReturnValueOnce(1_300);
      dataChannel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));

      await waitFor(() => expect(screen.getByTestId('realtime-latency-badge')).toHaveTextContent('300ms'));
      expect(screen.queryByTestId('cascade-latency-strip')).not.toBeInTheDocument();

      nowSpy.mockRestore();
    });
  });

  describe('ticket 07: Cascade error handling & session resilience', () => {
    it('shows an amber Reconnecting badge when the Cascade WebSocket drops unexpectedly, then Connected again once resumed', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);
      socket.emitMessage(JSON.stringify({ type: 'session_started', sessionId: 'sess-1' }));

      socket.emitClose(); // unexpected drop, not our own disconnect()

      // Two badges show "Reconnecting…" simultaneously (navbar connection
      // badge + mic-row status badge), mirroring the existing "Error"
      // dual-badge pattern — both amber/warning-toned, not red or green.
      const badges = await screen.findAllByText('Reconnecting…');
      expect(badges).toHaveLength(2);
      for (const badge of badges) {
        expect(badge.className).toMatch(/badge-warning/);
      }

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
      const resumeSocket = MockWebSocket.instances[1];
      resumeSocket.emitOpen();
      resumeSocket.emitMessage(JSON.stringify({ type: 'clock_sync_ack', clientTime: 0, serverTime: 0 }));

      await screen.findByText('Connected');
      expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
    });

    it('shows the blocking "Interpretation unavailable" state when the circuit breaker trips, with a way to start a fresh session', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(
        JSON.stringify({
          type: 'error',
          provider: 'orchestrator',
          kind: 'circuit_open',
          message: '5 consecutive segment failures',
          retryable: false,
        }),
      );

      const banner = await screen.findByRole('alert');
      expect(banner).toHaveTextContent(/interpretation unavailable/i);
      expect(within(banner).getByRole('button', { name: /try again/i })).toBeInTheDocument();
      // The Error badge in the navbar replaces "Connected" — the normal
      // connected UI no longer claims the session is live.
      expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    });

    it('shows a non-blocking toast for a retryable Cascade error without interrupting the transcript UI', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);
      socket.emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: true }));
      await screen.findByText('Hello');

      socket.emitMessage(
        JSON.stringify({ type: 'error', provider: 'stt', kind: 'rate_limit', message: 'Deepgram rate limited', retryable: true }),
      );

      await screen.findByText('Deepgram rate limited');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // non-blocking: no blocking banner
      expect(screen.getByTestId('source-transcript')).toHaveTextContent('Hello'); // transcript UI undisturbed
      expect(screen.getByText('Connected')).toBeInTheDocument(); // session still live
    });
  });
});
