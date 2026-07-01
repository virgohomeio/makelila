# Freightcom Tracking Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing "All Shipments" section in the Shipping tab into a tracking dashboard that displays Freightcom's own status vocabulary and refreshes live status on demand.

**Architecture:** Add `freightcom_status` + `status_synced_at` columns to `shipments`. A new `freightcom-status` edge function batch-fetches the live `.state` from Freightcom's `GET /shipment/{id}` and persists it. The data layer exposes the raw status plus a `displayFreightcomStatus()` resolver; the UI re-skins the existing All Shipments table with Freightcom-status chips, badges, a refresh button, and an "as of" timestamp.

**Tech Stack:** React 18 + TypeScript, Vite, Supabase (Postgres + Edge Functions/Deno), Vitest, CSS Modules.

**Spec:** [docs/superpowers/specs/2026-06-25-freightcom-tracking-dashboard-design.md](../specs/2026-06-25-freightcom-tracking-dashboard-design.md)

---

## File Structure

- **Create** `supabase/migrations/20260625120000_shipments_freightcom_status.sql` — additive columns.
- **Create** `supabase/functions/freightcom-status/index.ts` — batch live-status edge function.
- **Modify** `app/src/lib/shipping.ts` — vocabulary constant, types, resolver, refresh mutation, extended `useAllShipments`.
- **Create** `app/src/lib/shipping.test.ts` — unit tests for `displayFreightcomStatus`.
- **Modify** `app/src/modules/Shipping/tabs/ShippingTab.tsx` — re-skin the All Shipments section.
- **Modify** `app/src/modules/Shipping/Shipping.module.css` — (only if a new "other" badge color is needed).

---

## Task 1: DB migration — add raw Freightcom status columns

**Files:**
- Create: `supabase/migrations/20260625120000_shipments_freightcom_status.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Store Freightcom's raw shipment status (.state) alongside the internal
-- shipments.status enum, plus the time it was last pulled live.
-- Additive + nullable: no backfill, internal status semantics unchanged.

alter table public.shipments
  add column if not exists freightcom_status text;        -- raw Freightcom .state, verbatim

alter table public.shipments
  add column if not exists status_synced_at  timestamptz; -- last live status pull

comment on column public.shipments.freightcom_status is
  'Raw Freightcom shipment .state (e.g. waiting-for-transit, in-transit). NULL until first live refresh.';
comment on column public.shipments.status_synced_at is
  'Timestamp of the last freightcom-status live pull for this row.';
```

- [ ] **Step 2: Apply against the live DB**

Run (service-role key is in `app/.env.local`):
```bash
set -a && . app/.env.local && set +a
psql "$SUPABASE_DB_URL" -f supabase/migrations/20260625120000_shipments_freightcom_status.sql
```
If `SUPABASE_DB_URL` is not set, apply via Supabase SQL editor by pasting the file contents.
Expected: `ALTER TABLE` ×2, `COMMENT` ×2, no errors.

- [ ] **Step 3: Verify columns exist**

Run:
```bash
set -a && . app/.env.local && set +a
curl -s "$VITE_SUPABASE_URL/rest/v1/shipments?select=id,freightcom_status,status_synced_at&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: HTTP 200 JSON with `freightcom_status` and `status_synced_at` keys present (values `null`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260625120000_shipments_freightcom_status.sql
git commit -m "feat(shipping): add freightcom_status + status_synced_at to shipments"
```

---

## Task 2: Status vocabulary + display resolver (TDD)

