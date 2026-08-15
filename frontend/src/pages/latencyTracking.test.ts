import { describe, expect, it } from 'vitest';
import {
  EMPTY_CASCADE_LATENCY,
  currentCascadeLatency,
  isLatencyStage,
  latencyBadges,
  recordLatencyStage,
} from './latencyTracking';

describe('recordLatencyStage / currentCascadeLatency', () => {
  it('has no current segment before any stage has arrived', () => {
    expect(currentCascadeLatency(EMPTY_CASCADE_LATENCY)).toBeNull();
  });

  it('does not surface a segment as current until its playback_start stage arrives', () => {
    const state = recordLatencyStage(EMPTY_CASCADE_LATENCY, { segmentId: 's1', stage: 'speech_end', ms: 0 });
    expect(currentCascadeLatency(state)).toBeNull();
  });

  it('becomes the current segment the moment playback_start arrives, carrying every stage seen so far', () => {
    let state = recordLatencyStage(EMPTY_CASCADE_LATENCY, { segmentId: 's1', stage: 'speech_end', ms: 0 });
    state = recordLatencyStage(state, { segmentId: 's1', stage: 'translation_first_token', ms: 150 });
    state = recordLatencyStage(state, { segmentId: 's1', stage: 'playback_start', ms: 650 });

    expect(currentCascadeLatency(state)).toEqual({
      segmentId: 's1',
      stages: { speech_end: 0, translation_first_token: 150, playback_start: 650 },
    });
  });

  it('switches the current segment to whichever one most recently completed', () => {
    let state = recordLatencyStage(EMPTY_CASCADE_LATENCY, { segmentId: 's1', stage: 'playback_start', ms: 650 });
    state = recordLatencyStage(state, { segmentId: 's2', stage: 'speech_end', ms: 0 });
    expect(currentCascadeLatency(state)?.segmentId).toBe('s1'); // s2 hasn't completed yet

    state = recordLatencyStage(state, { segmentId: 's2', stage: 'playback_start', ms: 500 });
    expect(currentCascadeLatency(state)).toEqual({ segmentId: 's2', stages: { speech_end: 0, playback_start: 500 } });
  });

  it('keeps each segment its own independent stage table', () => {
    let state = recordLatencyStage(EMPTY_CASCADE_LATENCY, { segmentId: 's1', stage: 'speech_end', ms: 0 });
    state = recordLatencyStage(state, { segmentId: 's2', stage: 'speech_end', ms: 0 });
    state = recordLatencyStage(state, { segmentId: 's1', stage: 'translation_first_token', ms: 100 });

    expect(state.bySegment.s1).toEqual({ speech_end: 0, translation_first_token: 100 });
    expect(state.bySegment.s2).toEqual({ speech_end: 0 });
  });
});

describe('isLatencyStage', () => {
  it('accepts every known stage', () => {
    for (const stage of ['stt_final', 'speech_end', 'translation_first_token', 'translation_complete', 'tts_first_byte', 'playback_start']) {
      expect(isLatencyStage(stage)).toBe(true);
    }
  });

  it('rejects an unrecognized stage', () => {
    expect(isLatencyStage('bogus_stage')).toBe(false);
  });
});

describe('latencyBadges', () => {
  it('returns one badge per stage that has arrived, in stage order, skipping gaps', () => {
    const badges = latencyBadges({ speech_end: 0, tts_first_byte: 600, playback_start: 650 });
    expect(badges.map((b) => b.stage)).toEqual(['speech_end', 'tts_first_byte', 'playback_start']);
  });

  it('always highlights playback_start as primary', () => {
    const badges = latencyBadges({ speech_end: 0, playback_start: 650 });
    const playback = badges.find((b) => b.stage === 'playback_start');
    expect(playback?.tone).toBe('primary');
  });

  it('flags the stage with the biggest inter-stage jump as the bottleneck (warning), matching the approved prototype', () => {
    // Prototype numbers (.lavish/ticket-09-ui-ux-layout.html lines 79-87):
    // 0 -> 150 -> 400 -> 600 -> 650; biggest jump is 150->400 (250ms), on translation_complete.
    const badges = latencyBadges({
      speech_end: 0,
      translation_first_token: 150,
      translation_complete: 400,
      tts_first_byte: 600,
      playback_start: 650,
    });

    const byStage = Object.fromEntries(badges.map((b) => [b.stage, b]));
    expect(byStage.translation_complete.tone).toBe('warning');
    expect(byStage.speech_end.tone).toBe('ghost');
    expect(byStage.translation_first_token.tone).toBe('ghost');
    expect(byStage.tts_first_byte.tone).toBe('ghost');
    expect(byStage.playback_start.tone).toBe('primary');
  });

  it('produces a human-readable label and ms value for each badge', () => {
    // Only one interior stage present, so it's also (trivially) the biggest
    // jump — hence 'warning', not 'ghost'. See the dedicated bottleneck test
    // above for a case with more than one candidate.
    const badges = latencyBadges({ speech_end: 0, translation_first_token: 150 });
    expect(badges).toEqual([
      { stage: 'speech_end', label: 'speech end', ms: 0, tone: 'ghost' },
      { stage: 'translation_first_token', label: 'translation', ms: 150, tone: 'warning' },
    ]);
  });

  it('returns an empty list for a segment with no stages recorded', () => {
    expect(latencyBadges({})).toEqual([]);
  });

  it('orders stt_final before the speech_end reference point', () => {
    const badges = latencyBadges({ stt_final: 480, speech_end: 0, playback_start: 650 });
    expect(badges.map((b) => b.stage)).toEqual(['stt_final', 'speech_end', 'playback_start']);
    expect(badges[0].label).toBe('STT finalize');
  });

  it('lets stt_final win the bottleneck flag with its own standalone duration', () => {
    // stt_final is a pre-reference duration (480ms waiting on the
    // segmentation decision), bigger than any later inter-stage jump.
    const badges = latencyBadges({
      stt_final: 480,
      speech_end: 0,
      translation_first_token: 150,
      translation_complete: 400,
      tts_first_byte: 600,
      playback_start: 650,
    });

    const byStage = Object.fromEntries(badges.map((b) => [b.stage, b]));
    expect(byStage.stt_final.tone).toBe('warning');
    expect(byStage.speech_end.tone).toBe('ghost');
    expect(byStage.translation_complete.tone).toBe('ghost');
    expect(byStage.playback_start.tone).toBe('primary');
  });

  it('never flags speech_end as the bottleneck even when stt_final precedes it', () => {
    const badges = latencyBadges({ stt_final: 5, speech_end: 0, translation_first_token: 150 });
    const byStage = Object.fromEntries(badges.map((b) => [b.stage, b]));
    expect(byStage.speech_end.tone).toBe('ghost');
    expect(byStage.translation_first_token.tone).toBe('warning');
  });
});
