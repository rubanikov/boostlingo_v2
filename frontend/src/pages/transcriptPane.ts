import type { TranscriptSegment } from './sessionHandle';

export type { TranscriptSegment } from './sessionHandle';

/** One incoming `source_transcript` / `target_transcript` server message. */
export interface TranscriptSegmentEvent {
  segmentId: string;
  text: string;
  /** Diarized speaker index, `null` if diarization ran but found none, or omitted entirely by transports/messages that don't carry it. */
  speaker?: number | null;
}

/** Running state of a single transcript block (source or target): an ordered list of segments. */
export interface TranscriptPaneState {
  segments: TranscriptSegment[];
  lastTextBySegment: Record<string, string>;
}

export const EMPTY_TRANSCRIPT_PANE: TranscriptPaneState = {
  segments: [],
  lastTextBySegment: {},
};

/**
 * Appends an incoming transcript update to a pane's segment list.
 *
 * STT/translation providers differ in whether repeated updates for the same
 * segment resend the *whole* text-so-far (Deepgram-style interim results) or
 * just the newly produced chunk (token-by-token streaming). This diffs the
 * incoming text against the segment's last known text and appends only the
 * suffix that's actually new, so both styles render as smooth incremental
 * text without duplicated words either way.
 *
 * A segment's `speaker` is set from the first message that names one and
 * kept on later updates that omit it (interim updates for the same segment
 * aren't expected to change speaker mid-stream); an update that names a
 * different (or null) speaker overwrites it.
 */
export function appendTranscriptSegment(
  state: TranscriptPaneState,
  event: TranscriptSegmentEvent,
): TranscriptPaneState {
  const isNewSegment = !(event.segmentId in state.lastTextBySegment);
  const previousText = state.lastTextBySegment[event.segmentId] ?? '';
  const delta = event.text.startsWith(previousText) ? event.text.slice(previousText.length) : event.text;

  if (delta === '' && !isNewSegment) {
    return state;
  }

  const lastTextBySegment = { ...state.lastTextBySegment, [event.segmentId]: event.text };

  if (isNewSegment) {
    const segment: TranscriptSegment = { id: event.segmentId, text: delta, speaker: event.speaker ?? null };
    return { segments: [...state.segments, segment], lastTextBySegment };
  }

  const segments = state.segments.map((segment) =>
    segment.id === event.segmentId
      ? { ...segment, text: segment.text + delta, speaker: event.speaker === undefined ? segment.speaker : event.speaker }
      : segment,
  );
  return { segments, lastTextBySegment };
}

/** A `source_transcript` re-sent for an already-final segment carrying the transcript check's verdict (ticket 14). */
export interface TranscriptCheckEvent {
  segmentId: string;
  /** The text the check settled on: the original in `flag` mode, the rewrite in `correct` mode. */
  text: string;
  flagged: boolean;
  /** Only in `correct` mode: the text as first transcribed, before the rewrite. */
  correctedFrom?: string;
  speaker?: number | null;
}

/**
 * Merges a transcript-check verdict into the segment it is about, by
 * `segmentId`, so a checked segment never renders twice.
 *
 * Not `appendTranscriptSegment`, which does the opposite: a re-send in `flag`
 * mode repeats text the pane already has (that diffs to an empty delta and is
 * dropped), and one in `correct` mode carries a replacement for it (that would
 * be concatenated onto the original). Here `text` always replaces, because the
 * check re-sends the whole final segment either way.
 *
 * A verdict for a segment the pane has never seen is rendered rather than
 * dropped: the text is the same text the segment would have had.
 */
export function applyTranscriptCheck(
  state: TranscriptPaneState,
  event: TranscriptCheckEvent,
): TranscriptPaneState {
  const checked = (segment: TranscriptSegment): TranscriptSegment => ({
    ...segment,
    text: event.text,
    flagged: event.flagged,
    ...(event.correctedFrom === undefined ? {} : { correctedFrom: event.correctedFrom }),
  });

  const lastTextBySegment = { ...state.lastTextBySegment, [event.segmentId]: event.text };

  if (!(event.segmentId in state.lastTextBySegment)) {
    const segment = checked({ id: event.segmentId, text: event.text, speaker: event.speaker ?? null });
    return { segments: [...state.segments, segment], lastTextBySegment };
  }

  const segments = state.segments.map((segment) => (segment.id === event.segmentId ? checked(segment) : segment));
  return { segments, lastTextBySegment };
}

/**
 * Flattens a pane's segments into a single display string, space-separating
 * segments: the same join `appendTranscriptSegment` produced when it
 * tracked one flat string directly. Segments with no text (e.g. an empty
 * final result) contribute no text and no separator.
 */
export function paneText(state: TranscriptPaneState): string {
  return state.segments
    .map((segment) => segment.text)
    .filter((text) => text.length > 0)
    .join(' ');
}
