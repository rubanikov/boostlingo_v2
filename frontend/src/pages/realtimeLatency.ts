/**
 * Client-side, per-turn latency tracking for Realtime mode (ticket 06).
 * Realtime has no server-side visibility once the ephemeral token is issued
 * (ticket 03), so this measures a single browser-observable proxy
 * end-to-end: `input_audio_buffer.speech_stopped` (the user stopped
 * talking) to the *first* `response.output_audio_transcript.delta` after
 * it (the model's response has started streaming back).
 *
 * Limitation, documented rather than hidden: there is no direct
 * browser-observable event for "the WebRTC remote audio track is now
 * audible" on a continuous media stream, so the first transcript delta is
 * used as a reasonable proxy for playback start; it is not a precise
 * measurement of when audio actually reached the speakers.
 */
export interface RealtimeLatencyState {
  /** `Date.now()` of the current turn's `speech_stopped`, or `null` before the first turn. */
  speechStoppedAt: number | null;
  /** ms from that `speech_stopped` to the first transcript delta after it, or `null` until that arrives (or once a new turn starts). */
  endToEndMs: number | null;
}

export const EMPTY_REALTIME_LATENCY: RealtimeLatencyState = {
  speechStoppedAt: null,
  endToEndMs: null,
};

/** Starts a new turn: records the speech-end reference point and clears the previous turn's measurement. */
export function onSpeechStopped(_state: RealtimeLatencyState, now: number): RealtimeLatencyState {
  return { speechStoppedAt: now, endToEndMs: null };
}

/**
 * Records the end-to-end latency on the *first* response transcript delta
 * after the current turn's `speech_stopped`; later deltas from the same
 * response (it keeps streaming in) don't overwrite an already-measured
 * turn. A delta with no preceding `speech_stopped` (e.g. an initial
 * greeting) is ignored, since there is no reference point to measure from.
 */
export function onResponseAudioTranscriptDelta(state: RealtimeLatencyState, now: number): RealtimeLatencyState {
  if (state.speechStoppedAt === null || state.endToEndMs !== null) return state;
  return { ...state, endToEndMs: now - state.speechStoppedAt };
}
