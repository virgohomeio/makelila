# Feature 5: Klaviyo Predictive Sending & Segment Sync

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push makelila customer lifecycle state (order stage, return flag, fulfillment date) into Klaviyo as profile properties so Klaviyo flows can use them for predictive sending — e.g., "send 30-day check-in if `last_fulfilled_at` was 30 days ago and `has_return=false`."

**Architecture:** New `supabase/functions/sync-klaviyo-profiles/index.ts` edge function reads `customers JOIN orders` and upserts Klaviyo profiles via the v2024 Profiles API. Called daily by a Supabase pg_cron job and on-demand from the Marketing module. New `lib/marketing/klaviyo.ts` exposes `useKlaviyoSyncStatus` for UI feedback. This builds on Feature 1 (klaviyo-track edge function) which already established the Klaviyo Private API Key pattern.

**Dependency:** Feature 1 (Klaviyo Track firehose) must be shipped first — `KLAVIYO_PRIVATE_KEY` vault secret must already exist.

**Tech Stack:** React 18 + TypeScript, Supabase Edge Functions (Deno), Supabase pg_cron, Klaviyo API v2024-10-15, Vitest

---

## File Map

| File | Change |
|------|--------|
| `app/supabase/migrations/20260615120000_klaviyo_sync_log.sql` | Create — sync log table |
| `supabase/functions/sync-klaviyo-profiles/index.ts` | Create |
| `app/src/lib/marketing/klaviyo.ts` | Create |
| `app/src/lib/marketing/klaviyo.test.ts` | Create |

---

### Task 1: Sync log table + pg_cron job

**Files:**
- Create: `app/supabase/migrations/20260615120000_klaviyo_sync_log.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Klaviyo profile sync audit log.
CREATE TABLE klaviyo_sync_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  synced_at    timestamptz NOT NULL DEFAULT now(),
  profiles_sent int        NOT NULL DEFAULT 0,
  errors       int         NOT NULL DEFAULT 0,
  detail       text        NULL
);

-- Keep only the last 90 runs.
CREATE INDEX idx_klaviyo_sync_log_date ON klaviyo_sync_log(synced_at DESC);

-- Daily sync at 2 AM UTC via pg_cron.
-- Requires pg_cron extension (already enabled on Supabase).
SELECT cron.schedule(
  'sync-klaviyo-profiles-daily',
  '0 2 * * *',
  $$
    SELECT net.http_post(
      url    := current_setting('app.supabase_url') || '/functions/v1/sync-klaviyo-profiles',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body   := '{}'::jsonb
    );
  $$
);
```

Note: The `app.supabase_url` and `app.service_role_key` PostgreSQL settings must be pre-set in the project. If they aren't, use a direct HTTP call from a separate cron trigger or invoke via the Supabase cron dashboard manually. Document this in the PR.

- [ ] **Step 2: Apply to remote**

```bash
cd app
./node_modules/.bin/supabase db push --linked
```
Expected: no errors. If `net.http_post` is not available, the cron schedule silently skips. The function can still be invoked manually.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260615120000_klaviyo_sync_log.sql
git commit -m "feat(db): add klaviyo_sync_log table and daily pg_cron schedule"
```

---

### Task 2: `sync-klaviyo-profiles` edge function

**Files:**
- Create: `supabase/functions/sync-klaviyo-profiles/index.ts`

The function queries `customers JOIN orders` to build lifecycle properties, then upserts into Klaviyo Profiles API in batches of 100.

- [ ] **Step 1: Read the existing klaviyo-track function for the API pattern**

```bash
cat supabase/functions/klaviyo-track/index.ts
```

Note the exact Klaviyo API endpoint, revision header (`2024-10-15`), and auth header pattern.

- [ ] **Step 2: Create the function**

```ts
// supabase/functions/sync-klaviyo-profiles/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const KLAVIYO_KEY = Deno.env.get('KLAVIYO_PRIVATE_KEY') ?? '';
const KLAVIYO_REV = '2024-10-15';

