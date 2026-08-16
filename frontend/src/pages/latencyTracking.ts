import type { CascadeSegmentLatency, LatencyStage } from './sessionHandle';

export type { CascadeSegmentLatency, LatencyStage } from './sessionHandle';

/** One incoming `latency` server message (ticket 06's Cascade WS contract). */
export interface LatencyStageEvent {
  segmentId: string;
  stage: LatencyStage;
  ms: number;
}

/**
 * Ordered stage sequence, matching the brief's cumulative-ms-since-`speech_end`
 * contract. `stt_final` is the one pre-reference stage: it happened *before*
 * `speech_end` and its `ms` is a standalone duration (final transcript →
 * segmentation cut), not cumulative — see `sessionHandle.LatencyStage`.
 */
export const LATENCY_STAGES: LatencyStage[] = [
  'stt_final',
  'speech_end',
  'transcript_check',
  'translation_first_token',
  'translation_complete',
  'tts_first_byte',
  'playback_start',
];

const LATENCY_STAGE_SET = new Set<string>(LATENCY_STAGES);

/** Narrows an arbitrary server-supplied string to a known `LatencyStage`, so an unrecognized stage is dropped rather than corrupting the per-segment table. */
export function isLatencyStage(value: string): value is LatencyStage {
  return LATENCY_STAGE_SET.has(value);
}

/**
 * Running latency state across a Cascade session: every segment's stages
 * seen so far, plus which segment most recently *completed* (its
 * `playback_start` stage arrived).
 */
export interface CascadeLatencyState {
  bySegment: Record<string, Partial<Record<LatencyStage, number>>>;
  mostRecentCompletedSegmentId: string | null;
}

export const EMPTY_CASCADE_LATENCY: CascadeLatencyState = {
  bySegment: {},
  mostRecentCompletedSegmentId: null,
};

/**
 * Accumulates one incoming `latency` stage event into the per-segment table.
 * A segment becomes the "most recently completed" one the moment its
 * `playback_start` stage arrives: the workbench strip displays that
 * segment until the next one completes (see `currentCascadeLatency`).
 */
export function recordLatencyStage(state: CascadeLatencyState, event: LatencyStageEvent): CascadeLatencyState {
  const stages = { ...state.bySegment[event.segmentId], [event.stage]: event.ms };
  const bySegment = { ...state.bySegment, [event.segmentId]: stages };
  const mostRecentCompletedSegmentId =
    event.stage === 'playback_start' ? event.segmentId : state.mostRecentCompletedSegmentId;
  return { bySegment, mostRecentCompletedSegmentId };
}

/** The segment the latency strip should currently display, or `null` before any segment has completed. */
export function currentCascadeLatency(state: CascadeLatencyState): CascadeSegmentLatency | null {
  const { mostRecentCompletedSegmentId } = state;
  if (mostRecentCompletedSegmentId === null) return null;
  return { segmentId: mostRecentCompletedSegmentId, stages: state.bySegment[mostRecentCompletedSegmentId] ?? {} };
}

export type LatencyBadgeTone = 'ghost' | 'warning' | 'primary';

export interface LatencyBadge {
  stage: LatencyStage;
  label: string;
  ms: number;
  tone: LatencyBadgeTone;
}

const STAGE_LABELS: Record<LatencyStage, string> = {
  stt_final: 'STT finalize',
  speech_end: 'speech end',
  transcript_check: 'check',
  translation_first_token: 'translation',
  translation_complete: 'translation done',
  tts_first_byte: 'TTS first byte',
  playback_start: 'playback',
};

/**
 * Builds the ordered badge list for the latency strip: one badge per stage
 * that's actually arrived (a segment that was silent/never translated
 * simply never gets its later-stage messages, so this skips the gap rather
 * than showing a fake 0ms), `playback_start` always highlighted as the
 * final benchmark number, and whichever stage contributed the biggest ms
 * jump from its predecessor flagged as the likely bottleneck, per brief
 * FR7's "biggest inter-stage delta visually flags the bottleneck".
 */
export function latencyBadges(stages: Partial<Record<LatencyStage, number>>): LatencyBadge[] {
  const present = LATENCY_STAGES.filter((stage) => stages[stage] !== undefined);

  let bottleneckStage: LatencyStage | null = null;
  let biggestDelta = -Infinity;
  present.forEach((stage, index) => {
    if (stage === 'speech_end') return; // the 0ms reference point, not itself a candidate bottleneck
    // `stt_final` is a standalone pre-reference duration, so it competes
    // with its own ms; every later stage competes with its jump over the
    // previous cumulative stage.
    const delta =
      stage === 'stt_final'
        ? (stages[stage] ?? 0)
        : (stages[stage] ?? 0) - (index > 0 ? (stages[present[index - 1]] ?? 0) : 0);
    if (delta > biggestDelta) {
      biggestDelta = delta;
      bottleneckStage = stage;
    }
  });

  return present.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    ms: stages[stage] ?? 0,
    tone: stage === 'playback_start' ? 'primary' : stage === bottleneckStage ? 'warning' : 'ghost',
  }));
}
