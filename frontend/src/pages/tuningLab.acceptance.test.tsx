import { render, screen, waitFor } from '@testing-library/react';
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
import { WorkbenchPage } from './WorkbenchPage';

/**
 * Story-level acceptance walk for the Audio Tuning & Denoise Lab: the
 * researcher opening the panel, moving one knob, and pressing Apply on a live
 * session — driven through `WorkbenchPage` with only the browser APIs faked,
 * so the panel, the hook and the transport are all the real ones.
 *
 * These are deliberately the *joins*. What each half does on its own is
 * already pinned: the panel's knobs in `TuningPanel.test.tsx`, the transports'
 * apply semantics in `useCascadeSession.test.ts` / `useRealtimeSession.test.ts`,
 * the draft/applied bookkeeping in `useTuningConfig.test.ts`. What no test
 * covered until here is whether pressing the panel's Apply button on a running
 * session actually puts the new config on the wire (AC 1.5, 1.6), whether the
 * panel's microphone toggles reach `getUserMedia` (AC 3.1), and whether a
 * config survives a page reload as the user would do it (AC 1.8).
 */

function micButton() {
  return screen.getByRole('button', { name: /microphone|connection/i });
}

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('no MockWebSocket instance was created');
  return socket;
}

/** Every JSON message the client has sent up the Cascade socket. */
function sentMessages(socket: MockWebSocket): Record<string, unknown>[] {
  return socket.sent
    .filter((entry): entry is string => typeof entry === 'string')
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

/** Every event the client has sent down the `oai-events` data channel. */
function sentEvents(channel: { send: { mock: { calls: unknown[][] } } }): Record<string, unknown>[] {
  return channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
}

async function connectCascade(user: ReturnType<typeof userEvent.setup>) {
  await user.click(micButton());
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  latestSocket().emitOpen();
  await screen.findByText('Connected');
  return latestSocket();
}

async function connectRealtime(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'Realtime' }));
  await user.click(micButton());
  await waitFor(() => expect(MockRTCPeerConnection.instances).toHaveLength(1));
  await screen.findByText('Connected');
  const channel = MockRTCPeerConnection.instances[0].dataChannel;
  if (!channel) throw new Error('expected an oai-events data channel');
  // OpenAI opens the channel a moment after the SDP exchange; nothing is sent
  // on it before that (ticket 05's E3).
  channel.emitOpen();
  return channel;
}

/** Opens the Tuning panel and waits for its sections to render. */
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('tuning-toggle'));
  await screen.findByTestId('tuning-sections');
}

