import { vi } from 'vitest';
import {
  OPENAI_REALTIME_CALLS_ENDPOINT,
  REALTIME_SESSION_ENDPOINT,
  TELEMETRY_REALTIME_TURN_ENDPOINT,
} from '../pages/realtimeConfig';
import { FakeAnalyserNode } from './mockAudioAnalysis';

/** Minimal fetch Response stand-in: only the members useRealtimeSession reads. */
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
 * Routes fetch to fake responses for our backend's session endpoint and
 * OpenAI's SDP-exchange endpoint, defaulting to a full happy-path pair.
 * Kept as a plain 2-arg function (not just `input`) so `.mock.calls` retains
 * the `init` argument for assertions on headers/body.
 */
export function createRealtimeFetchRouter(overrides?: {
  sessionResponse?: FakeFetchResponse;
  callsResponse?: FakeFetchResponse;
  telemetryTurnResponse?: FakeFetchResponse;
}) {
  const sessionResponse =
    overrides?.sessionResponse ??
    jsonResponse({ client_secret: 'ek_test_token', expires_at: 1893456000, model: 'gpt-realtime', voice: 'alloy' });
  const callsResponse = overrides?.callsResponse ?? textResponse('v=0\r\no=- fake-answer\r\n');
  const telemetryTurnResponse = overrides?.telemetryTurnResponse;

  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === REALTIME_SESSION_ENDPOINT) return sessionResponse;
    if (url === OPENAI_REALTIME_CALLS_ENDPOINT) return callsResponse;
    if (telemetryTurnResponse && url === TELEMETRY_REALTIME_TURN_ENDPOINT) {
      return telemetryTurnResponse;
    }
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
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(label: string) {
    this.label = label;
  }

  /** Test helper: simulate an incoming JSON event frame from OpenAI. */
  emitMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
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
 * metering (it doesn't need capture/playback like Cascade's does — WebRTC
 * carries the actual audio).
 */
export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static reset() {
    FakeAudioContext.instances = [];
  }

  createdAnalysers: FakeAnalyserNode[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));

  createAnalyser = vi.fn(() => {
    const node = new FakeAnalyserNode();
    this.createdAnalysers.push(node);
    return node;
  });

  close = vi.fn(async () => undefined);
}

export function installFakeAudioApis() {
  FakeAudioContext.reset();
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
}
