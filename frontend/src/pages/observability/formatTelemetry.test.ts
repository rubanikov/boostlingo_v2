import { describe, expect, it } from 'vitest';
import {
  formatCompactTokens,
  formatCount,
  formatErrorRate,
  formatMs,
  formatUsd,
} from './formatTelemetry';

describe('formatTelemetry', () => {
  it('renders null numeric fields as an em dash, never as 0', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatUsd(null)).toBe('—');
    expect(formatCount(null)).toBe('—');
    expect(formatErrorRate(null)).toBe('—');
    expect(formatCompactTokens(null)).toBe('—');
  });

  it('formats known latency, cost, rate, and token values from the brief', () => {
    expect(formatMs(145)).toBe('145ms');
    expect(formatMs(1200)).toBe('1.2s');
    expect(formatUsd(1.42)).toBe('$1.42');
    expect(formatUsd(0.04)).toBe('$0.04');
    expect(formatErrorRate(0.002)).toBe('0.2%');
    expect(formatCompactTokens(142000)).toBe('142k tokens');
    expect(formatCount(42)).toBe('42');
  });
});