type CustomerRow = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  stage: string | null;
  has_return: boolean;
  klaviyo_profile_id: string | null;
  last_fulfilled_at: string | null;
  first_order_at: string | null;
  order_count: number;
};

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

  // Query customers with lifecycle state derived from orders
  const { data: customers, error: dbError } = await supabase
    .rpc('get_customers_for_klaviyo_sync');

  if (dbError) {
    console.error('DB error:', dbError);
    return new Response(JSON.stringify({ error: dbError.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rows = (customers ?? []) as CustomerRow[];
  let profilesSent = 0;
  let errors = 0;

  // Batch in groups of 100 (Klaviyo bulk limit)
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const profiles = batch.map(c => ({
      type: 'profile',
      attributes: {
        email: c.email,
        phone_number: c.phone ?? undefined,
        first_name: c.name?.split(' ')[0] ?? undefined,
        last_name: c.name?.split(' ').slice(1).join(' ') || undefined,
        properties: {
          lila_stage: c.stage,
          lila_has_return: c.has_return,
          lila_last_fulfilled_at: c.last_fulfilled_at,
          lila_first_order_at: c.first_order_at,
          lila_order_count: c.order_count,
        },
      },
      ...(c.klaviyo_profile_id ? { id: c.klaviyo_profile_id } : {}),
    }));

    const res = await fetch('https://a.klaviyo.com/api/profile-bulk-import-jobs/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
        'revision': KLAVIYO_REV,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          type: 'profile-bulk-import-job',
          attributes: { profiles: { data: profiles } },
        },
      }),
    });

    if (res.ok) {
      profilesSent += batch.length;
    } else {
      const errText = await res.text();
      console.error('Klaviyo batch error:', errText);
      errors += batch.length;
    }
  }

  // Log to klaviyo_sync_log
  await supabase.from('klaviyo_sync_log').insert({
    profiles_sent: profilesSent,
    errors,
    detail: errors > 0 ? `${errors} profiles failed` : null,
  });

  return new Response(JSON.stringify({ profiles_sent: profilesSent, errors }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 3: Create the DB helper function**

Add a migration for the `get_customers_for_klaviyo_sync` SQL function that the edge function calls:

Create `app/supabase/migrations/20260615130000_fn_customers_klaviyo_sync.sql`:

```sql
-- Returns customers with lifecycle state for Klaviyo profile sync.
CREATE OR REPLACE FUNCTION get_customers_for_klaviyo_sync()
RETURNS TABLE (
  id                 text,
  email              text,
  name               text,
  phone              text,
  stage              text,
  has_return         boolean,
  klaviyo_profile_id text,
  last_fulfilled_at  timestamptz,
  first_order_at     timestamptz,
  order_count        bigint
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    c.id,
    c.email,
    c.name,
    c.phone,
    c.stage,
    EXISTS (
      SELECT 1 FROM returns r
      JOIN orders o ON o.id = r.order_id
      WHERE o.customer_id = c.id
    ) AS has_return,
    c.klaviyo_profile_id,
    MAX(o.shipped_at) AS last_fulfilled_at,
    MIN(o.placed_at)  AS first_order_at,
    COUNT(DISTINCT o.id) AS order_count
  FROM customers c
  LEFT JOIN orders o ON o.customer_id = c.id AND o.kind = 'sale'
  WHERE c.email IS NOT NULL
  GROUP BY c.id, c.email, c.name, c.phone, c.stage, c.klaviyo_profile_id
$$;
```

- [ ] **Step 4: Apply and deploy**

```bash
cd app
./node_modules/.bin/supabase db push --linked
./node_modules/.bin/supabase functions deploy sync-klaviyo-profiles --project-ref txeftbbzeflequvrmjjr
```

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync-klaviyo-profiles/index.ts \
        supabase/migrations/20260615130000_fn_customers_klaviyo_sync.sql
git commit -m "feat(edge): add sync-klaviyo-profiles with bulk profile upsert"
```

---

### Task 3: `lib/marketing/klaviyo.ts` — sync status hook

**Files:**
- Create: `app/src/lib/marketing/klaviyo.ts`
- Create: `app/src/lib/marketing/klaviyo.test.ts`

- [ ] **Step 1: Write tests first**

Create `app/src/lib/marketing/klaviyo.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const data = [{ id: 'log-1', synced_at: '2026-06-10T02:00:00Z', profiles_sent: 120, errors: 0, detail: null }];
const selectMock  = vi.fn().mockReturnValue({ order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data, error: null }) }) });
const invokeMock  = vi.fn().mockResolvedValue({ data: { profiles_sent: 120, errors: 0 }, error: null });

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(() => ({ select: selectMock })),
    functions: { invoke: invokeMock },
  },
}));

import { useKlaviyoSyncStatus, triggerKlaviyoSync } from './klaviyo';
import { renderHook, waitFor } from '@testing-library/react';

describe('useKlaviyoSyncStatus', () => {
  it('returns last sync log entries', async () => {
    const { result } = renderHook(() => useKlaviyoSyncStatus());
    await waitFor(() => !result.current.loading);
    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0].profiles_sent).toBe(120);
  });
});

describe('triggerKlaviyoSync', () => {
  it('invokes the edge function and returns result', async () => {
    const result = await triggerKlaviyoSync();
    expect(result.profiles_sent).toBe(120);
    expect(invokeMock).toHaveBeenCalledWith('sync-klaviyo-profiles');
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- marketing/klaviyo
```
Expected: FAIL "Cannot find module './klaviyo'".

- [ ] **Step 3: Create `lib/marketing/klaviyo.ts`**

```ts
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- marketing/klaviyo
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/marketing/klaviyo.ts app/src/lib/marketing/klaviyo.test.ts
git commit -m "feat(lib): add marketing/klaviyo.ts with sync status hook and trigger"
```