**Files:**
- Modify: `app/src/lib/shipping.ts` (add exports near the top, after the existing `ShipmentStatus` type at line 7-9)
- Test: `app/src/lib/shipping.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/shipping.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  FREIGHTCOM_STATUSES,
  displayFreightcomStatus,
  isKnownFreightcomStatus,
} from './shipping';

describe('displayFreightcomStatus', () => {
  it('uses the stored raw freightcom_status when present', () => {
    const row = { status: 'booked', freightcom_status: 'in-transit' } as any;
    expect(displayFreightcomStatus(row)).toBe('in-transit');
  });

  it('reverse-maps internal booked -> waiting-for-transit when not yet synced', () => {
    const row = { status: 'booked', freightcom_status: null } as any;
    expect(displayFreightcomStatus(row)).toBe('waiting-for-transit');
  });

  it('reverse-maps internal in_transit -> in-transit when not yet synced', () => {
    const row = { status: 'in_transit', freightcom_status: null } as any;
    expect(displayFreightcomStatus(row)).toBe('in-transit');
  });

  it('passes through 1:1 internal statuses when not yet synced', () => {
    const row = { status: 'delivered', freightcom_status: null } as any;
    expect(displayFreightcomStatus(row)).toBe('delivered');
  });

  it('returns an unknown raw value verbatim', () => {
    const row = { status: 'booked', freightcom_status: 'out-for-delivery' } as any;
    expect(displayFreightcomStatus(row)).toBe('out-for-delivery');
  });
});

describe('isKnownFreightcomStatus', () => {
  it('is true for a known status', () => {
    expect(isKnownFreightcomStatus('in-transit')).toBe(true);
  });
  it('is false for an unexpected status (grouped under "other")', () => {
    expect(isKnownFreightcomStatus('out-for-delivery')).toBe(false);
  });
  it('covers exactly the 6 known statuses', () => {
    expect([...FREIGHTCOM_STATUSES]).toEqual([
      'waiting-for-transit', 'in-transit', 'delivered',
      'exception', 'missing', 'cancelled',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/lib/shipping.test.ts`
Expected: FAIL — `FREIGHTCOM_STATUSES`/`displayFreightcomStatus`/`isKnownFreightcomStatus` are not exported.

- [ ] **Step 3: Implement the vocabulary + resolver**

In `app/src/lib/shipping.ts`, immediately after the `ShipmentStatus` type union (currently lines 7-9), add:
```ts
// ── Freightcom status vocabulary (dashboard source of truth) ────────────────

export const FREIGHTCOM_STATUSES = [
  'waiting-for-transit', 'in-transit', 'delivered',
  'exception', 'missing', 'cancelled',
] as const;
export type FreightcomStatus = typeof FREIGHTCOM_STATUSES[number];

/** True when a raw value is one of the 6 known statuses (else grouped as "other"). */
export function isKnownFreightcomStatus(v: string): v is FreightcomStatus {
  return (FREIGHTCOM_STATUSES as readonly string[]).includes(v);
}

/** Reverse-map the internal enum to Freightcom's vocabulary for never-synced rows. */
const INTERNAL_TO_FREIGHTCOM: Record<ShipmentStatus, string> = {
  booked:     'waiting-for-transit',
  in_transit: 'in-transit',
  delivered:  'delivered',
  exception:  'exception',
  missing:    'missing',
  cancelled:  'cancelled',
};

/**
 * Resolves the Freightcom-vocabulary status to show for a row:
 * stored raw value wins; otherwise reverse-map the internal status.
 */
export function displayFreightcomStatus(
  row: { status: ShipmentStatus; freightcom_status: string | null },
): string {
  if (row.freightcom_status) return row.freightcom_status;
  return INTERNAL_TO_FREIGHTCOM[row.status] ?? row.status;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/lib/shipping.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/shipping.ts app/src/lib/shipping.test.ts
git commit -m "feat(shipping): Freightcom status vocabulary + display resolver"
```

---

## Task 3: `freightcom-status` edge function

**Files:**
- Create: `supabase/functions/freightcom-status/index.ts`

- [ ] **Step 1: Write the function**

