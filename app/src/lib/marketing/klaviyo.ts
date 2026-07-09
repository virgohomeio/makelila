import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { subscribeReload } from './realtime';

export type KlaviyoSyncLog = {
  id: string;
  synced_at: string;
  profiles_sent: number;
  errors: number;
  detail: string | null;
};

export function useKlaviyoSyncStatus(limit = 10): { logs: KlaviyoSyncLog[]; loading: boolean } {
  const [logs, setLogs] = useState<KlaviyoSyncLog[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('klaviyo_sync_log')
      .select('*')
      .order('synced_at', { ascending: false })
      .limit(limit);
    if (!error && data) setLogs(data as KlaviyoSyncLog[]);
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    void load();
    return subscribeReload('klaviyo_sync_log:realtime', ['klaviyo_sync_log'], () => void load());
  }, [load]);

  return { logs, loading };
}

export async function triggerKlaviyoSync(): Promise<{ profiles_sent: number; errors: number }> {
  const { data, error } = await supabase.functions.invoke('sync-klaviyo-profiles');
  if (error) throw error;
  return data as { profiles_sent: number; errors: number };
}

/** Pull each customer's Klaviyo email/engagement events into customer_events so
 *  the per-customer Journey shows the email leg (opens, clicks, cart, order). */
export async function triggerKlaviyoEventsSync(): Promise<{ synced: number; scanned?: number; profiles?: number; note?: string }> {
  const { data, error } = await supabase.functions.invoke('klaviyo-pull-events');
  if (error) throw error;
  return data as { synced: number; scanned?: number; profiles?: number; note?: string };
}
