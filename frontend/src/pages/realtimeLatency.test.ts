import { describe, expect, it } from 'vitest';
import { EMPTY_REALTIME_LATENCY, onResponseAudioTranscriptDelta, onSpeechStopped } from './realtimeLatency';

describe('onSpeechStopped / onResponseAudioTranscriptDelta', () => {
  it('has no measurement before the first turn', () => {
    expect(EMPTY_REALTIME_LATENCY.endToEndMs).toBeNull();
  });

  it('computes end-to-end latency as time from speech_stopped to the first transcript delta after it', () => {
    let state = onSpeechStopped(EMPTY_REALTIME_LATENCY, 1_000);
    state = onResponseAudioTranscriptDelta(state, 1_420);

    expect(state.endToEndMs).toBe(420);
  });

  it('does not overwrite the measurement on later deltas from the same response', () => {
    let state = onSpeechStopped(EMPTY_REALTIME_LATENCY, 1_000);
    state = onResponseAudioTranscriptDelta(state, 1_420); // first delta
    state = onResponseAudioTranscriptDelta(state, 1_900); // response keeps streaming in

    expect(state.endToEndMs).toBe(420);
  });

  it('ignores a transcript delta with no preceding speech_stopped (e.g. an initial greeting)', () => {
    const state = onResponseAudioTranscriptDelta(EMPTY_REALTIME_LATENCY, 1_420);
    expect(state.endToEndMs).toBeNull();
    expect(state.speechStoppedAt).toBeNull();
  });

  it('resets the measurement to null at the start of the next turn', () => {
    let state = onSpeechStopped(EMPTY_REALTIME_LATENCY, 1_000);
    state = onResponseAudioTranscriptDelta(state, 1_420);
    expect(state.endToEndMs).toBe(420);

    state = onSpeechStopped(state, 5_000); // next turn begins
    expect(state.endToEndMs).toBeNull();
    expect(state.speechStoppedAt).toBe(5_000);

    state = onResponseAudioTranscriptDelta(state, 5_300);
    expect(state.endToEndMs).toBe(300);
  });
});
