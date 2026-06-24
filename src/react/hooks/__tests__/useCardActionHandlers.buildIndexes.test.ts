import { describe, it, expect } from 'vitest';
import {
  buildIndexes,
  lookupHandlerInIndex,
  type CardActionHandlerData,
} from '../useCardActionHandlers';

describe('buildIndexes / lookupHandlerInIndex', () => {
  const designVisitHandler: CardActionHandlerData = {
    id: 1,
    type: 'start_design_visit',
    bindings: [{ stage_key: 'design_visit', status_key: '' }],
  };

  const globalHandler: CardActionHandlerData = {
    id: 2,
    type: 'contact_customer',
    bindings: [{ stage_key: '__global__', status_key: '' }],
  };

  it('indexes a "design_visit" binding under the underscore-stripped key "designvisit"', () => {
    const { byLabel } = buildIndexes([designVisitHandler]);
    expect(byLabel['designvisit|']).toBe(designVisitHandler);
  });

  it('resolves a "design_visit" stage binding when lookup uses "designvisit"', () => {
    const { byLabel } = buildIndexes([designVisitHandler, globalHandler]);
    const result = lookupHandlerInIndex(byLabel, 'designvisit', undefined);
    expect(result).toBe(designVisitHandler);
    expect(result?.type).toBe('start_design_visit');
  });

  it('does not fall through to the global slot when a specific binding matches', () => {
    const { byLabel } = buildIndexes([designVisitHandler, globalHandler]);
    const result = lookupHandlerInIndex(byLabel, 'designvisit', undefined);
    expect(result?.id).toBe(1);
    expect(result?.id).not.toBe(2);
  });

  it('falls through to the global slot when no specific binding matches', () => {
    const { byLabel } = buildIndexes([designVisitHandler, globalHandler]);
    const result = lookupHandlerInIndex(byLabel, 'surveyvisit', undefined);
    expect(result).toBe(globalHandler);
  });

  it('returns null when no handler matches and no global slot is set', () => {
    const { byLabel } = buildIndexes([designVisitHandler]);
    const result = lookupHandlerInIndex(byLabel, 'surveyvisit', undefined);
    expect(result).toBeNull();
  });
});