describe('Audio Tuning & Denoise Lab — acceptance', () => {
  beforeEach(() => {
    installMockWebSocket();
    installFakeAudioApis();
    installMockGetUserMedia(async () => createMockMicStream().stream);
    installMockRTCPeerConnection();
    vi.stubGlobal('fetch', createRealtimeFetchRouter());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC 1.5 — a knob changed on a live Realtime session is applied over the data channel, without a teardown', async () => {
    const user = userEvent.setup();
    render(<WorkbenchPage />);
    const channel = await connectRealtime(user);

    await openPanel(user);
    // "Provider default" off, then the value the researcher wants to try.
    await user.click(await screen.findByTestId('tuning-vad-silence-duration-default'));
    const silence = screen.getByTestId('tuning-vad-silence-duration');
    await user.clear(silence);
    await user.type(silence, '300');
    await user.click(screen.getByTestId('tuning-apply'));

    await waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
    expect(sentEvents(channel)[0]).toEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: { input: { turn_detection: { type: 'server_vad', silence_duration_ms: 300 } } },
      },
    });
    // The point of a live apply: same session, same peer connection.
    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    expect(MockRTCPeerConnection.instances[0].close).not.toHaveBeenCalled();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByTestId('tuning-status')).toHaveTextContent(/^Applied · cfg:/);
    expect(screen.queryByTestId('tuning-pending-count')).not.toBeInTheDocument();
  });

  it('AC 1.6 — a Cascade change that costs no reconnect goes out as update_tuning and never flies the reconnecting badge', async () => {
    const user = userEvent.setup();
    render(<WorkbenchPage />);
    const socket = await connectCascade(user);

    await openPanel(user);
    await user.click(await screen.findByTestId('tuning-segmentation-mode-llm'));
    // Nothing about a segmentation change needs Deepgram reopened, and the
    // button must not claim otherwise.
    expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Apply');
    expect(screen.getByTestId('tuning-apply')).not.toHaveTextContent('reconnects STT');

    await user.click(screen.getByTestId('tuning-apply'));

    const update = sentMessages(socket).find((message) => message.type === 'update_tuning');
    expect(update).toBeDefined();
    const tuning = update?.tuning as { mode: string; cascade: { segmentation: { mode: string } } };
    expect(tuning.mode).toBe('cascade');
    expect(tuning.cascade.segmentation.mode).toBe('llm_priority');
    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();

    socket.emitMessage(
      JSON.stringify({
        type: 'tuning_applied',
        requestId: update?.requestId,
        fingerprint: 'cfg:aaaa1111',
        reconnectedStt: false,
      }),
    );

    await waitFor(() => expect(screen.getByTestId('tuning-status')).toHaveTextContent(/^Applied · cfg:aaaa1111/));
    // One socket for the whole exchange: the client never reconnected either.
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
  });

  it('Step 3 gate — a connection-level change reconnects immediately, with no confirmation asked first', async () => {
    const user = userEvent.setup();
    render(<WorkbenchPage />);
    const socket = await connectCascade(user);

    await openPanel(user);
    const endpointing = await screen.findByTestId('tuning-dg-endpointing');
    await user.clear(endpointing);
    await user.type(endpointing, '300');
    // The row and the button warn that this one costs a reconnect...
    expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Apply (reconnects STT)');

    await user.click(screen.getByTestId('tuning-apply'));

    // ...and then it just happens: no dialog, no second confirmation step
    // between the click and the request going out (gate answer 1).
    expect(screen.queryByTestId('tuning-apply-failed-dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const update = sentMessages(socket).find((message) => message.type === 'update_tuning');
    expect(update).toBeDefined();
    const tuning = update?.tuning as { cascade: { deepgram: { endpointingMs: number } } };
    expect(tuning.cascade.deepgram.endpointingMs).toBe(300);
    expect(await screen.findAllByText('Reconnecting…')).not.toHaveLength(0);
  });

  it('AC 3.1 — the panel\'s microphone toggles are what getUserMedia is asked for, in Cascade', async () => {
    const getUserMedia = installMockGetUserMedia(async () => createMockMicStream().stream);
    const user = userEvent.setup();
    render(<WorkbenchPage />);

    await openPanel(user);
    await user.click(await screen.findByTestId('tuning-mic-ec'));
    await user.click(screen.getByTestId('tuning-mic-ns'));
    await user.click(screen.getByTestId('tuning-mic-agc'));
    await user.click(screen.getByTestId('tuning-apply'));
    await user.click(micButton());

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

  it('AC 3.1 — the same toggles reach getUserMedia in Realtime', async () => {
    const getUserMedia = installMockGetUserMedia(async () => createMockMicStream().stream);
    const user = userEvent.setup();
    render(<WorkbenchPage />);

    await user.click(screen.getByRole('tab', { name: 'Realtime' }));
    await openPanel(user);
    await user.click(await screen.findByTestId('tuning-mic-ec'));
    await user.click(screen.getByTestId('tuning-mic-agc'));
    await user.click(screen.getByTestId('tuning-apply'));
    await user.click(micButton());

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    });
  });

  it('AC 1.8 — a config set in the panel survives a page reload, and nothing about it is written to the server', async () => {
    const fetchMock = createRealtimeFetchRouter();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const view = render(<WorkbenchPage />);

    await openPanel(user);
    await user.selectOptions(await screen.findByTestId('tuning-model-translation'), 'gpt-4.1-nano');
    await user.click(screen.getByTestId('tuning-apply'));
    await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(/^cfg:/));
    const applied = screen.getByTestId('tuning-fingerprint').textContent;

    // The reload: same browser, same storage, a fresh page.
    view.unmount();
    render(<WorkbenchPage />);
    await user.click(screen.getByTestId('tuning-toggle'));

    expect(await screen.findByTestId('tuning-model-translation')).toHaveValue('gpt-4.1-nano');
    await waitFor(() => expect(screen.getByTestId('tuning-fingerprint')).toHaveTextContent(String(applied)));
    // Nothing was pending after the reload — this is the applied config, not a
    // draft the user still has to press Apply on.
    expect(screen.queryByTestId('tuning-pending-count')).not.toBeInTheDocument();
    // Storage is client-side only: the panel never POSTs a config anywhere.
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
    }
  });
});
