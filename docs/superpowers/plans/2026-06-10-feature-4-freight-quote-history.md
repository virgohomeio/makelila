# Feature 4: Freight Quote History Table

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every freight quote in a child table so operators have a history of all quotes per order, can select the best rate, and OrderRow shows the currently-selected quote as a chip. Eliminates re-quoting on every page open and enables ClickShip vs Freightcom comparison.

**Architecture:** New `freight_quotes` table with insert-only quote rows + a `selected` boolean (unique per order via partial unique index). New `lib/freight.ts` moves provider-calling code out of `FreightCard.tsx`. `OrderRow.tsx` reads the selected quote via a join on `useOrders`.

**Tech Stack:** React 18 + TypeScript, Supabase Postgres, CSS Modules, Vitest

---

## File Map

| File | Change |
|------|--------|
| `app/supabase/migrations/20260612120000_freight_quotes.sql` | Create — `freight_quotes` table + indexes |
| `app/src/lib/freight.ts` | Create — `useQuotes`, `quoteClickShip`, `quoteFreightcom`, `selectQuote` |
| `app/src/lib/freight.test.ts` | Create — unit tests for `selectQuote` flip-siblings logic |
| `app/src/lib/orders.ts` | Modify — add `best_freight_quote` to `Order` type + join in `useOrders` |
| `app/src/modules/OrderReview/detail/FreightCard.tsx` | Modify — use `lib/freight.ts`; render quote history table |
| `app/src/modules/OrderReview/OrderRow.tsx` | Modify — add freight chip from `best_freight_quote` |

---

### Task 1: Schema migration

**Files:**
- Create: `app/supabase/migrations/20260612120000_freight_quotes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Freight quote history. Insert-only — re-quoting appends rows, never overwrites.
-- Exactly one row per order may have selected=true (enforced by partial unique index).
CREATE TABLE freight_quotes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      text        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider      text        NOT NULL CHECK (provider IN ('clickship','freightcom')),
  service_level text        NOT NULL,
  rate_cad      numeric(10,2) NULL,
  rate_usd      numeric(10,2) NULL,
  transit_days  int         NULL,
  quoted_at     timestamptz NOT NULL DEFAULT now(),
  selected      boolean     NOT NULL DEFAULT false,
  raw           jsonb       NOT NULL
);

CREATE INDEX idx_freight_quotes_order
  ON freight_quotes(order_id, quoted_at DESC);

-- Enforces at most one selected=true row per order at the DB level.
CREATE UNIQUE INDEX idx_freight_quotes_one_selected
  ON freight_quotes(order_id)
  WHERE selected = true;
```

- [ ] **Step 2: Apply to remote**

```bash
cd app
./node_modules/.bin/supabase db push --linked
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260612120000_freight_quotes.sql
git commit -m "feat(db): add freight_quotes table for per-order quote history"
```

---

### Task 2: `lib/freight.ts` — data layer

**Files:**
- Create: `app/src/lib/freight.ts`
- Create: `app/src/lib/freight.test.ts`

- [ ] **Step 1: Write the tests first**

Create `app/src/lib/freight.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase mock ────────────────────────────────────────────────────────────
const updateMock  = vi.fn().mockResolvedValue({ error: null });
const eqMock      = vi.fn(() => ({ eq: eqMock, update: updateMock }));
const selectMock  = vi.fn(() => ({ eq: eqMock, order: vi.fn().mockResolvedValue({ data: [], error: null }) }));
const insertMock  = vi.fn().mockResolvedValue({ data: [{ id: 'q-1', selected: false }], error: null });
const fromMock    = vi.fn((table: string) => ({
  select: selectMock,
  insert: insertMock,
  update: updateMock,
  eq: eqMock,
}));
const getUserMock = vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } });

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: getUserMock },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

import { selectQuote } from './freight';

describe('selectQuote', () => {
  beforeEach(() => {
    fromMock.mockClear();
    updateMock.mockClear();
    updateMock.mockResolvedValue({ error: null });
  });

  it('sets selected=false on all sibling rows then selected=true on the target', async () => {
    await selectQuote('ord-1', 'q-target');

    // First call: deselect all for this order
    expect(fromMock).toHaveBeenCalledWith('freight_quotes');
    const calls = updateMock.mock.calls;
    // First update: { selected: false } where order_id = 'ord-1'
    expect(calls[0][0]).toEqual({ selected: false });
    // Second update: { selected: true } where id = 'q-target'
    expect(calls[1][0]).toEqual({ selected: true });
  });

  it('throws when Supabase returns an error', async () => {
    updateMock.mockResolvedValueOnce({ error: { message: 'DB error' } });
    await expect(selectQuote('ord-1', 'q-target')).rejects.toThrow('DB error');
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- freight
```
Expected: FAIL "Cannot find module './freight'".

