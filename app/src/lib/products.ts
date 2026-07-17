import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Issue {
  title: string; sev: IssueSeverity;
  tag: string; team: string; meta: string; mpBlocker?: boolean;
}

export type DbProductIssue = {
  id: string;
  product_id: string;
  title: string;
  severity: IssueSeverity;
  tag: string;
  team: string | null;
  meta: string;
  link: string | null;
  mp_blocker: boolean;
  source: 'seed' | 'chat';
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
};

export function toIssue(row: DbProductIssue): Issue {
  return {
    title: row.title,
    sev: row.severity,
    tag: row.tag,
    team: row.team ?? '',
    meta: row.meta,
    mpBlocker: row.mp_blocker,
  };
}

export function groupByProduct(rows: DbProductIssue[]): Record<string, Issue[]> {
  const out: Record<string, Issue[]> = {};
  for (const row of rows) {
    if (!out[row.product_id]) out[row.product_id] = [];
    out[row.product_id].push(toIssue(row));
  }
  return out;
}

const PRODUCT_ISSUE_COLUMNS =
  'id, product_id, title, severity, tag, team, meta, link, mp_blocker, source, created_by, created_by_name, created_at';

/** Realtime-subscribed list of every product issue, grouped by product_id.
 *  Fetched once at the Products() root and threaded down to the Dashboard
 *  tab and each product's Overview/Issues tabs. */
export function useProductIssues(): { issuesByProduct: Record<string, Issue[]>; loading: boolean } {
  const [rows, setRows] = useState<DbProductIssue[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    (async () => {
      const { data, error } = await supabase
        .from('product_issues')
        .select(PRODUCT_ISSUE_COLUMNS);
      if (cancelled) return;
      if (!error && data) setRows(data as DbProductIssue[]);
      setLoading(false);

      channel = supabase
        .channel('product_issues:realtime')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'product_issues' },
          (payload) => {
            setRows(prev => [...prev, payload.new as DbProductIssue]);
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { issuesByProduct: groupByProduct(rows), loading };
}

export type FleetLineStat = {
  productId: string;
  stage: string;
  openCount: number;
  criticalCount: number;
};

export type FleetStats = {
  totalOpen: number;
  totalCritical: number;
  totalMpBlockers: number;
  lineCount: number;
  perLine: FleetLineStat[];
};

/** Pure — no React/Supabase dependency, safe to unit test in isolation. */
export function computeFleetStats(
  issuesByProduct: Record<string, Issue[]>,
  products: { id: string; stage: string }[],
): FleetStats {
  const perLine: FleetLineStat[] = products.map(p => {
    const issues = issuesByProduct[p.id] ?? [];
    return {
      productId: p.id,
      stage: p.stage,
      openCount: issues.length,
      criticalCount: issues.filter(i => i.sev === 'critical').length,
    };
  });
  const allIssues = products.flatMap(p => issuesByProduct[p.id] ?? []);
  return {
    totalOpen: allIssues.length,
    totalCritical: allIssues.filter(i => i.sev === 'critical').length,
    totalMpBlockers: allIssues.filter(i => i.mpBlocker === true).length,
    lineCount: products.length,
    perLine,
  };
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type ChatResponse = {
  reply: string;
  filed: boolean;
  issue?: { id: string; title: string; product_id: string };
};

/** Calls the product-issue-chat edge function. Components never call
 *  `supabase.functions.invoke` directly — this is the one place that does. */
export async function sendIssueChatMessage(payload: {
  messages: ChatTurn[];
  product_id: string | null;
  products: { id: string; label: string }[];
  knownTeam: string[];
}): Promise<ChatResponse> {
  const { data, error } = await supabase.functions.invoke('product-issue-chat', { body: payload });
  if (error) throw error;
  return data as ChatResponse;
}
