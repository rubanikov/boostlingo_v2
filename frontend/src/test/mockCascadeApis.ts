import { vi } from 'vitest';
import { FakeAnalyserNode } from './mockAudioAnalysis';

/** Minimal WebSocket stand-in the hook can construct, send through, and receive simulated server frames on. */
export class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static reset() {
    MockWebSocket.instances = [];
  }

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  url: string;
  sent: Array<string | ArrayBuffer> = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });

  send = vi.fn((data: string | ArrayBuffer) => {
    this.sent.push(data);
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  /** Test helper: simulate the server completing the WS handshake. */
  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: simulate an incoming JSON text or binary server frame. */
  emitMessage(data: string | ArrayBuffer) {
    this.onmessage?.({ data } as MessageEvent);
  }

  /**
   * Test helper: simulate the server or network closing the connection
   * unexpectedly — unlike `close()` (a `vi.fn` standing in for the client's
   * own deliberate close), this never touches `close()` itself, so it
   * exercises the "not our own disconnect()" branch of onclose handling
   * (ticket 07's reconnect-vs-intentional-close distinction).
   */
  emitClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

export function installMockWebSocket() {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
}

/** Stand-in for AudioBufferSourceNode — records what it was started with. */
export class FakeAudioBufferSourceNode {
  buffer: { duration: number } | null = null;
  connect = vi.fn();
  start = vi.fn();
}

/**
 * A track on a `MediaStreamAudioDestinationNode`'s stream: the thing the
 * Realtime graph actually sends once a client DSP stage is on (ticket 12), and
 * therefore the thing the mute-during-reply logic has to target.
 */
export interface FakeAudioTrack {
  kind: 'audio';
  enabled: boolean;
  stop: () => void;
}

export interface FakeMediaStreamDestination {
  stream: MediaStream;
  track: FakeAudioTrack;
  connect: () => void;
}

/** Anything in the graph a test asserts `connect` calls on. */
export interface FakeAudioNode {
  connect: ReturnType<typeof vi.fn>;
}

export function createFakeDestination(): FakeMediaStreamDestination {
  const track: FakeAudioTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track, connect: vi.fn() };
}

/** Stand-in for AudioContext, sufficient for useCascadeSession's capture + playback wiring. */
export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static reset() {
    FakeAudioContext.instances = [];
  }

  sampleRate: number;
  currentTime = 0;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createdBufferSources: FakeAudioBufferSourceNode[] = [];
  createdAnalysers: FakeAnalyserNode[] = [];
  createdDestinations: FakeMediaStreamDestination[] = [];
  createdSources: FakeAudioNode[] = [];

  /**
   * `sampleRate` honours the constructor option and defaults to 16 kHz — the
   * Cascade capture rate. A test that wants to know which rate a graph was
   * built at reads it back off the instance.
   */
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 16000;
    FakeAudioContext.instances.push(this);
  }

  /** The graph's head node, kept so a test can read the first `connect` off it. */
  createMediaStreamSource = vi.fn(() => {
    const node: FakeAudioNode = { connect: vi.fn() };
    this.createdSources.push(node);
    return node;
  });

  /** The Realtime client-DSP graph's output node (ticket 12). */
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

  createBuffer = vi.fn((_numberOfChannels: number, length: number, sampleRate: number) => {
    const channelData = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => channelData,
    };
  });

  createBufferSource = vi.fn(() => {
    const node = new FakeAudioBufferSourceNode();
    this.createdBufferSources.push(node);
    return node;
  });

  close = vi.fn(async () => undefined);
}

/**
 * Stand-in for AudioWorkletNode — exposes a controllable `port` for simulating
 * captured audio frames, and records how it was constructed so a test can tell
 * the capture worklet from the gate worklet and read the parameters each was
 * given (ticket 12).
 *
 * The `port` is two-way on purpose: `onmessage` is how the worklet talks to the
 * page (captured PCM), `postMessage` is how the page talks to the worklet (live
 * gate parameters), and S23 asserts the second of those.
 */
export class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  static reset() {
    FakeAudioWorkletNode.instances = [];
  }

  /** The registered processor name, i.e. which worklet this node is. */
  name: string;
  processorOptions: Record<string, unknown> | undefined;
  port: {
    onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
  connect = vi.fn();

  constructor(_context?: unknown, name = '', options?: { processorOptions?: Record<string, unknown> }) {
    this.name = name;
    this.processorOptions = options?.processorOptions;
    this.port = { onmessage: null, postMessage: vi.fn() };
    FakeAudioWorkletNode.instances.push(this);
  }

  /** The one node registered under `name`, for a graph that builds at most one of each. */
  static ofType(name: string): FakeAudioWorkletNode | undefined {
    return FakeAudioWorkletNode.instances.find((node) => node.name === name);
  }
}

export function installFakeAudioApis() {
  FakeAudioContext.reset();
  FakeAudioWorkletNode.reset();
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode as unknown as typeof AudioWorkletNode);
}

/** Stubs `navigator.mediaDevices.getUserMedia`, which jsdom does not implement. */
export function installMockGetUserMedia(
  impl: (constraints?: MediaStreamConstraints) => Promise<MediaStream>,
) {
  const getUserMedia = vi.fn(impl);
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  return getUserMedia;
}
