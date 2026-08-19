/**
 * Pure logic for ticket 05's Cascade LLM-hybrid segmentation upgrade:
 * resolving the dev-facing `?segMode=` query-param override sent in
 * `start_session`, and labeling an incoming `segment_boundary` message's
 * `trigger` for display. Kept independent of the WebSocket/React state in
 * useCascadeSession.ts so both are testable without a live socket. Same
 * split as cascadeResilience.ts and latencyTracking.ts.
 */

/**
 * The one non-default segmentation mode the query-param toggle can select.
 * The backend also accepts (and defaults to) `"hybrid"`, but there's nothing
 * for the frontend to do with that value. See `resolveSegmentationModeOverride`.
 */
export type SegmentationModeOverride = 'llm_priority';

const SEGMENTATION_MODE_PARAM = 'segMode';

/**
 * Reads the dev-facing `?segMode=llm_priority` override (ticket 05: "a
 * dev-facing toggle/query-param for segmentation mode is sufficient") from a
 * URL query string, e.g. `window.location.search`. Anything else (the param
 * absent, misspelled, or set to any other value including `"hybrid"`)
 * resolves to `undefined`, so the caller can omit `segmentationMode` from
 * `start_session` entirely and let the backend's own `"hybrid"` default
 * apply, exactly as the wire contract intends.
 */
export function resolveSegmentationModeOverride(search: string): SegmentationModeOverride | undefined {
  const value = new URLSearchParams(search).get(SEGMENTATION_MODE_PARAM);
  return value === 'llm_priority' ? 'llm_priority' : undefined;
}

// Short display label for a `segment_boundary` message's `trigger` field.
// This ticket's whole point is making the hybrid-race and LLM-priority
// mechanisms comparable at a glance for the write-up. Both current Deepgram
// signals collapse to the same "pause" label (either way, the segment ended
// because the speaker stopped, not because the LLM judged the clause
// complete); any trigger value the server sends that isn't recognized here
// (today or after a future backend change) passes through unlabeled rather
// than being dropped.
const TRIGGER_LABELS: Record<string, string> = {
  llm: 'llm',
  deepgram_speech_final: 'pause',
  deepgram_utterance_end: 'pause',
  // ticket 07: the partial in flight when a live tuning change reopened the
  // Deepgram connection. Not a pause and not an LLM decision: the segment ended
  // because the configuration did, and the hybrid-vs-LLM-priority comparison
  // depends on telling those apart.
  tuning_reconnect: 'reconfig',
};

export function segmentTriggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}
