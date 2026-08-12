import { describe, expect, it } from 'vitest';
import { EMPTY_TRANSCRIPT_PANE, appendTranscriptSegment, paneText } from './transcriptPane';

describe('appendTranscriptSegment', () => {
  it('appends the first message for a segment with no leading separator', () => {
    const next = appendTranscriptSegment(EMPTY_TRANSCRIPT_PANE, { segmentId: 'a', text: 'Hello' });
    expect(paneText(next)).toBe('Hello');
  });

  it('appends only the new suffix for cumulative (Deepgram-style) interim updates', () => {
    let state = EMPTY_TRANSCRIPT_PANE;
    state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hello' });
    state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hello there' });
    state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hello there, how are you' });

    expect(paneText(state)).toBe('Hello there, how are you');
  });

  it('appends each chunk directly for token-by-token (non-extending) delta updates', () => {
    let state = EMPTY_TRANSCRIPT_PANE;
    state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hola' });
    state = appendTranscriptSegment(state, { segmentId: 'a', text: ', ' });
    state = appendTranscriptSegment(state, { segmentId: 'a', text: 'como estas' });

    expect(paneText(state)).toBe('Hola, como estas');
  });

  it('separates a new segment from prior text with a single space', () => {
    let state = EMPTY_TRANSCRIPT_PANE;
    state = appendTranscriptSegment(state, { segmentId: 'a', text: 'First segment.' });
    state = appendTranscriptSegment(state, { segmentId: 'b', text: 'Second segment.' });

    expect(paneText(state)).toBe('First segment. Second segment.');
  });

  it('tracks segment order and per-segment last text', () => {
    let state = EMPTY_TRANSCRIPT_PANE;
    state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hi' });
    state = appendTranscriptSegment(state, { segmentId: 'b', text: 'Bye' });

    expect(state.segments.map((segment) => segment.id)).toEqual(['a', 'b']);
    expect(state.lastTextBySegment).toEqual({ a: 'Hi', b: 'Bye' });
  });

  it('handles an empty final result without changing the visible text', () => {
    const next = appendTranscriptSegment(EMPTY_TRANSCRIPT_PANE, { segmentId: 'a', text: '' });
    expect(paneText(next)).toBe('');
    expect(next.segments.map((segment) => segment.id)).toEqual(['a']);
  });

  it('returns the same state reference when a repeated update carries no new text', () => {
    const first = appendTranscriptSegment(EMPTY_TRANSCRIPT_PANE, { segmentId: 'a', text: 'Hello' });
    const second = appendTranscriptSegment(first, { segmentId: 'a', text: 'Hello' });

    expect(second).toBe(first);
  });

  it('does not introduce a stray separator around a segment with no text', () => {
    let state = EMPTY_TRANSCRIPT_PANE;
    state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hi' });
    state = appendTranscriptSegment(state, { segmentId: 'b', text: '' });
    state = appendTranscriptSegment(state, { segmentId: 'c', text: 'Bye' });

    expect(paneText(state)).toBe('Hi Bye');
  });

  describe('speaker (diarization, ticket 04)', () => {
    it('defaults an unspecified speaker to null', () => {
      const next = appendTranscriptSegment(EMPTY_TRANSCRIPT_PANE, { segmentId: 'a', text: 'Hello' });
      expect(next.segments[0]).toMatchObject({ speaker: null });
    });

    it('records the speaker given on a new segment', () => {
      const next = appendTranscriptSegment(EMPTY_TRANSCRIPT_PANE, { segmentId: 'a', text: 'Hello', speaker: 0 });
      expect(next.segments[0]).toEqual({ id: 'a', text: 'Hello', speaker: 0 });
    });

    it('keeps each segment its own speaker across two alternating speakers', () => {
      let state = EMPTY_TRANSCRIPT_PANE;
      state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hi there', speaker: 0 });
      state = appendTranscriptSegment(state, { segmentId: 'b', text: 'Hola', speaker: 1 });

      expect(state.segments).toEqual([
        { id: 'a', text: 'Hi there', speaker: 0 },
        { id: 'b', text: 'Hola', speaker: 1 },
      ]);
    });

    it("preserves a segment's known speaker when a later update for it omits the field", () => {
      let state = EMPTY_TRANSCRIPT_PANE;
      state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hello', speaker: 0 });
      state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hello world' });

      expect(state.segments[0]).toEqual({ id: 'a', text: 'Hello world', speaker: 0 });
    });

    it("updates a segment's speaker when a later message names a different one", () => {
      let state = EMPTY_TRANSCRIPT_PANE;
      state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hello', speaker: 0 });
      state = appendTranscriptSegment(state, { segmentId: 'a', text: 'Hello world', speaker: null });

      expect(state.segments[0]).toEqual({ id: 'a', text: 'Hello world', speaker: null });
    });
  });
});