Create `supabase/functions/freightcom-status/index.ts` (mirrors `freightcom-tracking` auth/CORS):
```ts
// Batch-fetch live Freightcom shipment status and persist it.
// POST body: { shipments: [{ id, freightcom_shipment_id }] }
// Returns:   { results: [{ id, freightcom_status, error? }] }

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_BASE_URL = 'https://customer-external-api.ssd-test.freightcom.com';

async function authenticate(req: Request, admin: SupabaseClient): Promise<void> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw json({ error: 'Missing Authorization header' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) throw json({ error: 'Invalid token' }, 401);
  const { data: profile, error: pErr } = await admin
    .from('profiles').select('is_internal').eq('id', userData.user.id).maybeSingle();
  if (pErr) throw json({ error: `Profile lookup: ${pErr.message}` }, 500);
  if (!profile?.is_internal) throw json({ error: 'Not authorized' }, 403);
}

type Item = { id: string; freightcom_shipment_id: string };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    if (err instanceof Response) return err;
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const apiKey      = Deno.env.get('FREIGHTCOM_API_KEY');
  const baseUrl     = Deno.env.get('FREIGHTCOM_BASE_URL') ?? DEFAULT_BASE_URL;
  if (!apiKey) return json({ error: 'FREIGHTCOM_API_KEY not configured' }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  await authenticate(req, admin);

  const { shipments } = await req.json() as { shipments?: Item[] };
  if (!Array.isArray(shipments) || shipments.length === 0) {
    return json({ error: 'shipments[] required' }, 400);
  }

  const nowIso = new Date().toISOString();
  const results: Array<{ id: string; freightcom_status: string | null; error?: string }> = [];

  for (const s of shipments) {
    if (!s?.freightcom_shipment_id || !/^\w[\w-]*$/.test(s.freightcom_shipment_id)) {
      results.push({ id: s?.id, freightcom_status: null, error: 'invalid freightcom_shipment_id' });
      continue;
    }
    try {
      const res = await fetch(`${baseUrl}/shipment/${s.freightcom_shipment_id}`, {
        headers: { Authorization: apiKey },
      });
      if (!res.ok) {
        results.push({ id: s.id, freightcom_status: null, error: `Freightcom ${res.status}` });
      } else {
        const body = await res.json() as { state?: string };
        const state = body.state ?? null;
        await admin.from('shipments')
          .update({ freightcom_status: state, status_synced_at: nowIso })
          .eq('id', s.id);
        results.push({ id: s.id, freightcom_status: state });
      }
    } catch (e) {
      results.push({ id: s.id, freightcom_status: null, error: (e as Error).message });
    }
    await new Promise(r => setTimeout(r, 200)); // throttle ~5 req/sec
  }

  return json({ results });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Deploy the function**

Run: `supabase functions deploy freightcom-status`
Expected: "Deployed Function freightcom-status". (If the Supabase CLI is not linked in this environment, note that deploy must be run by an operator with project access — record this in the PR description.)

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/freightcom-status/index.ts
git commit -m "feat(shipping): freightcom-status edge function (batch live status pull)"
```

---

## Task 4: Data layer — extend `useAllShipments` + refresh mutation

**Files:**
- Modify: `app/src/lib/shipping.ts` (`AllShipmentRow` ~line 201, `useAllShipments` ~line 222)

- [ ] **Step 1: Add the new fields to `AllShipmentRow`**

In `AllShipmentRow` (currently lines 201-214), add two fields after `freightcom_shipment_id`:
```ts
  freightcom_status: string | null;
  status_synced_at: string | null;
```

- [ ] **Step 2: Extend the `useAllShipments` select + mapping**

In `useAllShipments`, change the `.select(...)` string (line 232) to add the two columns:
```ts
        .select('id, order_id, carrier, service, rate_cad, primary_tracking_number, status, booked_at, label_url, freightcom_shipment_id, freightcom_status, status_synced_at, orders(order_ref, customer_name)')
```
In the same hook, extend the row mapping's inline type and the returned object to carry them through:
```ts
        freightcom_shipment_id: s.freightcom_shipment_id,
        freightcom_status: s.freightcom_status ?? null,
        status_synced_at: s.status_synced_at ?? null,
```
(Add `freightcom_status: string | null; status_synced_at: string | null;` to the `Array<{...}>` cast type for `data` as well.)

