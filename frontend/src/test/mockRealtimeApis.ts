import { vi } from 'vitest';
import {
  OPENAI_REALTIME_CALLS_ENDPOINT,
  REALTIME_SESSION_ENDPOINT,
  TRANSCRIPT_CHECK_ENDPOINT,
} from '../pages/realtimeConfig';
import { TUNING_CAPABILITIES_ENDPOINT } from '../pages/tuningCapabilities';
import { DEFAULT_TUNING_CONFIG, fingerprint, projectMode } from '../pages/tuningConfig';
import { FakeAnalyserNode } from './mockAudioAnalysis';
import {
  createFakeDestination,
  FakeAudioWorkletNode,
  type FakeAudioNode,
  type FakeMediaStreamDestination,
} from './mockCascadeApis';

// The client DSP graph is the same one in both modes (ticket 12), so its fakes
// are the Cascade ones, re-exported so a Realtime test has one import site.
export { FakeAudioWorkletNode } from './mockCascadeApis';
export type { FakeAudioNode } from './mockCascadeApis';

/** Minimal fetch Response stand-in — only the members useRealtimeSession reads. */
export interface FakeFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

export function jsonResponse(body: unknown, status = 200): FakeFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

export function textResponse(body: string, status = 200): FakeFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not JSON');
    },
    text: async () => body,
  };
}

/**
 * A `GET /api/tuning/capabilities` body (ticket 01) that mirrors a default
 * server install: the `.env`-derived defaults are the client defaults, the
 * allow-lists are the curated ones, and no optional denoise extra is
 * installed.
 */
export function defaultCapabilitiesBody() {
  return {
    schemaVersion: 1,
    defaults: DEFAULT_TUNING_CONFIG,
    allowLists: {
      realtimeModels: ['gpt-realtime', 'gpt-realtime-mini'],
      realtimeVoices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'],
      deepgramModels: ['nova-3', 'nova-2'],
      textModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'],
      elevenLabsVoices: [
        { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel (voice A default)' },
        { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni (voice B default)' },
      ],
      turnDetectionTypes: ['server_vad', 'semantic_vad'],
      eagerness: ['low', 'medium', 'high', 'auto'],
      noiseReduction: ['off', 'near_field', 'far_field'],
    },
    stages: {
      deepfilternet: {
        installed: false,
        liveCapable: true,
        reason: 'torch not installed — run `uv sync --extra denoise` in backend/',
      },
      noisereduce: { installed: false, liveCapable: true, reason: 'run `uv sync --extra bench` in backend/' },
      demucs: { installed: false, liveCapable: false, reason: 'benchmark-only stage; install with `uv sync --extra denoise`' },
      dns64: { installed: false, liveCapable: false, reason: 'benchmark-only stage; install with `uv sync --extra denoise`' },
    },
  };
}

/**
 * Routes fetch to fake responses for our backend's session and tuning-
 * capabilities endpoints and OpenAI's SDP-exchange endpoint, defaulting to a
 * full happy-path set. Kept as a plain 2-arg function (not just `input`) so
 * `.mock.calls` retains the `init` argument for assertions on headers/body.
 */
export function createRealtimeFetchRouter(overrides?: {
  sessionResponse?: FakeFetchResponse;
  callsResponse?: FakeFetchResponse;
  capabilitiesResponse?: FakeFetchResponse;
  transcriptCheckResponse?: FakeFetchResponse;
}) {
  // `fingerprint` / `appliedTuning` (ticket 04) echo the default config back,
  // which is what a correct server does: the fingerprint it reports is the hash
  // of the document it says it applied. A test that needs the pre-tuning server
  // passes the four original fields as its own `sessionResponse`.
  const appliedTuning = projectMode(DEFAULT_TUNING_CONFIG, 'realtime');
  const sessionResponse =
    overrides?.sessionResponse ??
    jsonResponse({
      client_secret: 'ek_test_token',
      expires_at: 1893456000,
      model: 'gpt-realtime',
      voice: 'alloy',
      fingerprint: fingerprint(appliedTuning),
      appliedTuning,
    });
  const callsResponse = overrides?.callsResponse ?? textResponse('v=0\r\no=- fake-answer\r\n');
  const capabilitiesResponse = overrides?.capabilitiesResponse ?? jsonResponse(defaultCapabilitiesBody());
  // ticket 15: the default verdict is "nothing wrong with it", so a test that
  // isn't about the transcript check never grows a badge it didn't ask for.
  const transcriptCheckResponse =
    overrides?.transcriptCheckResponse ?? jsonResponse({ flagged: false, correctedText: null, elapsedMs: 42 });

  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === REALTIME_SESSION_ENDPOINT) return sessionResponse;
    if (url === OPENAI_REALTIME_CALLS_ENDPOINT) return callsResponse;
    if (url === TUNING_CAPABILITIES_ENDPOINT) return capabilitiesResponse;
    if (url === TRANSCRIPT_CHECK_ENDPOINT) return transcriptCheckResponse;
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

/** A mic MediaStream with a single fake, stoppable audio track. */
export function createMockMicStream() {
  const stop = vi.fn();
  const track = { kind: 'audio', stop } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track, stop };
}

type TrackEventLike = { streams: MediaStream[] };

/** Stand-in for RTCDataChannel — tests emit simulated `oai-events` server frames on it. */
export class MockRTCDataChannel {
  label: string;
  /**
   * A real channel is `'connecting'` from `createDataChannel()` until the peer
   * opens it, and `send()` on it throws. That window is why
   * `useRealtimeSession` queues a `session.update` instead of sending one
   * (ticket 05, test E3), so the default here is the real default.
   */
  readyState: RTCDataChannelState = 'connecting';
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(label: string) {
    this.label = label;
  }

  /** Test helper: simulate an incoming JSON event frame from OpenAI. */
  emitMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  /** Test helper: simulate the peer opening the channel. */
  emitOpen() {
    this.readyState = 'open';
    this.onopen?.(new Event('open'));
  }
}

/** Stand-in for RTCPeerConnection, capturing every instance built during a test. */
export class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];

  static reset() {
    MockRTCPeerConnection.instances = [];
  }

  connectionState: RTCPeerConnectionState = 'new';
  ontrack: ((event: TrackEventLike) => void) | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  dataChannel: MockRTCDataChannel | null = null;

  addTrack = vi.fn();
  createDataChannel = vi.fn((label: string) => {
    this.dataChannel = new MockRTCDataChannel(label);
    return this.dataChannel;
  });
  close = vi.fn();

  createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
    type: 'offer',
    sdp: 'v=0\r\no=- fake-offer\r\n',
  }));

  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
  });

  setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {
    /* no-op */
  });

  constructor() {
    MockRTCPeerConnection.instances.push(this);
  }

  /** Simulate OpenAI's remote audio track arriving. */
  emitTrack(stream: MediaStream) {
    this.ontrack?.({ streams: [stream] });
  }
}

