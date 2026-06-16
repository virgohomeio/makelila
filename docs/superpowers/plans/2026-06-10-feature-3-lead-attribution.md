# Feature 3: Lead Attribution Fields

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture first-touch and last-touch marketing attribution on every customer record by parsing UTM params from Shopify's `landing_site_ref` and HubSpot's `hs_analytics_source`, then surface the attribution as chips on the Customer Journey tab.

**Architecture:** Six new columns on `customers` (first/last touch source + campaign_id + timestamp). Two edge functions (`sync-shopify-orders`, `sync-hubspot-customers`) write first-touch at customer-create time (insert-only). `lib/customers.ts` gets an `updateLastTouch` mutation. `JourneyTab.tsx` renders two chips above the stage timeline.

**Tech Stack:** React 18 + TypeScript, CSS Modules, Supabase Postgres + Edge Functions (Deno), Vitest

---

## File Map

| File | Change |
|------|--------|
| `app/supabase/migrations/20260611120000_customer_lead_attribution.sql` | Create — 6 columns + 2 indexes |
| `app/src/lib/customers.ts` | Modify — extend `Customer` type; add `parseUtm`, `updateLastTouch` |
| `app/src/lib/customers.test.ts` | Create — unit tests for `parseUtm` |
| `app/src/modules/Customers/JourneyTab.tsx` | Modify — render attribution chips |
| `supabase/functions/sync-shopify-orders/index.ts` | Modify — parse UTM on new customer insert |
| `supabase/functions/sync-hubspot-customers/index.ts` | Modify — map `hs_analytics_source` on new customer insert |

---

### Task 1: Schema migration

**Files:**
- Create: `app/supabase/migrations/20260611120000_customer_lead_attribution.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Lead attribution fields for Pedrum's CAC-by-channel and CampaignsTab views.
-- first_touch_* is written once at customer creation and never overwritten.
-- last_touch_* is updated by updateLastTouch() on subsequent marketing interactions.
ALTER TABLE customers
  ADD COLUMN first_touch_source      text NULL,
  ADD COLUMN first_touch_campaign_id text NULL,
  ADD COLUMN first_touch_at          timestamptz NULL,
  ADD COLUMN last_touch_source       text NULL,
  ADD COLUMN last_touch_campaign_id  text NULL,
  ADD COLUMN last_touch_at           timestamptz NULL;

CREATE INDEX idx_customers_first_touch_campaign
  ON customers(first_touch_campaign_id)
  WHERE first_touch_campaign_id IS NOT NULL;

CREATE INDEX idx_customers_last_touch_campaign
  ON customers(last_touch_campaign_id)
  WHERE last_touch_campaign_id IS NOT NULL;
```

- [ ] **Step 2: Apply to remote**

```bash
cd app
./node_modules/.bin/supabase db push --linked
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260611120000_customer_lead_attribution.sql
git commit -m "feat(db): add customer lead attribution columns (first/last touch)"
```

---

### Task 2: `parseUtm` function + tests

**Files:**
- Modify: `app/src/lib/customers.ts`
- Create: `app/src/lib/customers.test.ts`

- [ ] **Step 1: Write the tests**

Create `app/src/lib/customers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseUtm } from './customers';

describe('parseUtm', () => {
  it('extracts utm_source and utm_campaign from a URL', () => {
    expect(
      parseUtm('https://lila.vip/?utm_source=facebook&utm_campaign=spring-2026-q1&fbclid=abc'),
    ).toEqual({ source: 'facebook', campaign: 'spring-2026-q1' });
  });

  it('returns shopify_direct when no UTM params are present', () => {
    expect(parseUtm('https://lila.vip/')).toEqual({ source: 'shopify_direct', campaign: null });
  });

  it('returns null for both on empty / null input', () => {
    expect(parseUtm('')).toEqual({ source: null, campaign: null });
    expect(parseUtm(null)).toEqual({ source: null, campaign: null });
  });

  it('handles malformed URL gracefully', () => {
    expect(parseUtm('not a url %^&')).toEqual({ source: null, campaign: null });
  });

  it('returns utm_source only when utm_campaign is absent', () => {
    expect(parseUtm('https://lila.vip/?utm_source=google')).toEqual({
      source: 'google',
      campaign: null,
    });
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- customers
```
Expected: FAIL "parseUtm is not exported from ./customers".

