import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const FB_TOKEN      = Deno.env.get('FACEBOOK_SYSTEM_USER_TOKEN') ?? '';
const FB_ACCOUNT_ID = Deno.env.get('FACEBOOK_AD_ACCOUNT_ID') ?? '';
const API_VERSION   = 'v19.0';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authError = await authenticate(req);
  if (authError) return authError;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const url = new URL(`https://graph.facebook.com/${API_VERSION}/act_${FB_ACCOUNT_ID}/campaigns`);
  url.searchParams.set('fields', [
    'id', 'name', 'status', 'objective',
    'insights.date_preset(last_30d){spend,impressions,clicks,actions,date_start,date_stop}',
  ].join(','));
  url.searchParams.set('access_token', FB_TOKEN);
  url.searchParams.set('limit', '50');

  const fbRes = await fetch(url.toString());
  if (!fbRes.ok) {
    const err = await fbRes.text();
    console.error('Facebook API error:', err);
    return new Response(JSON.stringify({ error: 'Facebook API error', detail: err }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const fbData = await fbRes.json() as {
    data: Array<{
      id: string;
      name: string;
      status: string;
      objective?: string;
      insights?: {
        data: Array<{
          spend: string;
          impressions: string;
          clicks: string;
          actions?: Array<{ action_type: string; value: string }>;
          date_start: string;
          date_stop: string;
        }>;
      };
    }>;
  };

  const rows = [];
  for (const campaign of fbData.data ?? []) {
    for (const insight of campaign.insights?.data ?? []) {
      const leads = insight.actions?.find(a => a.action_type === 'lead')?.value;
      rows.push({
        campaign_id:   campaign.id,
        campaign_name: campaign.name,
        status:        campaign.status,
        objective:     campaign.objective ?? null,
        date_start:    insight.date_start,
        date_stop:     insight.date_stop,
        spend_cad:     parseFloat(insight.spend) || null,
        impressions:   parseInt(insight.impressions) || null,
        clicks:        parseInt(insight.clicks) || null,
        leads:         leads ? parseInt(leads) : null,
        synced_at:     new Date().toISOString(),
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from('fb_campaigns')
      .upsert(rows, { onConflict: 'campaign_id,date_start', ignoreDuplicates: false });
    if (error) {
      console.error('Supabase upsert error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ synced: rows.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
