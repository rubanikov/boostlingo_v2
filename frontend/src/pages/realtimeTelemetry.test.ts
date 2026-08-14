import { afterEach, describe, expect, it, vi } from 'vitest';
import { TELEMETRY_REALTIME_TURN_ENDPOINT } from './realtimeConfig';
import {
  buildRealtimeTurnPayload,
  extractRealtimeTurnUsage,
  reportRealtimeTurn,
  type RealtimeTurnInput,
} from './realtimeTelemetry';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const COMPLETE_TURN: RealtimeTurnInput = {
  turnIndex: 0,
  speechStoppedAt: 1_000,
  endToEndMs: 420,
  sourceText: 'Where is the station?',
  targetText: '¿Dónde está la estación?',
  sourceLanguage: 'en',
  targetLanguage: 'es',
  model: 'gpt-realtime',
  usage: { inputTokens: 320, outputTokens: 210 },
};

describe('buildRealtimeTurnPayload', () => {
  it('builds the ingest body from realtimeLatency timestamps, not a second clock', () => {
    expect(buildRealtimeTurnPayload(COMPLETE_TURN)).toEqual({
      turnIndex: 0,
      startedAt: '1970-01-01T00:00:01.000Z',
      endedAt: '1970-01-01T00:00:01.420Z',
      latencyMs: 420,
      sourceText: 'Where is the station?',
      targetText: '¿Dónde está la estación?',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      model: 'gpt-realtime',
      usage: { inputTokens: 320, outputTokens: 210 },
    });
  });

  it('returns null when speech_stopped or the first transcript delta has not landed', () => {
    expect(
      buildRealtimeTurnPayload({ ...COMPLETE_TURN, speechStoppedAt: null, endToEndMs: null }),
    ).toBeNull();
    expect(buildRealtimeTurnPayload({ ...COMPLETE_TURN, speechStoppedAt: 1_000, endToEndMs: null })).toBeNull();
    expect(buildRealtimeTurnPayload({ ...COMPLETE_TURN, speechStoppedAt: null, endToEndMs: 420 })).toBeNull();
  });

  it('omits optional fields that were never set', () => {
    expect(
      buildRealtimeTurnPayload({
        turnIndex: 2,
        speechStoppedAt: 5_000,
        endToEndMs: 300,
      }),
    ).toEqual({
      turnIndex: 2,
      startedAt: '1970-01-01T00:00:05.000Z',
      endedAt: '1970-01-01T00:00:05.300Z',
      latencyMs: 300,
    });
  });
});

describe('extractRealtimeTurnUsage', () => {
  it('maps OpenAI snake_case usage on response.done', () => {
    expect(
      extractRealtimeTurnUsage({
        type: 'response.done',
        response: { usage: { input_tokens: 320, output_tokens: 210 } },
      }),
    ).toEqual({ inputTokens: 320, outputTokens: 210 });
  });

  it('accepts camelCase usage if the event already has it', () => {
    expect(
      extractRealtimeTurnUsage({
        type: 'response.done',
        response: { usage: { inputTokens: 10, outputTokens: 4 } },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it('returns null when usage is absent or incomplete', () => {
    expect(extractRealtimeTurnUsage({ type: 'response.done' })).toBeNull();
    expect(extractRealtimeTurnUsage({ type: 'response.done', response: { usage: { input_tokens: 1 } } })).toBeNull();
  });
});

describe('reportRealtimeTurn', () => {
  it('does not fetch when the telemetry token is null (observability off)', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    reportRealtimeTurn(null, COMPLETE_TURN);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the turn with the bearer token and same-origin credentials', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    reportRealtimeTurn('tok_test', COMPLETE_TURN);

    expect(fetchMock).toHaveBeenCalledWith(TELEMETRY_REALTIME_TURN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok_test',
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(buildRealtimeTurnPayload(COMPLETE_TURN)),
    });
  });

  it('swallows a network rejection without throwing', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    expect(() => reportRealtimeTurn('tok_test', COMPLETE_TURN)).not.toThrow();
  });
});