- [ ] **Step 3: Add `parseUtm` to `lib/customers.ts`**

Add the 6 new fields to the `Customer` type (after `updated_at`):

```ts
  // Lead attribution — written once at customer-create (insert-only).
  // See migration 20260611120000_customer_lead_attribution.sql.
  first_touch_source: string | null;
  first_touch_campaign_id: string | null;
  first_touch_at: string | null;
  last_touch_source: string | null;
  last_touch_campaign_id: string | null;
  last_touch_at: string | null;
```

Add `parseUtm` as an exported function (after the `Customer` type definition):

```ts
/** Parse UTM source + campaign from a Shopify landing_site_ref URL.
 *  Returns { source: 'shopify_direct', campaign: null } when no UTM params
 *  are present but the URL is valid. Returns nulls on empty / malformed input.
 *  Keep raw strings — normalization happens in the CampaignsTab view. */
export function parseUtm(
  landingUrl: string | null | undefined,
): { source: string | null; campaign: string | null } {
  if (!landingUrl) return { source: null, campaign: null };
  try {
    const url = new URL(landingUrl);
    const source = url.searchParams.get('utm_source');
    const campaign = url.searchParams.get('utm_campaign');
    if (!source) return { source: 'shopify_direct', campaign: null };
    return { source, campaign };
  } catch {
    return { source: null, campaign: null };
  }
}
```

Add `updateLastTouch` mutation (after `parseUtm`):

```ts
/** Update last-touch attribution on an existing customer.
 *  Called when a customer clicks a tracked email / ad (Feature 1 firehose
 *  can call this on 'journey_stage_changed' events). */
export async function updateLastTouch(
  customerId: string,
  source: string,
  campaignId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('customers')
    .update({
      last_touch_source: source,
      last_touch_campaign_id: campaignId,
      last_touch_at: new Date().toISOString(),
    })
    .eq('id', customerId);
  if (error) throw error;
  await logAction(
    'customer_last_touch_updated',
    customerId,
    `source=${source} campaign=${campaignId ?? 'none'}`,
    { entityType: 'customer', entityId: customerId },
  );
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- customers
```
Expected: all 5 `parseUtm` tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/customers.ts app/src/lib/customers.test.ts
git commit -m "feat(customers): add parseUtm, updateLastTouch, and attribution fields to Customer type"
```

---

### Task 3: Attribution chips on JourneyTab

**Files:**
- Modify: `app/src/modules/Customers/JourneyTab.tsx`

The JourneyTab renders a per-customer journey view. The `customer` object now has the 6 attribution fields. Add a chip row just above the existing stage timeline.

- [ ] **Step 1: Write a snapshot test for the attribution chips**

Create `app/src/modules/Customers/__tests__/JourneyTabAttribution.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { Customer } from '../../../lib/customers';

// Minimal stub — we only test the attribution chip rendering, not the full
// Journey tab (which has heavy hook dependencies).
function AttributionChips({ customer }: { customer: Pick<Customer, 'first_touch_source' | 'first_touch_campaign_id' | 'last_touch_source' | 'last_touch_campaign_id'> }) {
  const first = customer.first_touch_source;
  const last  = customer.last_touch_source;
  if (!first && !last) {
    return <span data-testid="attribution-unknown">Attribution unknown</span>;
  }
  return (
    <div data-testid="attribution-chips">
      {first && (
        <span data-testid="first-touch">
          First touch: {first}{customer.first_touch_campaign_id ? ` · ${customer.first_touch_campaign_id}` : ''}
        </span>
      )}
      {last && (
        <span data-testid="last-touch">
          Last touch: {last}{customer.last_touch_campaign_id ? ` · ${customer.last_touch_campaign_id}` : ''}
        </span>
      )}
    </div>
  );
}