export function installMockRTCPeerConnection() {
  MockRTCPeerConnection.reset();
  vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection as unknown as typeof RTCPeerConnection);
}

/**
 * Stand-in for AudioContext, sufficient for useRealtimeSession's mic-level
 * metering and — once a client DSP stage is enabled (ticket 12) — for the
 * `source -> gate -> MediaStreamAudioDestinationNode` graph whose track is what
 * WebRTC then sends.
 */
export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static reset() {
    FakeAudioContext.instances = [];
  }

  /**
   * `sampleRate` honours the constructor option (ticket 13 asks the DSP context
   * for 48 kHz explicitly, and a test needs to see which rate was asked for) and
   * otherwise reports the rate the level-metering context gets handed by the
   * hardware, which is 48 kHz on essentially everything.
   */
  sampleRate: number;
  createdAnalysers: FakeAnalyserNode[] = [];
  createdDestinations: FakeMediaStreamDestination[] = [];
  createdSources: FakeAudioNode[] = [];
  audioWorklet = { addModule: vi.fn(async () => undefined) };

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48000;
    FakeAudioContext.instances.push(this);
  }

  /** The graph's head node, kept so a test can read the first `connect` off it. */
  createMediaStreamSource = vi.fn(() => {
    const node: FakeAudioNode = { connect: vi.fn() };
    this.createdSources.push(node);
    return node;
  });

  createMediaStreamDestination = vi.fn(() => {
    const destination = createFakeDestination();
    this.createdDestinations.push(destination);
    return destination;
  });

  createAnalyser = vi.fn(() => {
    const node = new FakeAnalyserNode();
    this.createdAnalysers.push(node);
    return node;
  });

  close = vi.fn(async () => undefined);
}

export function installFakeAudioApis() {
  FakeAudioContext.reset();
  FakeAudioWorkletNode.reset();
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode as unknown as typeof AudioWorkletNode);
}
