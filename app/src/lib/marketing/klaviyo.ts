import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('klaviyo_sync_log')
        .select('*')
        .order('synced_at', { ascending: false })
        .limit(limit);
      if (!cancelled) {
        if (!error && data) setLogs(data as KlaviyoSyncLog[]);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [limit]);

  return { logs, loading };
}

export async function triggerKlaviyoSync(): Promise<{ profiles_sent: number; errors: number }> {
  const { data, error } = await supabase.functions.invoke('sync-klaviyo-profiles');
  if (error) throw error;
  return data as { profiles_sent: number; errors: number };
}
