import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

// PostgREST returns embedded relations as either an object or an array.
function toEntry(row: Record<string, unknown>): ActivityLogEntry {
  const p = row.profiles as { display_name?: string | null } | Array<{ display_name?: string | null }> | null;
  const profile = Array.isArray(p) ? p[0] : p;
  return {
    id: row.id as number,
    user_id: row.user_id as string,
    ts: row.ts as string,
    type: row.type as string,
    entity: row.entity as string,
    detail: (row.detail as string) ?? '',
    actor_name: profile?.display_name ?? null,
  };
}

export type ActivityLogEntry = {
  id: number;
  user_id: string;
  ts: string;
  type: string;
  entity: string;
  detail: string;
  // Joined from public.profiles via the embed below. May be null for
  // entries written before the profiles row existed.
  actor_name: string | null;
};

/** Group consecutive entries by the same user when they're within 90 min
 *  of each other. Returns sessions newest-first (matching feed order). */
export type ActivitySession = {
  user_id: string;
  actor_name: string | null;
  started_at: string;
  ended_at: string;
  entries: ActivityLogEntry[];
};

const SESSION_GAP_MS = 90 * 60 * 1000;

export function sessionize(entries: ActivityLogEntry[]): ActivitySession[] {
  // Entries arrive newest-first; build sessions newest-first too.
  const out: ActivitySession[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    const t = Date.parse(e.ts);
    if (last && last.user_id === e.user_id) {
      const lastT = Date.parse(last.ended_at);
      // Since entries are newest-first, "ended_at" on the existing session
      // is actually older than `e.ts`; the gap is therefore lastEntryTs - t.
      const oldestInSession = Date.parse(last.ended_at);
      if (Math.abs(t - oldestInSession) <= SESSION_GAP_MS) {
        last.entries.push(e);
        last.ended_at = e.ts;
        continue;
      }
      // Avoid unused-var lint
      void lastT;
    }
    out.push({
      user_id: e.user_id,
      actor_name: e.actor_name,
      started_at: e.ts,
      ended_at: e.ts,
      entries: [e],
    });
  }
  return out;
}

/** Insert an audit entry stamped with the current authenticated user. */
export async function logAction(
  type: string,
  entity: string,
  detail: string = '',
): Promise<void> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) throw new Error('logAction: not authenticated');

  const { error } = await supabase.from('activity_log').insert({
    user_id: user.id,
    type,
    entity,
    detail,
  });
  if (error) throw error;
}

/** Backlog #56 V2 — server-aggregated KPI window for the side panel.
 *  Pulls every activity_log row within the last `days` days (default 7),
 *  then aggregates client-side into the buckets the KpiPanel needs. The
 *  audit log churn is low (state-change-driven, not user-action-driven),
 *  so 7d of entries fits comfortably in memory and avoids the per-tile
 *  count() round-trips that would otherwise need a Postgres RPC. */
export function useActivityKpis(days: number = 7) {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    (async () => {
      const sinceIso = new Date(Date.now() - days * 24 * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('activity_log')
        .select('id, user_id, ts, type, entity, detail, profiles(display_name)')
        .gte('ts', sinceIso)
        .order('ts', { ascending: false })
        .limit(5000);
      if (cancelled) return;
      if (error) {
        // Surface the failure so future silent breaks (FK drift, RLS
        // change, etc.) don't quietly flatten the KPI tiles to zero.
        // eslint-disable-next-line no-console
        console.error('useActivityKpis: activity_log query failed', error);
      } else if (data) {
        setEntries((data as Array<Record<string, unknown>>).map(toEntry));
      }
      setLoading(false);

      // Live-update on new inserts so the tiles tick up in real time.
      channel = supabase
        .channel('activity_log:kpis:realtime')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, () => {
          // Cheap: bump a tick to re-run the bulk query. Avoids per-row
          // enrichment plumbing for what's already a small dataset.
          setRefreshTick(t => t + 1);
        })
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) void channel.unsubscribe();
    };
  }, [days, refreshTick]);

  return { entries, loading };
}

/**
 * Subscribe to the most recent `limit` activity_log entries, with realtime updates
 * prepended as new rows arrive.
 */
export function useActivityLog(limit: number = 100) {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      // Join profiles for the actor's display name. PostgREST embed syntax;
      // the FK from activity_log.user_id → profiles.id makes this implicit.
      const { data, error } = await supabase
        .from('activity_log')
        .select('id, user_id, ts, type, entity, detail, profiles(display_name)')
        .order('ts', { ascending: false })
        .limit(limit);

      if (cancelled) return;
      if (!error && data) {
        setEntries((data as Array<Record<string, unknown>>).map(toEntry));
      }
      setLoading(false);

      channel = supabase
        .channel('activity_log:realtime')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'activity_log' },
          (payload) => {
            // Realtime payloads don't include the embed, so fetch the
            // actor's display_name in a follow-up query. Best-effort —
            // if it fails the entry just shows without a name.
            const raw = payload.new as Record<string, unknown>;
            void (async () => {
              const { data: pRow } = await supabase
                .from('profiles')
                .select('display_name')
                .eq('id', raw.user_id as string)
                .maybeSingle();
              const enriched = toEntry({ ...raw, profiles: pRow });
              setEntries(prev => [enriched, ...prev].slice(0, limit));
            })();
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void channel.unsubscribe();
    };
  }, [limit]);

  return { entries, loading };
}