- [ ] **Step 3: Add the refresh mutation + a re-fetch helper**

At the end of `app/src/lib/shipping.ts`, add:
```ts
/**
 * Pulls live Freightcom status for the given shipments and persists it.
 * Returns the per-shipment results from the edge function.
 */
export async function refreshFreightcomStatuses(
  rows: Array<{ id: string; freightcom_shipment_id: string }>,
): Promise<Array<{ id: string; freightcom_status: string | null; error?: string }>> {
  const payload = rows
    .filter(r => r.freightcom_shipment_id)
    .map(r => ({ id: r.id, freightcom_shipment_id: r.freightcom_shipment_id }));
  if (payload.length === 0) return [];
  const { data, error } = await supabase.functions.invoke('freightcom-status', {
    body: { shipments: payload },
  });
  if (error) throw new Error(error.message);
  const results = (data as { results?: Array<{ id: string; freightcom_status: string | null; error?: string }> }).results ?? [];
  await logAction('shipment_status_refreshed', 'shipments', `count=${payload.length}`);
  return results;
}
```

- [ ] **Step 4: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/shipping.ts
git commit -m "feat(shipping): expose freightcom_status in useAllShipments + refresh mutation"
```

---

## Task 5: UI — re-skin the All Shipments section

**Files:**
- Modify: `app/src/modules/Shipping/tabs/ShippingTab.tsx`

- [ ] **Step 1: Update imports + status badge map + filters**

Replace the import on line 2 to add the new helpers and types:
```ts
import {
  useShippingOrders, useAllShipments, bookShipment,
  refreshFreightcomStatuses, displayFreightcomStatus, isKnownFreightcomStatus,
  FREIGHTCOM_STATUSES, type AllShipmentRow,
} from '../../../lib/shipping';
```
(Drop the old `type ShipmentStatus` import — it was only used by the
`STATUS_BADGE_CLASS` map being removed below. If `tsc --noEmit` later reports
`ShipmentStatus` as still referenced elsewhere in the file, re-add it.)

Replace `STATUS_BADGE_CLASS` (lines 6-13) with a Freightcom-keyed map:
```ts
const FC_BADGE_CLASS: Record<string, string> = {
  'waiting-for-transit': styles.statusBooked,
  'in-transit':          styles.statusInTransit,
  'delivered':           styles.statusDelivered,
  'exception':           styles.statusException,
  'missing':             styles.statusMissing,
  'cancelled':           styles.statusCancelled,
};
```
Replace the `Filter` type + `FILTERS` (lines 15-22) with Freightcom statuses + "other":
```ts
type Filter = 'all' | typeof FREIGHTCOM_STATUSES[number] | 'other';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all',                 label: 'All'                 },
  { id: 'waiting-for-transit', label: 'Waiting for transit' },
  { id: 'in-transit',          label: 'In transit'          },
  { id: 'delivered',           label: 'Delivered'           },
  { id: 'exception',           label: 'Exception'           },
  { id: 'missing',             label: 'Missing'             },
  { id: 'cancelled',           label: 'Cancelled'           },
  { id: 'other',               label: 'Other'               },
];
```

- [ ] **Step 2: Add refresh state + filtering by Freightcom status**

Replace the dashboard state/derivation (lines 34-41) with:
```ts
  // Dashboard
  const { shipments, loading: shipmentsLoading } = useAllShipments();
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);

  const unshippedOrders = orders.filter(o => o.shipment_status === null);
  const selectedQuote   = quotes.find(q => q.selected) ?? null;

  const fcStatusOf = (s: AllShipmentRow) => displayFreightcomStatus(s);
  const matchesFilter = (s: AllShipmentRow) => {
    if (filter === 'all') return true;
    const fc = fcStatusOf(s);
    if (filter === 'other') return !isKnownFreightcomStatus(fc);
    return fc === filter;
  };
  const filteredShipments = shipments.filter(matchesFilter);

  async function handleRefreshStatuses() {
    setRefreshErr(null);
    setRefreshing(true);
    try {
      const results = await refreshFreightcomStatuses(
        filteredShipments.map(s => ({ id: s.id, freightcom_shipment_id: s.freightcom_shipment_id })),
      );
      const failed = results.filter(r => r.error).length;
      if (failed > 0) setRefreshErr(`${failed} shipment(s) could not be refreshed.`);
      // Re-fetch by remounting the hook data: simplest is a full reload of the section.
      window.location.reload();
    } catch (e) {
      setRefreshErr((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
```
Note: `window.location.reload()` is the minimal re-fetch consistent with the current hook (which has no refetch fn). If the hook is later given a `refetch`, replace the reload with it.

- [ ] **Step 3: Update the chip counts to use Freightcom status**

In the All Shipments section (the `FILTERS.map` block, ~line 191), change the count calc:
```tsx
            const count = f.id === 'all'
              ? shipments.length
              : shipments.filter(s => {
                  const fc = displayFreightcomStatus(s);
                  return f.id === 'other' ? !isKnownFreightcomStatus(fc) : fc === f.id;
                }).length;
```

- [ ] **Step 4: Add the Refresh button + error banner above the table**

Immediately after the `<h3 className={styles.sectionTitle}>All Shipments</h3>` line, add:
```tsx
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '8px 0' }}>
          <button
            onClick={handleRefreshStatuses}
            disabled={refreshing || filteredShipments.length === 0}
            style={{ fontSize: 13, padding: '5px 12px', cursor: 'pointer' }}
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh from Freightcom'}
          </button>
          {refreshErr && (
            <span style={{ fontSize: 12, color: '#c53030' }}>{refreshErr}</span>
          )}
        </div>
```

- [ ] **Step 5: Update the status cell + add a "Synced" column**

In the table header row (~line 218), change the `Status` header to `Freightcom status` and add a `Synced` header before the trailing empty `<th>`:
```tsx
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Freightcom status</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Synced</th>
```
In the body, replace the status `<td>` (the one rendering `STATUS_BADGE_CLASS`) with:
```tsx
                  <td style={{ padding: '7px 12px' }}>
                    {(() => {
                      const fc = displayFreightcomStatus(s);
                      return (
                        <span className={`${styles.statusBadge} ${FC_BADGE_CLASS[fc] ?? ''}`}>
                          {fc}
                        </span>
                      );
                    })()}
                  </td>
```
And add a `Synced` cell immediately after the existing `Booked` cell:
```tsx
                  <td style={{ padding: '7px 12px', color: '#a0aec0', fontSize: 12 }}>
                    {s.status_synced_at ? new Date(s.status_synced_at).toLocaleString() : '—'}
                  </td>
```

- [ ] **Step 6: Fix the empty-state label (no underscores to replace anymore)**

Change the empty-state text (~line 209) so it does not call `.replace('_', ' ')` on a Freightcom status:
```tsx
            No {filter !== 'all' ? `"${filter}" ` : ''}shipments yet.
```

- [ ] **Step 7: Typecheck + run the full test suite**

Run: `cd app && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass (including `src/lib/shipping.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add app/src/modules/Shipping/tabs/ShippingTab.tsx
git commit -m "feat(shipping): All Shipments dashboard uses Freightcom statuses + live refresh"
```

---

## Task 6: Component test — filter + refresh wiring

**Files:**
- Create: `app/src/modules/Shipping/tabs/__tests__/ShippingTab.fcstatus.test.tsx`

- [ ] **Step 1: Write the test**

Create the file:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShippingTab } from '../ShippingTab';

// Mock the data layer so the component renders deterministic rows.
const refreshMock = vi.fn().mockResolvedValue([]);
vi.mock('../../../../lib/shipping', async (orig) => {
  const actual = await orig<typeof import('../../../../lib/shipping')>();
  return {
    ...actual, // keep FREIGHTCOM_STATUSES, displayFreightcomStatus, isKnownFreightcomStatus
    useShippingOrders: () => ({ orders: [], loading: false }),
    useAllShipments: () => ({
      loading: false,
      error: null,
      shipments: [
        { id: 's1', order_id: 'o1', order_ref: '#1134', customer_name: 'Jeff',
          carrier: 'FedEx', service: 'Ground', rate_cad: 20, primary_tracking_number: '77',
          status: 'booked', booked_at: '2026-06-01T00:00:00Z', label_url: null,
          freightcom_shipment_id: 'fc1', freightcom_status: 'in-transit', status_synced_at: '2026-06-02T00:00:00Z' },
        { id: 's2', order_id: 'o2', order_ref: '#1140', customer_name: 'Ann',
          carrier: 'Purolator', service: 'Express', rate_cad: 30, primary_tracking_number: '88',
          status: 'booked', booked_at: '2026-06-01T00:00:00Z', label_url: null,
          freightcom_shipment_id: 'fc2', freightcom_status: 'out-for-delivery', status_synced_at: null },
      ],
    }),
    useQuotes: () => ({ quotes: [], loading: false }),
    refreshFreightcomStatuses: refreshMock,
  };
});

beforeEach(() => refreshMock.mockClear());

describe('ShippingTab — Freightcom statuses', () => {
  it('renders Freightcom status labels', () => {
    render(<ShippingTab />);
    expect(screen.getByText('in-transit')).toBeTruthy();
    expect(screen.getByText('out-for-delivery')).toBeTruthy(); // unknown shown verbatim
  });

  it('groups unknown statuses under the "Other" filter', () => {
    render(<ShippingTab />);
    fireEvent.click(screen.getByText(/^Other/));
    expect(screen.getByText('out-for-delivery')).toBeTruthy();
    expect(screen.queryByText('in-transit')).toBeNull();
  });

  it('calls refreshFreightcomStatuses when the refresh button is clicked', () => {
    render(<ShippingTab />);
    fireEvent.click(screen.getByText(/Refresh from Freightcom/));
    expect(refreshMock).toHaveBeenCalledOnce();
  });
});
```
Note: if `window.location.reload` causes issues under jsdom, stub it at the top of the test with
`Object.defineProperty(window, 'location', { value: { reload: vi.fn() }, writable: true });`

- [ ] **Step 2: Run test to verify it passes**

Run: `cd app && npx vitest run src/modules/Shipping/tabs/__tests__/ShippingTab.fcstatus.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add app/src/modules/Shipping/tabs/__tests__/ShippingTab.fcstatus.test.tsx
git commit -m "test(shipping): All Shipments Freightcom status filter + refresh"
```

---

## Task 7: Manual validation + final checks

- [ ] **Step 1: Build**

Run: `cd app && npm run build`
Expected: build succeeds, no type errors.

- [ ] **Step 2: Manual smoke (operator with Freightcom creds)**

In the running app: Shipping tab → All Shipments. Confirm:
- Status badges show Freightcom vocabulary (`in-transit`, `waiting-for-transit`, …).
- Filter chips (incl. "Other") filter correctly with counts.
- "↻ Refresh from Freightcom" pulls live status, updates badges, and stamps the Synced column.
- A shipment with an unexpected Freightcom state appears under "Other" with its raw value.

- [ ] **Step 3: Open PR**

```bash
git push -u origin feat/freightcom-tracking-dashboard
gh pr create --title "feat(shipping): Freightcom tracking dashboard (All Shipments)" \
  --body "Upgrades the All Shipments section to display live Freightcom statuses with on-demand refresh. See docs/superpowers/specs/2026-06-25-freightcom-tracking-dashboard-design.md. NOTE: requires deploying the freightcom-status edge function."
```
(Push/PR only when the user asks — see repo git constraints.)

---

## Notes / known constraints

- Edge function deploy and the DB migration require an operator with Supabase project access; the agent cannot push or deploy from this environment.
- `window.location.reload()` in Task 5 is a deliberate minimal re-fetch because `useAllShipments` exposes no refetch function. A follow-up could add `refetch` to the hook and replace the reload.
