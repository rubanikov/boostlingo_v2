import { describe, expect, it } from 'vitest';
import { decideResume, routeCascadeError } from './cascadeResilience';

describe('routeCascadeError', () => {
  it('routes a retryable stt/translation/tts failure to a toast, carrying the server message verbatim', () => {
    expect(
      routeCascadeError({ provider: 'stt', kind: 'rate_limit', message: 'Deepgram rate limited', retryable: true }),
    ).toEqual({ kind: 'toast', message: 'Deepgram rate limited' });
    expect(
      routeCascadeError({ provider: 'translation', kind: 'timeout', message: 'Translation timed out', retryable: true }),
    ).toEqual({ kind: 'toast', message: 'Translation timed out' });
    expect(
      routeCascadeError({ provider: 'tts', kind: 'connection', message: 'ElevenLabs connection dropped', retryable: true }),
    ).toEqual({ kind: 'toast', message: 'ElevenLabs connection dropped' });
  });

  it('routes a circuit_open failure to the terminal state, headlined "Interpretation unavailable"', () => {
    expect(
      routeCascadeError({
        provider: 'orchestrator',
        kind: 'circuit_open',
        message: '5 consecutive segment failures',
        retryable: false,
      }),
    ).toEqual({ kind: 'terminal', message: 'Interpretation unavailable — 5 consecutive segment failures' });
  });

  it('routes a not_found (resume failed) failure to the terminal state, headlined "Session ended"', () => {
    expect(
      routeCascadeError({ provider: 'session', kind: 'not_found', message: 'Unknown session', retryable: false }),
    ).toEqual({ kind: 'terminal', message: 'Session ended — Unknown session' });
  });

  it('falls back to a generic "Session ended" headline for an unrecognized non-retryable kind, rather than dropping it', () => {
    expect(routeCascadeError({ provider: 'orchestrator', kind: 'unknown', message: 'Something broke', retryable: false })).toEqual(
      { kind: 'terminal', message: 'Session ended — Something broke' },
    );
  });
});

describe('decideResume', () => {
  it('attempts a resume when a sessionId is known and none has been tried yet', () => {
    expect(decideResume({ sessionId: 'abc-123', resumeAttempted: false })).toEqual({
      type: 'attempt',
      sessionId: 'abc-123',
    });
  });

  it('gives up when a resume has already been attempted once, even with a known sessionId', () => {
    const decision = decideResume({ sessionId: 'abc-123', resumeAttempted: true });
    expect(decision.type).toBe('give_up');
  });

  it('gives up when no sessionId was ever stored (dropped before session_started arrived)', () => {
    const decision = decideResume({ sessionId: null, resumeAttempted: false });
    expect(decision.type).toBe('give_up');
  });

  it('never loops: the give_up decision is the same whether the cause is "already tried" or "no session id"', () => {
    // Both give-up paths render the same terminal UI treatment per the brief
    // ("distinct message, same UI treatment is fine") — assert both actually
    // produce a usable, non-empty message rather than diverging structurally.
    const alreadyTried = decideResume({ sessionId: 'abc-123', resumeAttempted: true });
    const noSessionId = decideResume({ sessionId: null, resumeAttempted: false });
    if (alreadyTried.type !== 'give_up' || noSessionId.type !== 'give_up') {
      throw new Error('expected both decisions to give up');
    }
    expect(alreadyTried.message.length).toBeGreaterThan(0);
    expect(noSessionId.message.length).toBeGreaterThan(0);
  });
});
