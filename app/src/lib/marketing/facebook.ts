import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

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

export type FbAd = {
  ad_id: string;
  ad_name: string;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
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
  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('fb_ads')
      .select('ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, spend_cad, impressions, clicks, ctr, leads')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setAds(data as FbAd[]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);
  return { ads, loading };
}

// supabase-js collapses any non-2xx into "Edge Function returned a non-2xx
// status code"; the real { error } JSON is on error.context (a Response). Pull
// it out so the Sync button shows the actual cause.
async function fnErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    try { const b = await ctx.clone().json() as { error?: string }; if (b?.error) return b.error; } catch { /* not json */ }
    try { const t = await ctx.text(); if (t) return t.slice(0, 400); } catch { /* ignore */ }
  }
  return (error as Error)?.message ?? 'Edge function call failed';
}

export async function triggerFbSync(): Promise<{ synced: number }> {
  const { data, error } = await supabase.functions.invoke('sync-facebook-ads');
  if (error) throw new Error(await fnErrorMessage(error));
  return data as { synced: number };
}