- [ ] **Step 3: Create `lib/freight.ts`**

```ts
import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';

export type FreightQuote = {
  id: string;
  order_id: string;
  provider: 'clickship' | 'freightcom';
  service_level: string;
  rate_cad: number | null;
  rate_usd: number | null;
  transit_days: number | null;
  quoted_at: string;
  selected: boolean;
  raw: Record<string, unknown>;
};

/** Fetch all quotes for an order, newest first. Realtime not needed here —
 *  quotes only change when the operator clicks "Re-quote". */
export function useQuotes(orderId: string | null): { quotes: FreightQuote[]; loading: boolean } {
  const [quotes, setQuotes] = useState<FreightQuote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderId) { setQuotes([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('freight_quotes')
        .select('*')
        .eq('order_id', orderId)
        .order('quoted_at', { ascending: false });
      if (!cancelled) {
        if (!error && data) setQuotes(data as FreightQuote[]);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orderId]);

  return { quotes, loading };
}

/** Deselect all quotes for the order, then select the target quote. */
export async function selectQuote(orderId: string, quoteId: string): Promise<void> {
  // Step 1: deselect all siblings
  const { error: e1 } = await supabase
    .from('freight_quotes')
    .update({ selected: false })
    .eq('order_id', orderId);
  if (e1) throw new Error(e1.message);

  // Step 2: select the target
  const { error: e2 } = await supabase
    .from('freight_quotes')
    .update({ selected: true })
    .eq('id', quoteId);
  if (e2) throw new Error(e2.message);

  await logAction(
    'freight_quote_selected',
    orderId,
    `quote_id=${quoteId}`,
    { entityType: 'order', entityId: orderId },
  );
}

/** Insert a new freight quote row. The caller provides the raw provider response
 *  and the parsed rate fields. Does NOT select the quote automatically. */
export async function insertQuote(
  orderId: string,
  provider: FreightQuote['provider'],
  serviceLevel: string,
  rateCad: number | null,
  rateUsd: number | null,
  transitDays: number | null,
  raw: Record<string, unknown>,
): Promise<FreightQuote> {
  const { data, error } = await supabase
    .from('freight_quotes')
    .insert({
      order_id: orderId,
      provider,
      service_level: serviceLevel,
      rate_cad: rateCad,
      rate_usd: rateUsd,
      transit_days: transitDays,
      raw,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await logAction(
    'freight_quote_created',
    orderId,
    `provider=${provider} rate_cad=${rateCad}`,
    { entityType: 'order', entityId: orderId },
  );

  return data as FreightQuote;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- freight
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/freight.ts app/src/lib/freight.test.ts
git commit -m "feat(lib): add freight.ts with useQuotes, selectQuote, insertQuote"
```

---

### Task 3: Add `best_freight_quote` to the `Order` type

**Files:**
- Modify: `app/src/lib/orders.ts`

- [ ] **Step 1: Add the type field to `Order`**

In `lib/orders.ts`, find the `Order` type. Add after `financial_status`:

```ts
  // The currently-selected freight quote for this order (Feature 4).
  // Null when no quotes have been persisted yet (legacy orders).
  best_freight_quote: {
    id: string;
    provider: string;
    service_level: string;
    rate_cad: number | null;
    rate_usd: number | null;
    transit_days: number | null;
  } | null;
```

