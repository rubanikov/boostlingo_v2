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
  defaultCapabilitiesBody,
  installMockRTCPeerConnection,
  jsonResponse,
} from '../test/mockRealtimeApis';
import { REALTIME_SESSION_ENDPOINT, TRANSCRIPT_CHECK_ENDPOINT } from './realtimeConfig';
import { TUNING_CAPABILITIES_ENDPOINT } from './tuningCapabilities';
import { DEFAULT_TUNING_CONFIG, fingerprint, projectMode } from './tuningConfig';
import { WorkbenchPage } from './WorkbenchPage';

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('no MockWebSocket instance was created');
  return socket;
}

/** The parsed body of the most recent `POST /api/realtime/session`. */
function sessionRequestBody(fetchMock: ReturnType<typeof createRealtimeFetchRouter>): Record<string, unknown> {
  const call = fetchMock.mock.calls.filter(([url]) => url === REALTIME_SESSION_ENDPOINT).at(-1);
  if (!call) throw new Error('no session request was made');
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
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
      expect(sessionRequestBody(fetchMock)).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'es' }),
    );
  });

  it('offers more than one language pair and passes a non-default selection through to connect()', async () => {
    const user = userEvent.setup();
    const fetchMock = createRealtimeFetchRouter();
    vi.stubGlobal('fetch', fetchMock);
    render(<WorkbenchPage />);

    await user.selectOptions(screen.getByRole('combobox', { name: /language pair/i }), 'en-fr');
    await user.click(screen.getByRole('tab', { name: 'Realtime' }));
    await user.click(micButton());

    await waitFor(() =>
      expect(sessionRequestBody(fetchMock)).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'fr' }),
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

  describe('transcript check flag badge (ticket 14, S27)', () => {
    it('badges a flagged segment beside its trigger annotation, without disturbing the text', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'I scream for ice cream', isFinal: true }),
      );
      socket.emitMessage(JSON.stringify({ type: 'segment_boundary', segmentId: 's1', trigger: 'llm' }));
      await screen.findByText('I scream for ice cream');
      expect(screen.queryByTestId('segment-suspicious-badge')).not.toBeInTheDocument();

      socket.emitMessage(
        JSON.stringify({
          type: 'source_transcript',
          segmentId: 's1',
          text: 'I scream for ice cream',
          isFinal: true,
          flagged: true,
        }),
      );

      const badge = await screen.findByTestId('segment-suspicious-badge');
      expect(badge).toHaveTextContent('⚑ check');
      expect(badge).toHaveAttribute('title', 'Transcript check flagged this segment as likely misrecognised');
      // Same paragraph as the text and its trigger annotation, and still one segment.
      expect(screen.getByTestId('source-transcript')).toHaveTextContent('I scream for ice cream (llm) ⚑ check');
      expect(screen.getAllByTestId('segment-suspicious-badge')).toHaveLength(1);
    });

    it('shows the corrected segment text, with the original kept in the badge title', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'I scream for ice cream', isFinal: true }),
      );
      await screen.findByText('I scream for ice cream');

      socket.emitMessage(
        JSON.stringify({
          type: 'source_transcript',
          segmentId: 's1',
          text: 'Ice cream for ice cream',
          isFinal: true,
          flagged: true,
          correctedFrom: 'I scream for ice cream',
        }),
      );

      await waitFor(() =>
        expect(screen.getByTestId('source-transcript')).toHaveTextContent('Ice cream for ice cream ⚑ check'),
      );
      expect(screen.getByTestId('segment-suspicious-badge')).toHaveAttribute(
        'title',
        'Transcript check flagged this segment as likely misrecognised and rewrote it — was: I scream for ice cream',
      );
    });

    it('badges only the flagged segment, leaving its neighbours unmarked', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: true }));
      socket.emitMessage(JSON.stringify({ type: 'source_transcript', segmentId: 's2', text: 'goodbye', isFinal: true }));
      socket.emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's2', text: 'goodbye', isFinal: true, flagged: true }),
      );

      await screen.findByTestId('segment-suspicious-badge');
      // The unflagged neighbour's paragraph is exactly its own text, badge-free.
      expect(within(screen.getByTestId('source-transcript')).getByText('Hello')).not.toHaveTextContent('⚑');
      expect(screen.getAllByTestId('segment-suspicious-badge')).toHaveLength(1);
    });

    it('shows no toast for the flag verdict itself — the badge is the whole treatment', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(
        JSON.stringify({ type: 'source_transcript', segmentId: 's1', text: 'Hello', isFinal: true, flagged: true }),
      );

      await screen.findByTestId('segment-suspicious-badge');
      // The connection badge is the only live region on screen: no toast joined it.
      expect(screen.getAllByRole('status').map((region) => region.textContent)).toEqual(['Connected']);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('renders the transcript_check stage in the latency strip once the segment completes', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);

      socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'speech_end', ms: 0 }));
      socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'transcript_check', ms: 240 }));
      socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'playback_start', ms: 900 }));

      const strip = await screen.findByTestId('cascade-latency-strip');
      expect(strip).toHaveTextContent('check');
      expect(strip).toHaveTextContent('240');
    });
  });

  /**
   * ticket 15: the same verdict, the same badge, on a transport with no
   * segments to hang it on — so it lands after the flat source text instead.
   */
  describe('Realtime transcript check flag badge (ticket 15)', () => {
    /** A server whose published defaults have the Realtime check switched on. */
    function flagModeCapabilities() {
      const defaults = structuredClone(DEFAULT_TUNING_CONFIG);
      defaults.realtime.transcriptCheck.mode = 'flag';
      return { defaults, response: jsonResponse({ ...defaultCapabilitiesBody(), defaults }) };
    }

    /**
     * Switches to Realtime, waits for the published defaults to be the config
     * the mic button would connect with, then connects.
     */
    async function connectRealtime(user: ReturnType<typeof userEvent.setup>, defaults = DEFAULT_TUNING_CONFIG) {
      await user.click(screen.getByRole('tab', { name: 'Realtime' }));
      await waitFor(() =>
        expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(
          fingerprint(projectMode(defaults, 'realtime')),
        ),
      );
      await user.click(micButton());
      await waitFor(() => expect(MockRTCPeerConnection.instances).toHaveLength(1));
      await screen.findByText('Connected');

      const dataChannel = MockRTCPeerConnection.instances.at(-1)?.dataChannel;
      if (!dataChannel) throw new Error('expected a data channel to have been created');
      return dataChannel;
    }

    it('badges the flat source text once a settled turn comes back flagged', async () => {
      const { defaults, response } = flagModeCapabilities();
      vi.stubGlobal(
        'fetch',
        createRealtimeFetchRouter({
          capabilitiesResponse: response,
          transcriptCheckResponse: jsonResponse({ flagged: true, correctedText: null, elapsedMs: 130 }),
        }),
      );
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const dataChannel = await connectRealtime(user, defaults);
      dataChannel.emitMessage(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.delta',
          delta: 'I scream for ice cream',
        }),
      );
      await screen.findByText('I scream for ice cream');
      expect(screen.queryByTestId('segment-suspicious-badge')).not.toBeInTheDocument();

      dataChannel.emitMessage(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'I scream for ice cream',
        }),
      );

      const badge = await screen.findByTestId('segment-suspicious-badge');
      expect(badge).toHaveTextContent('⚑ check');
      expect(badge).toHaveAttribute('title', 'Transcript check flagged this segment as likely misrecognised');
      // One badge, after the text it is about, in the source pane only.
      expect(screen.getByTestId('source-transcript')).toHaveTextContent('I scream for ice cream ⚑ check');
      expect(screen.getByTestId('target-transcript')).not.toHaveTextContent('⚑');
      expect(screen.getAllByTestId('segment-suspicious-badge')).toHaveLength(1);
    });

    it('leaves the text unbadged when the check finds nothing wrong with the turn', async () => {
      const { defaults, response } = flagModeCapabilities();
      const fetchMock = createRealtimeFetchRouter({ capabilitiesResponse: response });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const dataChannel = await connectRealtime(user, defaults);
      dataChannel.emitMessage(
        JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hello there' }),
      );
      dataChannel.emitMessage(
        JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello there' }),
      );

      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([url]) => url === TRANSCRIPT_CHECK_ENDPOINT)).toHaveLength(1),
      );
      await screen.findByText('Hello there');
      expect(screen.queryByTestId('segment-suspicious-badge')).not.toBeInTheDocument();
    });

    it('checks nothing, and badges nothing, while the Realtime mode is off', async () => {
      const fetchMock = createRealtimeFetchRouter({
        transcriptCheckResponse: jsonResponse({ flagged: true, correctedText: null, elapsedMs: 130 }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const dataChannel = await connectRealtime(user);
      dataChannel.emitMessage(
        JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hello there' }),
      );
      dataChannel.emitMessage(
        JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello there' }),
      );

      await screen.findByText('Hello there');
      expect(fetchMock.mock.calls.filter(([url]) => url === TRANSCRIPT_CHECK_ENDPOINT)).toHaveLength(0);
      expect(screen.queryByTestId('segment-suspicious-badge')).not.toBeInTheDocument();
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

  describe('ticket 01: tuning fingerprint chips', () => {
    const FINGERPRINT_PATTERN = /^cfg:[0-9a-f]{8}$/;

    it('fetches the server capabilities once on mount and shows their fingerprint in the navbar', async () => {
      const fetchMock = createRealtimeFetchRouter();
      vi.stubGlobal('fetch', fetchMock);
      render(<WorkbenchPage />);

      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(FINGERPRINT_PATTERN));
      const capabilitiesCalls = fetchMock.mock.calls.filter(([input]) => input === TUNING_CAPABILITIES_ENDPOINT);
      expect(capabilitiesCalls).toHaveLength(1);
      expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(
        fingerprint(projectMode(DEFAULT_TUNING_CONFIG, 'cascade')),
      );
    });

    it('hashes the defaults the *server* published, not the client-side fallback', async () => {
      const serverDefaults = JSON.parse(JSON.stringify(DEFAULT_TUNING_CONFIG)) as typeof DEFAULT_TUNING_CONFIG;
      serverDefaults.cascade.deepgram.endpointingMs = 300; // as if REALTIME/.env said so
      vi.stubGlobal(
        'fetch',
        createRealtimeFetchRouter({
          capabilitiesResponse: jsonResponse({ ...defaultCapabilitiesBody(), defaults: serverDefaults }),
        }),
      );
      render(<WorkbenchPage />);

      const expected = fingerprint(projectMode(serverDefaults, 'cascade'));
      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(expected));
      expect(expected).not.toBe(fingerprint(projectMode(DEFAULT_TUNING_CONFIG, 'cascade')));
    });

    it('shows a skeleton chip while the capabilities request is still in flight', () => {
      vi.stubGlobal(
        'fetch',
        createRealtimeFetchRouter({
          capabilitiesResponse: {
            ok: true,
            status: 200,
            json: () => new Promise<unknown>(() => {}), // never settles
            text: async () => '',
          },
        }),
      );
      render(<WorkbenchPage />);

      const chip = screen.getByTestId('tuning-fingerprint');
      expect(chip).toHaveTextContent('');
      expect(chip.className).toMatch(/skeleton/);
    });

    it('falls back to the built-in defaults when the capabilities request fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        createRealtimeFetchRouter({
          capabilitiesResponse: { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' },
        }),
      );
      render(<WorkbenchPage />);

      await waitFor(() =>
        expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(
          fingerprint(projectMode(DEFAULT_TUNING_CONFIG, 'cascade')),
        ),
      );
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('changes the chip when the mode changes — the same knobs in a different mode are a different run', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(FINGERPRINT_PATTERN));
      const cascadeText = screen.getByTestId('tuning-fingerprint').textContent;

      await user.click(screen.getByRole('tab', { name: 'Realtime' }));

      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint').textContent).not.toBe(cascadeText));
      expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(
        fingerprint(projectMode(DEFAULT_TUNING_CONFIG, 'realtime')),
      );
    });

    it('renders the same fingerprint beside the Cascade latency strip, as a sibling of it', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const socket = await connectCascade(user);
      socket.emitMessage(JSON.stringify({ type: 'latency', segmentId: 's1', stage: 'playback_start', ms: 650 }));

      const strip = await screen.findByTestId('cascade-latency-strip');
      const latencyChip = await screen.findByTestId('tuning-fingerprint-latency');
      await waitFor(() => expect(latencyChip).toHaveTextContent(FINGERPRINT_PATTERN));
      expect(latencyChip.textContent).toBe(screen.getByTestId('tuning-fingerprint').textContent);

      // Sibling, never a child: the capture harness scrapes the strip's text.
      expect(within(strip).queryByTestId('tuning-fingerprint-latency')).not.toBeInTheDocument();
      expect(strip).not.toHaveTextContent('cfg:');
      expect(within(strip).getByText('playback 650ms')).toBeInTheDocument();
    });

    it('renders the fingerprint beside the Realtime latency badge without disturbing the ms text the harness scrapes', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await user.click(screen.getByRole('tab', { name: 'Realtime' }));
      await user.click(micButton());
      await waitFor(() => expect(MockRTCPeerConnection.instances).toHaveLength(1));
      await screen.findByText('Connected');

      const pc = MockRTCPeerConnection.instances[0];
      const dataChannel = pc.dataChannel;
      if (!dataChannel) throw new Error('expected a data channel to have been created');

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1_000);
      dataChannel.emitMessage(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
      nowSpy.mockReturnValueOnce(1_300);
      dataChannel.emitMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hola' }));

      const badge = await screen.findByTestId('realtime-latency-badge');
      await waitFor(() => expect(badge).toHaveTextContent('300ms'));
      const latencyChip = screen.getByTestId('tuning-fingerprint-latency');
      expect(latencyChip).toHaveTextContent(FINGERPRINT_PATTERN);
      expect(within(badge).queryByTestId('tuning-fingerprint-latency')).not.toBeInTheDocument();
      // The exact shape realtime-quality-capture.mjs's `latencyMatch` scrapes.
      expect(badge.textContent).toMatch(/(\d+)\s*ms/);
      expect(badge).not.toHaveTextContent('cfg:');

      nowSpy.mockRestore();
    });
  });

  describe('ticket 02: tuning panel shell', () => {
    async function openPanel(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByTestId('tuning-toggle'));
      return screen.findByTestId('tuning-panel');
    }

    it('keeps the panel shut by default and shows its toggle before the connection badge', async () => {
      render(<WorkbenchPage />);

      const toggle = screen.getByTestId('tuning-toggle');
      expect(toggle).toHaveTextContent('Tuning');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-controls', 'tuning-panel');
      expect(screen.queryByTestId('tuning-panel')).not.toBeInTheDocument();

      // The connection badge stays the right-most, highest-salience element.
      const navbarEnd = toggle.parentElement as HTMLElement;
      const children = Array.from(navbarEnd.children);
      expect(children.indexOf(toggle)).toBeLessThan(children.length - 1);
      expect(children.at(-1)).toHaveTextContent('Not connected');
    });

    it('opens the panel without stealing focus, and Escape closes it and returns focus to the toggle', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const toggle = screen.getByTestId('tuning-toggle');
      await openPanel(user);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      // You may be mid-session watching transcripts: opening must not move focus.
      expect(document.activeElement).toBe(toggle);

      screen.getByTestId('tuning-close').focus();
      await user.keyboard('{Escape}');

      expect(screen.queryByTestId('tuning-panel')).not.toBeInTheDocument();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(document.activeElement).toBe(toggle);
    });

    it('closes on the panel\'s own close button', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await openPanel(user);
      await user.click(screen.getByTestId('tuning-close'));

      expect(screen.queryByTestId('tuning-panel')).not.toBeInTheDocument();
    });

    it('drops the transcript grid to one column while the panel is open', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      const grid = screen.getByTestId('source-transcript').closest('.grid') as HTMLElement;
      expect(grid.className).toMatch(/sm:grid-cols-2/);

      await openPanel(user);
      expect((screen.getByTestId('source-transcript').closest('.grid') as HTMLElement).className).not.toMatch(
        /sm:grid-cols-2/,
      );
    });

    it('counts the current mode\'s unapplied changes in the navbar badge and clears it on Apply', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await openPanel(user);
      expect(screen.queryByTestId('tuning-pending-count')).not.toBeInTheDocument();

      await user.selectOptions(await screen.findByTestId('tuning-model-translation'), 'gpt-4.1-nano');
      expect(screen.getByTestId('tuning-pending-count')).toHaveTextContent('1 pending');

      await user.click(screen.getByTestId('tuning-apply'));
      expect(screen.queryByTestId('tuning-pending-count')).not.toBeInTheDocument();
    });

    it('stays open across a mode switch and re-renders for the new mode, keeping the other mode\'s edits', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await openPanel(user);
      await user.selectOptions(await screen.findByTestId('tuning-model-translation'), 'gpt-4.1-nano');
      expect(screen.getByTestId('tuning-pending-count')).toHaveTextContent('1 pending');

      await user.click(screen.getByRole('tab', { name: 'Realtime' }));

      expect(screen.getByTestId('tuning-panel')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-model-realtime')).toBeInTheDocument();
      expect(screen.queryByTestId('tuning-model-translation')).not.toBeInTheDocument();
      // The pending badge counts the current mode only — nothing was copied across.
      expect(screen.queryByTestId('tuning-pending-count')).not.toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: 'Cascade' }));
      expect(screen.getByTestId('tuning-pending-count')).toHaveTextContent('1 pending');
    });

    it('moves the navbar fingerprint chip with the config the current mode has applied', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(/^cfg:/));
      const before = screen.getByTestId('tuning-fingerprint').textContent;

      await openPanel(user);
      await user.selectOptions(await screen.findByTestId('tuning-model-translation'), 'gpt-4.1-nano');
      // A fingerprint that changed as you typed would be noise: only Apply moves it.
      expect(screen.getByTestId('tuning-fingerprint').textContent).toBe(before);

      await user.click(screen.getByTestId('tuning-apply'));
      expect(screen.getByTestId('tuning-fingerprint').textContent).not.toBe(before);
      expect(screen.getByTestId('tuning-fingerprint-panel').textContent).toBe(
        screen.getByTestId('tuning-fingerprint').textContent,
      );
    });

    it('fetches the capabilities exactly once even with the panel opened and closed', async () => {
      const fetchMock = createRealtimeFetchRouter();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await openPanel(user);
      await user.click(screen.getByTestId('tuning-close'));
      await openPanel(user);

      expect(fetchMock.mock.calls.filter(([input]) => input === TUNING_CAPABILITIES_ENDPOINT)).toHaveLength(1);
    });
  });

  describe('ticket 04: start-of-session tuning', () => {
    it('starts a Realtime session with the config the current mode has applied', async () => {
      const fetchMock = createRealtimeFetchRouter();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await user.click(screen.getByRole('tab', { name: 'Realtime' }));
      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(/^cfg:/));
      await user.click(micButton());

      await waitFor(() =>
        expect(sessionRequestBody(fetchMock)).toEqual({
          sourceLanguage: 'en',
          targetLanguage: 'es',
          tuning: projectMode(DEFAULT_TUNING_CONFIG, 'realtime'),
        }),
      );
    });

    it('sends what was applied in the panel, not the untouched defaults', async () => {
      const fetchMock = createRealtimeFetchRouter();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await user.click(screen.getByRole('tab', { name: 'Realtime' }));
      await user.click(screen.getByTestId('tuning-toggle'));
      await user.click(await screen.findByTestId('tuning-vad-silence-duration-default'));
      await user.click(screen.getByTestId('tuning-apply'));
      await user.click(micButton());

      await waitFor(() => expect(sessionRequestBody(fetchMock)).toHaveProperty('tuning'));
      const tuning = sessionRequestBody(fetchMock).tuning as { realtime: { turnDetection: unknown } };
      expect(tuning.realtime.turnDetection).toEqual({ type: 'server_vad', silenceDurationMs: 500 });
    });

    it('carries the config through the error banner\'s Try again as well', async () => {
      const fetchMock = createRealtimeFetchRouter({
        sessionResponse: { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' },
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await user.click(screen.getByRole('tab', { name: 'Realtime' }));
      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(/^cfg:/));
      await user.click(micButton());

      const banner = await screen.findByRole('alert');
      await user.click(within(banner).getByRole('button', { name: /try again/i }));

      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([url]) => url === REALTIME_SESSION_ENDPOINT)).toHaveLength(2),
      );
      expect(sessionRequestBody(fetchMock)).toHaveProperty('tuning', projectMode(DEFAULT_TUNING_CONFIG, 'realtime'));
    });

    it('shows the fingerprint the server confirmed while connected, and the local one once it is not', async () => {
      vi.stubGlobal(
        'fetch',
        createRealtimeFetchRouter({
          sessionResponse: jsonResponse({
            client_secret: 'ek_test_token',
            expires_at: 1893456000,
            model: 'gpt-realtime',
            voice: 'alloy',
            fingerprint: 'cfg:5eeded01',
          }),
        }),
      );
      const user = userEvent.setup();
      render(<WorkbenchPage />);

      await user.click(screen.getByRole('tab', { name: 'Realtime' }));
      const local = fingerprint(projectMode(DEFAULT_TUNING_CONFIG, 'realtime'));
      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(local));

      await user.click(micButton());
      await screen.findByText('Connected');

      // The server's word wins while it is running: the chip and the panel
      // header can never claim a config the backend didn't apply.
      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent('cfg:5eeded01'));
      await user.click(screen.getByTestId('tuning-toggle'));
      expect(await screen.findByTestId('tuning-fingerprint-panel')).toHaveTextContent('cfg:5eeded01');

      await user.click(micButton()); // disconnect
      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(local));
    });
  });

  describe('ticket 07: Cascade connection-level apply', () => {
    it('flies the amber Reconnecting badge while the server reopens Deepgram, then goes back to Connected', async () => {
      const user = userEvent.setup();
      render(<WorkbenchPage />);
      const socket = await connectCascade(user);

      await user.click(screen.getByTestId('tuning-toggle'));
      const endpointing = await screen.findByTestId('tuning-dg-endpointing');
      await user.clear(endpointing);
      await user.type(endpointing, '300');
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Apply (reconnects STT)');

      await user.click(screen.getByTestId('tuning-apply'));

      // The same badge an unexpected WebSocket drop raises, deliberately: from
      // the user's side this is the same experience — audio is still being
      // captured, transcripts pause for a moment (wireframe §4).
      const badges = await screen.findAllByText('Reconnecting…');
      expect(badges).toHaveLength(2);
      for (const badge of badges) {
        expect(badge.className).toMatch(/badge-warning/);
      }
      expect(screen.getByTestId('tuning-status')).toHaveTextContent(
        'Reconnecting STT with the new parameters… (attempt 1 of 3)',
      );

      const update = socket.sent
        .filter((entry): entry is string => typeof entry === 'string')
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((message) => message.type === 'update_tuning');
      socket.emitMessage(
        JSON.stringify({
          type: 'tuning_applied',
          requestId: update?.requestId,
          fingerprint: 'cfg:1234abcd',
          reconnectedStt: true,
        }),
      );

      await screen.findByText('Connected');
      expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent('cfg:1234abcd'));
    });
  });
});
