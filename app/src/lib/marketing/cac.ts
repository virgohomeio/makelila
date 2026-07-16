import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { subscribeReload } from './realtime';

export type CacInput = {
  fbSpendByMonth: Array<{ month: string; spend_cad: number }>;
  customersByChannel: Array<{ channel: string; count: number }>;
};

export type CacRow = {
  channel: string;
  spend_cad: number;
  customers_acquired: number;
  cac_cad: number | null;
};

export function computeCac(input: CacInput): CacRow[] {
  const totalFbSpend = input.fbSpendByMonth.reduce((s, r) => s + r.spend_cad, 0);
  const channelMap = new Map<string, number>(
    input.customersByChannel.map(c => [c.channel, c.count]),
  );

  const channels = Array.from(
    new Set([
      'facebook',
      ...input.customersByChannel.map(c => c.channel),
    ]),
  );

  return channels.map(ch => {
    const spend = ch === 'facebook' ? totalFbSpend : 0;
    const acquired = channelMap.get(ch) ?? 0;
    const cac = spend > 0 && acquired > 0 ? +(spend / acquired).toFixed(2) : null;
    return { channel: ch, spend_cad: spend, customers_acquired: acquired, cac_cad: cac };
  });
}

type CacState = { rows: CacRow[]; loading: boolean };

export function useCacByChannel(): CacState {
  const [state, setState] = useState<CacState>({ rows: [], loading: true });

  const load = useCallback(async () => {
    const [spendRes, channelRes] = await Promise.all([
      supabase
        .from('fb_campaigns')
        .select('date_start, spend_cad')
        .not('spend_cad', 'is', null),
      supabase
        .from('customers')
        .select('first_touch_source')
        .not('first_touch_source', 'is', null),
    ]);

    const spendByMonth = new Map<string, number>();
    for (const row of spendRes.data ?? []) {
      const month = (row.date_start as string).slice(0, 7);
      spendByMonth.set(month, (spendByMonth.get(month) ?? 0) + (row.spend_cad ?? 0));
    }

    const channelCount = new Map<string, number>();
    for (const row of channelRes.data ?? []) {
      const ch = (row.first_touch_source as string).toLowerCase();
      channelCount.set(ch, (channelCount.get(ch) ?? 0) + 1);
    }

    const rows = computeCac({
      fbSpendByMonth: Array.from(spendByMonth.entries()).map(([month, spend_cad]) => ({ month, spend_cad })),
      customersByChannel: Array.from(channelCount.entries()).map(([channel, count]) => ({ channel, count })),
    });

    setState({ rows, loading: false });
  }, []);

  useEffect(() => {
    void load();
    return subscribeReload('cac:realtime', ['fb_campaigns', 'customers'], () => void load());
  }, [load]);

  return state;
}