describe('JourneyTab attribution chips', () => {
  it('renders both chips when attribution is fully populated', () => {
    const { getByTestId } = render(<AttributionChips customer={{
      first_touch_source: 'facebook',
      first_touch_campaign_id: 'spring-2026-q1',
      last_touch_source: 'klaviyo',
      last_touch_campaign_id: 'welcome-series-v3',
    }} />);
    expect(getByTestId('first-touch').textContent).toContain('facebook · spring-2026-q1');
    expect(getByTestId('last-touch').textContent).toContain('klaviyo · welcome-series-v3');
  });

  it('shows attribution unknown when all fields null', () => {
    const { getByTestId } = render(<AttributionChips customer={{
      first_touch_source: null,
      first_touch_campaign_id: null,
      last_touch_source: null,
      last_touch_campaign_id: null,
    }} />);
    expect(getByTestId('attribution-unknown')).toBeTruthy();
  });

  it('renders first-touch only when last-touch is null', () => {
    const { queryByTestId } = render(<AttributionChips customer={{
      first_touch_source: 'shopify_direct',
      first_touch_campaign_id: null,
      last_touch_source: null,
      last_touch_campaign_id: null,
    }} />);
    expect(queryByTestId('first-touch')?.textContent).toContain('shopify_direct');
    expect(queryByTestId('last-touch')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect pass (testing the stub component)**

```bash
npm test -- JourneyTabAttribution
```
Expected: 3 tests pass.

- [ ] **Step 3: Add the attribution chip row to JourneyTab.tsx**

In `JourneyTab.tsx`, find where the Journey detail panel renders — it renders a `journey.customer` object. Find the block that renders the stage timeline (look for `STAGES.map` or `stageTimeline`).

Before that stage-timeline block, add:

```tsx
{/* Attribution chips — Feature 3 */}
{(() => {
  const c = journey.customer;
  const first = c.first_touch_source;
  const last  = c.last_touch_source;
  if (!first && !last) {
    return (
      <div style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--color-ink-subtle)', fontStyle: 'italic' }}>
          Attribution unknown
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
      {first && (
        <span style={{
          fontSize: 10, padding: '3px 8px', borderRadius: 4,
          background: '#ebf8ff', color: '#2c5282', border: '1px solid #90cdf4',
          fontWeight: 600,
        }}>
          First touch: {first}{c.first_touch_campaign_id ? ` · ${c.first_touch_campaign_id}` : ''}
        </span>
      )}
      {last && (
        <span style={{
          fontSize: 10, padding: '3px 8px', borderRadius: 4,
          background: '#f0fff4', color: '#276749', border: '1px solid #9ae6b4',
          fontWeight: 600,
        }}>
          Last touch: {last}{c.last_touch_campaign_id ? ` · ${c.last_touch_campaign_id}` : ''}
        </span>
      )}
    </div>
  );
})()}
```

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/Customers/JourneyTab.tsx \
        app/src/modules/Customers/__tests__/JourneyTabAttribution.test.tsx
git commit -m "feat(customers): add attribution chips to JourneyTab"
```

---

### Task 4: Wire Shopify sync — parse UTM on new customer

**Files:**
- Modify: `supabase/functions/sync-shopify-orders/index.ts`

- [ ] **Step 1: Read the file to find the customer-insert code path**

```bash
grep -n "customers" supabase/functions/sync-shopify-orders/index.ts | head -30
```

Find the block that inserts a new `customers` row (or upserts). It will have something like `admin.from('customers').upsert(...)` or `.insert(...)`.

- [ ] **Step 2: Add UTM parsing to the customer insert**

In the same Deno edge function, add a `parseUtm` helper (copy the same logic as `lib/customers.ts` — don't import from the client lib):

```ts
function parseUtm(landingUrl: string | null | undefined): { source: string | null; campaign: string | null } {
  if (!landingUrl) return { source: null, campaign: null };
  try {
    const url = new URL(landingUrl);
    const source = url.searchParams.get('utm_source');
    const campaign = url.searchParams.get('utm_campaign');
    if (!source) return { source: 'shopify_direct', campaign: null };
    return { source, campaign };
  } catch {
    return { source: null, campaign: null };
  }
}
```

In the customer insert block, add the attribution fields. The Shopify order payload has `landing_site` (the full URL with UTM params):

```ts
const utm = parseUtm(shopifyOrder.landing_site ?? shopifyOrder.landing_site_ref ?? null);

// Inside the customer insert/upsert object, add:
// Only set first_touch_* if not already present (insert-only rule per system-of-record.md).
// Use onConflict + ignoreDuplicates or a conditional update.
const customerInsert = {
  email: shopifyOrder.email?.toLowerCase(),
  // ... existing fields ...
  // Attribution: only on new inserts — existing rows keep their first_touch.
  first_touch_source: utm.source,
  first_touch_campaign_id: utm.campaign,
  first_touch_at: shopifyOrder.created_at ?? new Date().toISOString(),
};
```

When upserting with `onConflict: 'email'`, add `ignoreDuplicates: false` and use `setFirst` logic OR use a separate UPDATE that only fires when `first_touch_source IS NULL`:

```ts
// After the upsert, if this is an existing customer whose first_touch is null, backfill it.
if (utm.source) {
  await admin
    .from('customers')
    .update({
      first_touch_source: utm.source,
      first_touch_campaign_id: utm.campaign,
      first_touch_at: shopifyOrder.created_at ?? new Date().toISOString(),
    })
    .eq('email', shopifyOrder.email.toLowerCase())
    .is('first_touch_source', null);  // only updates if not already set
}
```

- [ ] **Step 3: Deploy the updated function**

```bash
cd app
./node_modules/.bin/supabase functions deploy sync-shopify-orders --project-ref txeftbbzeflequvrmjjr
```
Expected: "Deployed function sync-shopify-orders."

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/sync-shopify-orders/index.ts
git commit -m "feat(shopify-sync): parse UTM from landing_site and populate first_touch attribution"
```

---

### Task 5: Wire HubSpot sync — map `hs_analytics_source`

**Files:**
- Modify: `supabase/functions/sync-hubspot-customers/index.ts`

- [ ] **Step 1: Read the file to find the customer insert code path**

```bash
grep -n "customers\|hs_analytics" supabase/functions/sync-hubspot-customers/index.ts | head -20
```

- [ ] **Step 2: Map HubSpot's analytics source to our attribution fields**

HubSpot's `hs_analytics_source` returns enum strings like `PAID_SOCIAL`, `ORGANIC_SEARCH`, `EMAIL_MARKETING`, `DIRECT_TRAFFIC`. Map them to friendly source labels and add to the customer insert.

Add a mapping helper inside the edge function:

```ts
function mapHubspotSource(hsSource: string | null): string | null {
  if (!hsSource) return null;
  const MAP: Record<string, string> = {
    PAID_SOCIAL:      'facebook',
    ORGANIC_SEARCH:   'organic_search',
    EMAIL_MARKETING:  'email',
    DIRECT_TRAFFIC:   'direct',
    PAID_SEARCH:      'google_ads',
    REFERRALS:        'referral',
  };
  return MAP[hsSource] ?? hsSource.toLowerCase();
}
```

In the customer insert block:

```ts
const hsSource = contact.properties?.hs_analytics_source ?? null;
const hsCampaign = contact.properties?.hs_analytics_source_data_1 ?? null;
const hsCreatedAt = contact.properties?.createdate ?? null;

// Add to insert object (only when first_touch_source IS NULL):
await admin
  .from('customers')
  .update({
    first_touch_source: mapHubspotSource(hsSource),
    first_touch_campaign_id: hsCampaign,
    first_touch_at: hsCreatedAt,
  })
  .eq('email', contact.properties.email.toLowerCase())
  .is('first_touch_source', null);
```

- [ ] **Step 3: Deploy**

```bash
./node_modules/.bin/supabase functions deploy sync-hubspot-customers --project-ref txeftbbzeflequvrmjjr
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/sync-hubspot-customers/index.ts
git commit -m "feat(hubspot-sync): map hs_analytics_source to first_touch attribution fields"
```

---

### Task 6: Manual E2E validation

- [ ] **Step 1: Trigger a Shopify order sync with a UTM URL**

In the Supabase Edge Function logs, confirm the `sync-shopify-orders` function ran without errors after a new order webhook.

- [ ] **Step 2: Check attribution in the DB**

```sql
SELECT full_name, email, first_touch_source, first_touch_campaign_id, last_touch_source
FROM customers
WHERE first_touch_source IS NOT NULL
LIMIT 10;
```
Expected: rows show `first_touch_source` values like `facebook`, `shopify_direct`, etc.

- [ ] **Step 3: Open Customers → Journey tab**

Open any customer with a populated `first_touch_source`. Confirm the blue "First touch: facebook · spring-2026-q1" chip renders above the stage timeline.

- [ ] **Step 4: Confirm chips don't appear for fully-null rows**

Open a customer with no attribution data. Confirm "Attribution unknown" renders in muted italic style.
