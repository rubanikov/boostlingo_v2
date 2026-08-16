import { describe, expect, it } from 'vitest';
import { resolveSegmentationModeOverride, segmentTriggerLabel } from './segmentation';

describe('resolveSegmentationModeOverride', () => {
  it('resolves "llm_priority" when ?segMode=llm_priority is present', () => {
    expect(resolveSegmentationModeOverride('?segMode=llm_priority')).toBe('llm_priority');
  });

  it('resolves "llm_priority" alongside other unrelated query params', () => {
    expect(resolveSegmentationModeOverride('?foo=bar&segMode=llm_priority')).toBe('llm_priority');
  });

  it('resolves undefined when the param is absent', () => {
    expect(resolveSegmentationModeOverride('')).toBeUndefined();
  });

  it('resolves undefined for the explicit default value "hybrid"', () => {
    expect(resolveSegmentationModeOverride('?segMode=hybrid')).toBeUndefined();
  });

  it('resolves undefined for an unrecognized value, rather than passing it through', () => {
    expect(resolveSegmentationModeOverride('?segMode=bogus')).toBeUndefined();
  });
});

describe('segmentTriggerLabel', () => {
  it('labels "llm" as "llm"', () => {
    expect(segmentTriggerLabel('llm')).toBe('llm');
  });

  it('labels both Deepgram signals as "pause"', () => {
    expect(segmentTriggerLabel('deepgram_speech_final')).toBe('pause');
    expect(segmentTriggerLabel('deepgram_utterance_end')).toBe('pause');
  });

  it('labels the live-tuning reconnect cut as "reconfig", distinct from a pause (E6, ticket 07)', () => {
    expect(segmentTriggerLabel('tuning_reconnect')).toBe('reconfig');
  });

  it('passes an unrecognized trigger value through unchanged, rather than dropping it', () => {
    expect(segmentTriggerLabel('some_future_trigger')).toBe('some_future_trigger');
  });
});
