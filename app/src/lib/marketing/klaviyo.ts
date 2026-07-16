import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { fnErrorMessage } from './fnError';
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
  if (error) throw new Error(await fnErrorMessage(error));
  return data as { profiles_sent: number; errors: number };
}

/** Pull each customer's Klaviyo email/engagement events into customer_events so
 *  the per-customer Journey shows the email leg (opens, clicks, cart, order). */
export async function triggerKlaviyoEventsSync(): Promise<{ synced: number; scanned?: number; profiles?: number; note?: string }> {
  const { data, error } = await supabase.functions.invoke('klaviyo-pull-events');
  if (error) throw new Error(await fnErrorMessage(error));
  return data as { synced: number; scanned?: number; profiles?: number; note?: string };
}

export type KlaviyoCampaign = {
  campaign_id: string;
  name: string | null;
  status: string | null;
  send_time: string | null;
  recipients: number | null;
  delivered: number | null;
  opens_unique: number | null;
  open_rate: number | null;
  clicks_unique: number | null;
  click_rate: number | null;
  conversions: number | null;
  revenue: number | null;
  unsubscribes: number | null;
  unsubscribe_rate: number | null;
  bounce_rate: number | null;
  spam_complaint_rate: number | null;
  synced_at: string;
};

/** Email campaign performance rows (open/click rate, revenue) for the Email tab. */
export function useKlaviyoCampaigns(): { campaigns: KlaviyoCampaign[]; loading: boolean } {
  const [campaigns, setCampaigns] = useState<KlaviyoCampaign[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('klaviyo_campaigns')
      .select('*')
      .order('send_time', { ascending: false, nullsFirst: false });
    if (!error && data) setCampaigns(data as KlaviyoCampaign[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return subscribeReload('klaviyo_campaigns:realtime', ['klaviyo_campaigns'], () => void load());
  }, [load]);

  return { campaigns, loading };
}

/** Pull Klaviyo email campaign performance into klaviyo_campaigns. */
export async function triggerKlaviyoCampaignsSync(): Promise<{ synced: number; note?: string }> {
  const { data, error } = await supabase.functions.invoke('sync-klaviyo-campaigns');
  if (error) throw new Error(await fnErrorMessage(error));
  return data as { synced: number; note?: string };
}
