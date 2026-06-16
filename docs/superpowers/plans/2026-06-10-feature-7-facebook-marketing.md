# Feature 7: Facebook Marketing Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the Facebook Marketing API so Pedrum can see ad spend, impressions, clicks, and cost-per-lead for each active campaign inside makelila, with a webhook receiver that handles incoming lead form submissions and a System User access token managed via the Supabase vault.

**Architecture:** New `supabase/functions/facebook-webhook/index.ts` handles `hub.challenge` verification and incoming `leadgen` events. New `supabase/functions/sync-facebook-ads/index.ts` calls the Graph API `/act_{ad_account_id}/campaigns?fields=insights` and writes to a new `fb_campaigns` table. New `lib/marketing/facebook.ts` exposes `useFbCampaigns` for the Marketing module. System User token stored in Supabase Vault secret `FACEBOOK_SYSTEM_USER_TOKEN`; HMAC-SHA256 webhook verification uses `FACEBOOK_APP_SECRET`.

**Tech Stack:** React 18 + TypeScript, Supabase Edge Functions (Deno), Supabase Postgres, Facebook Marketing API v19.0, Vitest

---

## File Map

| File | Change |
|------|--------|
| `app/supabase/migrations/20260613120000_fb_campaigns.sql` | Create |
| `supabase/functions/facebook-webhook/index.ts` | Create |
| `supabase/functions/sync-facebook-ads/index.ts` | Create |
| `app/src/lib/marketing/facebook.ts` | Create |
| `app/src/lib/marketing/facebook.test.ts` | Create |

---

### Task 1: Schema migration for `fb_campaigns`

**Files:**
- Create: `app/supabase/migrations/20260613120000_fb_campaigns.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Facebook campaign performance snapshots.
-- One row per campaign per sync run. Upsert on (campaign_id, date_start).
CREATE TABLE fb_campaigns (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    text        NOT NULL,
  campaign_name  text        NOT NULL,
  status         text        NOT NULL,
  objective      text        NULL,
  date_start     date        NOT NULL,
  date_stop      date        NOT NULL,
  spend_cad      numeric(12,2) NULL,
  impressions    int         NULL,
  clicks         int         NULL,
  leads          int         NULL,
  cpl_cad        numeric(10,2) GENERATED ALWAYS AS (
    CASE WHEN COALESCE(leads,0) > 0 THEN spend_cad / leads ELSE NULL END
  ) STORED,
  synced_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_fb_campaigns_upsert
  ON fb_campaigns(campaign_id, date_start);

CREATE INDEX idx_fb_campaigns_date
  ON fb_campaigns(date_start DESC);
```

- [ ] **Step 2: Apply to remote**

```bash
cd app
./node_modules/.bin/supabase db push --linked
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260613120000_fb_campaigns.sql
git commit -m "feat(db): add fb_campaigns table for Facebook ad performance snapshots"
```

---

### Task 2: Webhook edge function

**Files:**
- Create: `supabase/functions/facebook-webhook/index.ts`

The webhook handles two cases:
1. `GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` → subscription verification
2. `POST body` → incoming leadgen events (stored to `fb_leads` table, future feature)

- [ ] **Step 1: Read shared auth and cors helpers**

```bash
cat supabase/functions/_shared/auth.ts
cat supabase/functions/_shared/cors.ts
```

Note the exact exports: `corsHeaders`, `authenticate`.

- [ ] **Step 2: Create the webhook function**

```ts
// supabase/functions/facebook-webhook/index.ts
import { corsHeaders } from '../_shared/cors.ts';

const VERIFY_TOKEN = Deno.env.get('FACEBOOK_WEBHOOK_VERIFY_TOKEN') ?? '';
const APP_SECRET   = Deno.env.get('FACEBOOK_APP_SECRET') ?? '';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // ── Subscription verification (GET) ───────────────────────────────────────
  if (req.method === 'GET') {
    const url    = new URL(req.url);
    const mode   = url.searchParams.get('hub.mode');
    const token  = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // ── Incoming webhook events (POST) ────────────────────────────────────────
  if (req.method === 'POST') {
    // Verify HMAC-SHA256 signature
    const sig = req.headers.get('x-hub-signature-256') ?? '';
    const body = await req.text();

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(APP_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const expected = 'sha256=' + Array.from(new Uint8Array(mac))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (sig !== expected) {
      return new Response('Invalid signature', { status: 401 });
    }

    // For now, just acknowledge. Lead form events handled in a future iteration.
    const payload = JSON.parse(body);
    console.log('Facebook webhook event:', JSON.stringify(payload));

    return new Response('ok', { status: 200 });
  }

  return new Response('Method not allowed', { status: 405 });
});
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/facebook-webhook/index.ts
git commit -m "feat(edge): add facebook-webhook edge function with HMAC verification"
```

---

### Task 3: `sync-facebook-ads` edge function

**Files:**
- Create: `supabase/functions/sync-facebook-ads/index.ts`

This function is called by a Supabase cron (configured in Task 4) or by the Marketing module's "Sync now" button via `functions.invoke()`.

