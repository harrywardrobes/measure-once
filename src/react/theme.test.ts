import { describe, it, expect } from 'vitest';
import { CALENDAR_EVENT_COLORS } from './theme';

describe('CALENDAR_EVENT_COLORS token guards', () => {
  it('design colour is #3b82f6', () => {
    expect(CALENDAR_EVENT_COLORS.design.color).toBe('#3b82f6');
  });

  it('survey colour is #f59e0b', () => {
    expect(CALENDAR_EVENT_COLORS.survey.color).toBe('#f59e0b');
  });

  it('installation colour is #10b981', () => {
    expect(CALENDAR_EVENT_COLORS.installation.color).toBe('#10b981');
  });

  it('remedial colour is #ef4444', () => {
    expect(CALENDAR_EVENT_COLORS.remedial.color).toBe('#ef4444');
  });

  it('workshop colour is #8b5cf6', () => {
    expect(CALENDAR_EVENT_COLORS.workshop.color).toBe('#8b5cf6');
  });

  it('other colour is #6b7280 (NEUTRAL_COLORS[500])', () => {
    expect(CALENDAR_EVENT_COLORS.other.color).toBe('#6b7280');
  });
});
