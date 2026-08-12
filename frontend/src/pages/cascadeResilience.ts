/**
 * Pure decision logic for Cascade's error/resilience protocol (ticket 07):
 * routing an incoming `error` message to a non-blocking toast versus the
 * blocking terminal state, and deciding whether an unexpectedly-closed
 * WebSocket should attempt one resume or give up. Kept independent of
 * WebSocket/React state so both decisions are testable without a live
 * socket. See useCascadeSession.ts for where these get wired into actual
 * connect/reconnect behavior.
 */

/** One incoming `error` server message (ticket 07's Cascade WS contract). */
export interface CascadeErrorMessage {
  provider: string;
  kind: string;
  message: string;
  retryable: boolean;
}

export type CascadeErrorTreatment = { kind: 'toast'; message: string } | { kind: 'terminal'; message: string };

// Distinct headline per known terminal `kind`, per the brief's "distinct
// message, same UI treatment is fine"; any other non-retryable kind still
// gets a sensible fallback rather than being silently dropped.
const TERMINAL_HEADLINES: Record<string, string> = {
  circuit_open: 'Interpretation unavailable',
  not_found: 'Session ended',
};
const DEFAULT_TERMINAL_HEADLINE = 'Session ended';

/**
 * `retryable: true` (one segment's retries were exhausted and it was
 * dropped, but the session carries on) routes to a toast; `retryable: false`
 * (the circuit breaker tripped, or a resume attempt came back "session not
 * found") routes to the blocking terminal state, headlined by its `kind`.
 */
export function routeCascadeError(error: CascadeErrorMessage): CascadeErrorTreatment {
  if (error.retryable) {
    return { kind: 'toast', message: error.message };
  }
  const headline = TERMINAL_HEADLINES[error.kind] ?? DEFAULT_TERMINAL_HEADLINE;
  return { kind: 'terminal', message: `${headline} — ${error.message}` };
}

/** What's known about the current session's resumability when its WebSocket closes unexpectedly. */
export interface ResumeAttemptState {
  /** The `sessionId` from `session_started`, or `null` if it never arrived before the drop. */
  sessionId: string | null;
  /** Whether a resume has already been attempted once this session. */
  resumeAttempted: boolean;
}

export type ResumeDecision = { type: 'attempt'; sessionId: string } | { type: 'give_up'; message: string };

const NO_SESSION_ID_MESSAGE = 'Session ended. Start a new session to continue.';
const ALREADY_ATTEMPTED_MESSAGE = 'Session ended. Start a new session to continue.';

/**
 * One resume attempt per session, never a loop: gives up immediately if a
 * resume was already tried once this session, or if the drop happened
 * before `session_started` ever gave us a `sessionId` to resume with.
 */
export function decideResume(state: ResumeAttemptState): ResumeDecision {
  if (state.resumeAttempted) {
    return { type: 'give_up', message: ALREADY_ATTEMPTED_MESSAGE };
  }
  if (!state.sessionId) {
    return { type: 'give_up', message: NO_SESSION_ID_MESSAGE };
  }
  return { type: 'attempt', sessionId: state.sessionId };
}