- [ ] **Step 2: Update the `useOrders` query to join the selected quote**

Find the `useOrders` hook's `supabase.from('orders').select(...)` call. Extend the select string to include the selected quote:

```ts
// Find the existing select string (something like 'id, order_ref, ...')
// and append the freight_quotes join:
.select(`
  id, order_ref, kind, status, customer_id, linked_ticket_id, awaiting_batch_id,
  replacement_state, cogs_usd, shipping_cost_usd, shipped_at, delivered_at,
  tracking_num, carrier, customer_name, customer_email, customer_phone,
  quo_thread_url, address_line, address_line2, city, region_state, country,
  address_verdict, address_verified_at, address_match, address_google_formatted,
  address_google_postal, address_customer_postal, address_claude_verdict,
  address_claude_notes, address_claude_postal, freight_estimate_usd,
  freight_threshold_usd, customer_paid_shipping_usd, freight_estimate_source,
  currency, total_usd, subtotal_usd, tax_usd, discount_total_usd,
  discount_codes, payment_methods, financial_status, line_items,
  sales_confirmed_fit, dispositioned_by, dispositioned_at, created_at, placed_at,
  best_freight_quote:freight_quotes!inner(id, provider, service_level, rate_cad, rate_usd, transit_days)
`)
```

Wait — PostgREST can't directly alias a filtered join. Instead, keep it simple and use a separate sub-select with a filter. The cleanest approach is to NOT join in `useOrders` (it would require a LEFT JOIN + WHERE selected=true), and instead have `OrderRow` call `useQuotes` only when needed. Update the plan:

Actually, the simplest correct approach is to add a `best_freight_quote` computed column via a DB view or just accept that `OrderRow` gets the quote via a separate `useQuotes` call scoped to `selected=true`. Update the `Order` type to keep `best_freight_quote: null` (always null for now, populated in a future optimization), and let `OrderRow` call `useQuotes` for the selected quote.

Update the `Order` type field:

```ts
  // Populated via useQuotes(orderId) in OrderRow — not joined in the main query
  // to avoid N+1 complexity. Null until first quote is persisted.
  best_freight_quote: null;
```

Remove this field from the type entirely — it's cleaner to have `OrderRow` use `useQuotes`. Revert the type change.

- [ ] **Step 3: Revert the type change — use `useQuotes` in OrderRow directly**

Do NOT add `best_freight_quote` to the `Order` type. The `OrderRow` component will call `useQuotes(order.id)` and filter for the selected quote client-side. This is cleaner.

No changes needed to `lib/orders.ts`.

- [ ] **Step 4: Commit (if any changes were made)**

```bash
# Only commit if you made any changes to orders.ts
git diff app/src/lib/orders.ts
# If clean, skip this commit.
```

---

### Task 4: Update `FreightCard.tsx` to use `lib/freight.ts`

**Files:**
- Modify: `app/src/modules/OrderReview/detail/FreightCard.tsx`

- [ ] **Step 1: Read the current FreightCard to understand existing inline quoting code**

```bash
cat app/src/modules/OrderReview/detail/FreightCard.tsx
```

