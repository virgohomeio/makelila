import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

export type FbCampaign = {
  campaign_id: string;
  campaign_name: string;
  status: string;
  objective: string | null;
  date_start: string;
  date_stop: string;
  spend_cad: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
  cpl_cad: number | null;
  synced_at: string;
};

export function useFbCampaigns(limit = 90): { campaigns: FbCampaign[]; loading: boolean } {
  const [campaigns, setCampaigns] = useState<FbCampaign[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('fb_campaigns')
        .select('*')
        .order('date_start', { ascending: false })
        .limit(limit);
      if (!cancelled) {
        if (!error && data) setCampaigns(data as FbCampaign[]);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [limit]);

  return { campaigns, loading };
}

export async function triggerFbSync(): Promise<{ synced: number }> {
  const { data, error } = await supabase.functions.invoke('sync-facebook-ads');
  if (error) throw error;
  return data as { synced: number };
}
