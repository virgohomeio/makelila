import { describe, it, expect } from 'vitest';
import { returnTeamCounts } from './postShipment';

describe('returnTeamCounts', () => {
  it('maps categories to teams, orders by RETURN_TEAMS, drops empty teams', () => {
    const rows = [
      { return_category: 'product_defect' as const },
      { return_category: 'product_defect' as const },
      { return_category: 'software_issue' as const },
      { return_category: 'financing' as const },
    ];
    expect(returnTeamCounts(rows)).toEqual([
      { label: 'Engineering', value: 2 },
      { label: 'Software', value: 1 },
      { label: 'Finance', value: 1 },
    ]);
  });

  it('counts null and "other" categories as Unassigned', () => {
    const rows = [
      { return_category: null },
      { return_category: 'other' as const },
    ];
    expect(returnTeamCounts(rows)).toEqual([
      { label: 'Unassigned', value: 2 },
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(returnTeamCounts([])).toEqual([]);
  });
});