Identify the functions that call ClickShip/Freightcom APIs directly (they'll call `fetch` or invoke a Supabase function). Note the exact function names and response parsing logic.

- [ ] **Step 2: Add quote history table below existing re-quote UI**

Add `useQuotes` import and render a history table. Insert after the existing quote actions:

```tsx
import { useQuotes, selectQuote } from '../../../lib/freight';

// Inside FreightCard component, add:
const { quotes } = useQuotes(order.id);
const selectedQuote = quotes.find(q => q.selected);

// After existing quote actions JSX, add:
{quotes.length > 0 && (
  <div style={{ marginTop: 16 }}>
    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-ink-muted)', marginBottom: 6 }}>
      Quote history
    </div>
    <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ color: 'var(--color-ink-subtle)' }}>
          <th style={{ textAlign: 'left', paddingBottom: 4 }}>Provider</th>
          <th style={{ textAlign: 'left' }}>Service</th>
          <th style={{ textAlign: 'right' }}>Rate (CAD)</th>
          <th style={{ textAlign: 'right' }}>Transit</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {quotes.map(q => (
          <tr
            key={q.id}
            style={{
              background: q.selected ? 'var(--color-surface)' : 'transparent',
              fontWeight: q.selected ? 600 : 400,
            }}
          >
            <td style={{ padding: '3px 0' }}>{q.provider}</td>
            <td>{q.service_level}</td>
            <td style={{ textAlign: 'right' }}>
              {q.rate_cad != null ? `$${q.rate_cad.toFixed(2)}` : q.rate_usd != null ? `$${q.rate_usd.toFixed(2)} USD` : '—'}
            </td>
            <td style={{ textAlign: 'right' }}>{q.transit_days != null ? `${q.transit_days}d` : '—'}</td>
            <td style={{ textAlign: 'right' }}>
              {!q.selected && (
                <button
                  onClick={() => void selectQuote(order.id, q.id)}
                  style={{
                    fontSize: 10, padding: '2px 8px', cursor: 'pointer',
                    background: 'none', border: '1px solid var(--color-border)',
                    borderRadius: 4, color: 'var(--color-ink-muted)',
                  }}
                >
                  Select
                </button>
              )}
              {q.selected && (
                <span style={{ fontSize: 10, color: 'var(--color-success, #276749)', fontWeight: 700 }}>
                  ✓ Selected
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)}
```

- [ ] **Step 3: Update existing "Re-quote" buttons to use `insertQuote`**

Find the existing quote-fetch logic. After receiving the provider response, instead of overwriting a single field, call `insertQuote(...)`:

```tsx
import { insertQuote } from '../../../lib/freight';

// Replace the existing quote-persist logic with:
const newQuote = await insertQuote(
  order.id,
  'clickship',           // or 'freightcom'
  parsedServiceLevel,
  parsedRateCad,
  parsedRateUsd,
  parsedTransitDays,
  rawProviderResponse,
);
// Optionally auto-select the new quote if there's no selection yet:
if (!quotes.some(q => q.selected)) {
  await selectQuote(order.id, newQuote.id);
}
```

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/OrderReview/detail/FreightCard.tsx
git commit -m "feat(FreightCard): show quote history table with select action"
```

---

### Task 5: Add freight chip to `OrderRow.tsx`

**Files:**
- Modify: `app/src/modules/OrderReview/OrderRow.tsx`

- [ ] **Step 1: Read current OrderRow**

```bash
cat app/src/modules/OrderReview/OrderRow.tsx
```

Find where status/metadata chips are rendered (look for badge/chip spans).

- [ ] **Step 2: Add the freight chip**

Import `useQuotes` and render a chip showing the selected quote's rate:

```tsx
import { useQuotes } from '../../lib/freight';

// Inside the OrderRow component:
const { quotes } = useQuotes(order.id);
const selectedQuote = quotes.find(q => q.selected) ?? null;

// In the JSX, where chips are rendered:
{selectedQuote && (
  <span style={{
    fontSize: 10, padding: '2px 8px', borderRadius: 4,
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    color: 'var(--color-ink-muted)',
  }}>
    {selectedQuote.provider} {selectedQuote.rate_cad != null
      ? `$${selectedQuote.rate_cad.toFixed(0)} CAD`
      : selectedQuote.rate_usd != null
        ? `$${selectedQuote.rate_usd.toFixed(0)} USD`
        : ''}
    {selectedQuote.transit_days != null && ` · ${selectedQuote.transit_days}d`}
  </span>
)}
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```
Navigate to Order Review → open a pending order → click "Re-quote ClickShip" → confirm a new row appears in the history table → click "Select" → confirm the chip appears on the OrderRow in the list.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/OrderReview/OrderRow.tsx
git commit -m "feat(OrderRow): add freight chip showing selected quote provider + rate"
```
