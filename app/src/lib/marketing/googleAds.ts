import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

// Google Ads campaign metrics (one row per campaign per day), synced by the
// sync-google-ads edge function. Kept separate from Meta (fb_campaigns) so the
// dashboard + CAC table can show each platform on its own and blended.

export type GoogleAdsCampaign = {
  campaign_id: string;
  campaign_name: string | null;
  status: string | null;
  date: string;                 // YYYY-MM-DD
  spend: number | null;         // account currency (CAD)
  currency: string | null;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  conversions_value: number | null;
};

export type GoogleAdsTotals = {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  value: number;                // conversion value (revenue Google attributes)
  hasData: boolean;
};

export function useGoogleAds(): { rows: GoogleAdsCampaign[]; loading: boolean } {
  const [rows, setRows] = useState<GoogleAdsCampaign[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('google_ads_campaigns')
      .select('campaign_id, campaign_name, status, date, spend, currency, impressions, clicks, conversions, conversions_value')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setRows(data as GoogleAdsCampaign[]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { rows, loading };
}

/** Sum Google Ads rows, optionally within an inclusive YYYY-MM-DD date window
 *  (to match a Journey Report campaign-group / date range). */
export function sumGoogleAds(rows: GoogleAdsCampaign[], start?: string | null, end?: string | null): GoogleAdsTotals {
  let spend = 0, impressions = 0, clicks = 0, conversions = 0, value = 0;
  let any = false;
  for (const r of rows) {
    if (start && r.date < start) continue;
    if (end && r.date > end) continue;
    any = true;
    spend += r.spend ?? 0;
    impressions += r.impressions ?? 0;
    clicks += r.clicks ?? 0;
    conversions += r.conversions ?? 0;
    value += r.conversions_value ?? 0;
  }
  return { spend, impressions, clicks, conversions, value, hasData: any };
}
