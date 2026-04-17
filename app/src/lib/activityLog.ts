import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type ActivityLogEntry = {
  id: number;
  user_id: string;
  ts: string;
  type: string;
  entity: string;
  detail: string;
};

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
      const { data, error } = await supabase
        .from('activity_log')
        .select('id, user_id, ts, type, entity, detail')
        .order('ts', { ascending: false })
        .limit(limit);

      if (cancelled) return;
      if (!error && data) setEntries(data as ActivityLogEntry[]);
      setLoading(false);

      channel = supabase
        .channel('activity_log:realtime')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'activity_log' },
          (payload) => {
            setEntries(prev => [payload.new as ActivityLogEntry, ...prev].slice(0, limit));
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
