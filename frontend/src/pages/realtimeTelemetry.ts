import { TELEMETRY_REALTIME_TURN_ENDPOINT } from './realtimeConfig';

export interface RealtimeTurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RealtimeTurnInput {
  turnIndex: number;
  speechStoppedAt: number | null;
  endToEndMs: number | null;
  sourceText?: string | null;
  targetText?: string | null;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  model?: string | null;
  usage?: RealtimeTurnUsage | null;
  error?: string | null;
}

export interface RealtimeTurnPayload {
  turnIndex: number;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  sourceText?: string;
  targetText?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  model?: string;
  usage?: RealtimeTurnUsage;
  error?: string;
}

/**
 * Builds the ingest body from the timestamps `realtimeLatency.ts` already
 * captured (`speech_stopped` → first `output_audio_transcript.delta`).
 * Returns null when that pair isn't available; we don't invent a second clock.
 */
export function buildRealtimeTurnPayload(input: RealtimeTurnInput): RealtimeTurnPayload | null {
  if (input.speechStoppedAt === null || input.endToEndMs === null) {
    return null;
  }

  const payload: RealtimeTurnPayload = {
    turnIndex: input.turnIndex,
    startedAt: new Date(input.speechStoppedAt).toISOString(),
    endedAt: new Date(input.speechStoppedAt + input.endToEndMs).toISOString(),
    latencyMs: input.endToEndMs,
  };

  if (input.sourceText) payload.sourceText = input.sourceText;
  if (input.targetText) payload.targetText = input.targetText;
  if (input.sourceLanguage) payload.sourceLanguage = input.sourceLanguage;
  if (input.targetLanguage) payload.targetLanguage = input.targetLanguage;
  if (input.model) payload.model = input.model;
  if (input.usage) payload.usage = input.usage;
  if (input.error) payload.error = input.error;

  return payload;
}

function readTokenCount(usage: Record<string, unknown>, camel: string, snake: string): number | null {
  const value = usage[camel] ?? usage[snake];
  return typeof value === 'number' ? value : null;
}

/** Pulls `{ inputTokens, outputTokens }` off a `response.done` event when present. */
export function extractRealtimeTurnUsage(event: unknown): RealtimeTurnUsage | null {
  if (typeof event !== 'object' || event === null || !('response' in event)) {
    return null;
  }
  const response = (event as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null || !('usage' in response)) {
    return null;
  }
  const usage = (response as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }

  const record = usage as Record<string, unknown>;
  const inputTokens = readTokenCount(record, 'inputTokens', 'input_tokens');
  const outputTokens = readTokenCount(record, 'outputTokens', 'output_tokens');
  if (inputTokens === null || outputTokens === null) {
    return null;
  }
  return { inputTokens, outputTokens };
}

/**
 * Fire-and-forget POST of one completed turn. Never throws, never touches
 * session status. 401/413/429/network/off are all silent drops; a
 * `console.debug` is the loudest this is allowed to get.
 */
export function reportRealtimeTurn(token: string | null | undefined, input: RealtimeTurnInput): void {
  if (!token) {
    return;
  }

  const payload = buildRealtimeTurnPayload(input);
  if (!payload) {
    return;
  }

  void fetch(TELEMETRY_REALTIME_TURN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  }).catch((err: unknown) => {
    console.debug('Realtime telemetry: turn ingest failed.', err);
  });
}
