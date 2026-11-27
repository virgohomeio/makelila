import { describe, it, expect } from 'vitest';
import { buildCampaignGroups, groupMatchesName, type CampaignGroup } from './campaignGroups';
import type { FbCampaign } from './facebook';

// buildCampaignGroups only reads campaign_id + campaign_name, so the fixture is
// deliberately minimal and cast to the full type.
const fb = (campaign_id: string, campaign_name: string): FbCampaign =>
  ({ campaign_id, campaign_name } as FbCampaign);

const groupFor = (groups: CampaignGroup[], key: string) =>
  groups.find(g => g.key === key)!;

describe('buildCampaignGroups — Holiday 2026 vs December Holiday 2025 split', () => {
  // The bug this guards: both seasons' campaigns contain the word "Holiday", so
  // an unqualified /holiday/ on the 2026 group swept last year's five "December
  // Holiday 2025" campaigns' lifetime spend into the 2026 group. The fix keys on
  // the YEAR in the name.
  const campaigns = [
    fb('2026-scale', 'Holiday 2026 - 30 Percent Off - Scale Campaign'),
    fb('2025-v1', 'December Holiday 2025 v1 - 35% Off - Campaign'),
    fb('2025-v2', 'December Holiday 2025 v2 - 35% Off - Campaign - Daily Spend'),
  ];

  it('puts the 2026 campaign in holiday2026 and nothing else', () => {
    const g = buildCampaignGroups(campaigns);
    expect([...groupFor(g, 'holiday2026').ids]).toEqual(['2026-scale']);
  });

  it('puts the 2025 campaigns in december, not holiday2026', () => {
    const g = buildCampaignGroups(campaigns);
    expect([...groupFor(g, 'december').ids].sort()).toEqual(['2025-v1', '2025-v2']);
    expect([...groupFor(g, 'holiday2026').ids]).not.toContain('2025-v1');
  });

  it('pins the Holiday 2026 label to the operator 30% even though names vary', () => {
    const g = buildCampaignGroups(campaigns);
    expect(groupFor(g, 'holiday2026').label).toBe('Holiday 2026 - 30% Off');
  });
});

describe('groupMatchesName — used to filter Google Ads campaigns into a group', () => {
  const holiday2026 = groupFor(buildCampaignGroups([]), 'holiday2026');
  const december = groupFor(buildCampaignGroups([]), 'december');

  it('matches the 2026 Google PMax campaign to holiday2026 only', () => {
    const gName = 'LILA Pro - PMax - Holiday 2026 - 30 Percent Off';
    expect(groupMatchesName(holiday2026, gName)).toBe(true);
    expect(groupMatchesName(december, gName)).toBe(false);
  });

  it('matches a 2025 campaign to december only', () => {
    const name = 'December Holiday 2025 v3 - 35% Off';
    expect(groupMatchesName(december, name)).toBe(true);
    expect(groupMatchesName(holiday2026, name)).toBe(false);
  });

  it('excludes LILA Mini campaigns and null names', () => {
    expect(groupMatchesName(holiday2026, 'Holiday 2026 - Mini - 30% Off')).toBe(false);
    expect(groupMatchesName(holiday2026, null)).toBe(false);
  });
});