- [ ] **Step 1: Create the function**

```ts
// supabase/functions/sync-facebook-ads/index.ts
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

  // Fetch last 30 days of campaign insights
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
```

- [ ] **Step 2: Deploy both functions**

```bash
cd app
./node_modules/.bin/supabase functions deploy facebook-webhook --project-ref txeftbbzeflequvrmjjr
./node_modules/.bin/supabase functions deploy sync-facebook-ads --project-ref txeftbbzeflequvrmjjr
```
Expected: both deploy without errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/sync-facebook-ads/index.ts
git commit -m "feat(edge): add sync-facebook-ads edge function pulling Graph API insights"
```

---

### Task 4: `lib/marketing/facebook.ts` — data layer

**Files:**
- Create: `app/src/lib/marketing/facebook.ts`
- Create: `app/src/lib/marketing/facebook.test.ts`

- [ ] **Step 1: Write tests first**

Create `app/src/lib/marketing/facebook.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const selectMock = vi.fn();
const orderMock = vi.fn();
const eqMock = vi.fn();
const limitMock = vi.fn();

selectMock.mockReturnValue({ order: orderMock });
orderMock.mockReturnValue({ limit: limitMock });
limitMock.mockResolvedValue({
  data: [
    {
      campaign_id: 'c-1',
      campaign_name: 'Spring Launch',
      status: 'ACTIVE',
      objective: 'LEAD_GENERATION',
      date_start: '2026-05-01',
      date_stop: '2026-05-31',
      spend_cad: 500,
      impressions: 10000,
      clicks: 200,
      leads: 15,
      cpl_cad: 33.33,
      synced_at: '2026-06-01T00:00:00Z',
    },
  ],
  error: null,
});

vi.mock('../supabase', () => ({
  supabase: { from: vi.fn(() => ({ select: selectMock })) },
}));

import { useFbCampaigns } from './facebook';
import { renderHook, waitFor } from '@testing-library/react';

describe('useFbCampaigns', () => {
  it('returns campaigns from Supabase', async () => {
    const { result } = renderHook(() => useFbCampaigns());
    await waitFor(() => !result.current.loading);
    expect(result.current.campaigns).toHaveLength(1);
    expect(result.current.campaigns[0].campaign_name).toBe('Spring Launch');
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd app
npm test -- marketing/facebook
```
Expected: FAIL "Cannot find module './facebook'".

- [ ] **Step 3: Create `lib/marketing/facebook.ts`**

```ts
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

/** Trigger an on-demand sync from the Marketing module UI. */
export async function triggerFbSync(supabaseClient: ReturnType<typeof import('../supabase')['supabase']['functions']['invoke']> extends Promise<infer T> ? never : typeof supabase): Promise<{ synced: number }> {
  const { data, error } = await supabaseClient.functions.invoke('sync-facebook-ads');
  if (error) throw error;
  return data as { synced: number };
}
```

Wait — the `triggerFbSync` type is overly complex. Simplify:

```ts
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- marketing/facebook
```
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/marketing/facebook.ts app/src/lib/marketing/facebook.test.ts
git commit -m "feat(lib): add marketing/facebook.ts with useFbCampaigns and triggerFbSync"
```

---

### Task 5: Environment variables documentation

The following secrets must be set in Supabase Vault (not in `.env` files):

- `FACEBOOK_SYSTEM_USER_TOKEN` — System User access token from Meta Business Suite
- `FACEBOOK_AD_ACCOUNT_ID` — Ad account ID (numeric, without `act_` prefix)
- `FACEBOOK_APP_SECRET` — App secret for HMAC-SHA256 webhook verification
- `FACEBOOK_WEBHOOK_VERIFY_TOKEN` — Self-chosen token for hub subscription verification

Set them via the Supabase dashboard → Edge Functions → Secrets, or via CLI:

```bash
./node_modules/.bin/supabase secrets set FACEBOOK_SYSTEM_USER_TOKEN=... --project-ref txeftbbzeflequvrmjjr
./node_modules/.bin/supabase secrets set FACEBOOK_AD_ACCOUNT_ID=... --project-ref txeftbbzeflequvrmjjr
./node_modules/.bin/supabase secrets set FACEBOOK_APP_SECRET=... --project-ref txeftbbzeflequvrmjjr
./node_modules/.bin/supabase secrets set FACEBOOK_WEBHOOK_VERIFY_TOKEN=makelila-fb-webhook --project-ref txeftbbzeflequvrmjjr
```

- [ ] **Step 1: Add env var documentation to `.env.example`**

Open `app/.env.example` (or create it if it doesn't exist). Add:

```
# Facebook Marketing API (set as Supabase Vault secrets, NOT in .env)
# FACEBOOK_SYSTEM_USER_TOKEN=...
# FACEBOOK_AD_ACCOUNT_ID=...
# FACEBOOK_APP_SECRET=...
# FACEBOOK_WEBHOOK_VERIFY_TOKEN=makelila-fb-webhook
```

- [ ] **Step 2: Commit**

```bash
git add app/.env.example
git commit -m "docs: document Facebook Marketing API env vars"
```
