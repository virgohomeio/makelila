import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { fnErrorMessage } from './fnError';
import { subscribeReload } from './realtime';

export type FbMetrics = {
  delivery?: string;
  budget?: string;
  results?: number | null;
  result_label?: string;
  cost_per_result?: number | null;
  result_rate?: number | null;
  adds_to_cart?: number;
  add_payment_info?: number;
  checkouts_initiated?: number;
  ctr?: number | null;
  cpm?: number | null;
  reach?: number | null;
  frequency?: number | null;
  leads?: number;
  link_clicks?: number;
  landing_page_views?: number;
  post_comments?: number;
  post_reactions?: number;
  post_shares?: number;
  page_likes?: number;
  post_saves?: number;
  website_purchases?: number;
  bid_strategy?: string | null;
  campaign_start?: string | null;
  campaign_end?: string | null;
  attribution_setting?: string | null;
  video_3s?: number;
  video_p75?: number;
  video_p100?: number;
};

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
  reach: number | null;
  cpl_cad: number | null;
  metrics: FbMetrics | null;
  synced_at: string;
};

export function useFbCampaigns(limit = 90): { campaigns: FbCampaign[]; loading: boolean } {
  const [campaigns, setCampaigns] = useState<FbCampaign[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('fb_campaigns')
      .select('*')
      .order('date_start', { ascending: false })
      .limit(limit);
    if (!error && data) setCampaigns(data as FbCampaign[]);
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    void load();
    return subscribeReload('fb_campaigns:realtime', ['fb_campaigns'], () => void load());
  }, [load]);

  return { campaigns, loading };
}

export type FbAd = {
  ad_id: string;
  ad_name: string;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  date_start: string | null;
  spend_cad: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  leads: number | null;
};

/** Ad-level rows (one per ad) for per-ad-set + per-creative analysis. */
export function useFbAds(): { ads: FbAd[]; loading: boolean } {
  const [ads, setAds] = useState<FbAd[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('fb_ads')
      .select('ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, date_start, spend_cad, impressions, clicks, ctr, leads');
    if (!error && data) setAds(data as FbAd[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return subscribeReload('fb_ads:realtime', ['fb_ads'], () => void load());
  }, [load]);
  return { ads, loading };
}

export async function triggerFbSync(): Promise<{ synced: number }> {
  const { data, error } = await supabase.functions.invoke('sync-facebook-ads');
  if (error) throw new Error(await fnErrorMessage(error));
  return data as { synced: number };
}

export type FbDemographic = {
  campaign_id: string;
  campaign_name: string | null;
  date: string;
  age: string;
  gender: string;
  country: string;
  leads: number | null;
  purchases: number | null;
};

/** Meta lead/purchase segments (age×gender×country×day) — powers the Journey
 *  Report age/gender match and the Demographics page. */
export function useFbDemographics(): { demographics: FbDemographic[]; loading: boolean } {
  const [demographics, setDemographics] = useState<FbDemographic[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('fb_demographics')
      .select('campaign_id, campaign_name, date, age, gender, country, leads, purchases')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setDemographics(data as FbDemographic[]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);
  return { demographics, loading };
}

export async function triggerFbDemographicsSync(): Promise<{ synced: number }> {
  const { data, error } = await supabase.functions.invoke('sync-fb-demographics');
  if (error) throw new Error(await fnErrorMessage(error));
  return data as { synced: number };
}
