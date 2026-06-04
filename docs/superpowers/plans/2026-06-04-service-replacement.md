# Service Replacement Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a replacement-order workflow to the Service module — operator opens a ticket, picks parts/units in a cart modal, and an internal replacement order flows through Order Review → Fulfillment → Post-Shipment with auto-close on delivery.

**Architecture:** Single `orders` table with a `kind` discriminator. Send-replacement creates a `kind='replacement'` order in `status='pending'`; existing pipeline modules add visual badges + a few branch points (payment card hidden, shipping_cost prompt at ship, mark-delivered auto-closes the linked ticket). Cart-style picker pulls parts from `parts` and units from `units` where status='ready'.

**Tech Stack:** React 18 + TypeScript + Vite, CSS Modules, Vitest + React Testing Library, Playwright, Supabase Postgres + RLS + Realtime.

**Coordination note — pre-existing `replacement_queue`:** PostShipment's `ReplacementsTab.tsx` and the `replacement_queue` table already exist. That's a separate triage view (auto-classifies support tickets that mention "replacement" keywords). It is NOT retired by this work — both surfaces coexist: the existing tab is "tickets that probably need a replacement"; the new Service tab is "open replacement orders". A future plan can fold them together, but this plan leaves `replacement_queue` alone.

**Spec:** [docs/superpowers/specs/2026-06-04-service-replacement-design.md](../specs/2026-06-04-service-replacement-design.md)

---

## File Structure

**New files:**
- `supabase/migrations/20260604210000_replacement_workflow.sql` — schema + helper function + RLS
- `app/src/modules/Service/ReplacementPickerModal.tsx` — picker UI
- `app/src/modules/Service/ReplacementTab.tsx` — pivoted from RepairTab; lists replacement orders
- `app/src/modules/Service/__tests__/ReplacementPickerModal.test.tsx`
- `app/src/modules/Service/__tests__/ReplacementTab.test.tsx`
- `app/src/lib/orders.test.ts` (if no existing test file for orders)
- `app/tests/e2e/replacement-workflow.spec.ts` — Playwright

**Modified files:**
- `app/src/lib/orders.ts` — `Order` type extended; new `createReplacementOrder`, `markOrderShipped`, `markOrderDelivered`, `nextReplacementOrderRef`
- `app/src/lib/service.ts` — `ServiceTicket.replacement_order_id` field
- `app/src/modules/Service/index.tsx` — label "Repair" → "Replacement"; swap `RepairTab` for `ReplacementTab`
- `app/src/modules/Service/TicketDetailPanel.tsx` — "Send replacement" button + modal trigger
- `app/src/modules/Service/Service.module.css` — modal styles
- `app/src/modules/OrderReview/Detail.tsx` — replacement badge + originating-ticket section
- `app/src/modules/OrderReview/detail/LineItemsCard.tsx` — render part/unit line items
- `app/src/modules/OrderReview/OrderRow.tsx` — badge on row
- `app/src/modules/Fulfillment/queue/StepFulfilled.tsx` — shipping_cost_usd prompt + `markOrderShipped` call
- `app/src/modules/Fulfillment/queue/QueueSidebar.tsx` — badge on queue row
- `app/src/modules/PostShipment/HistoryTab.tsx` — Mark-delivered button + badge

**Deleted files:**
- `app/src/modules/Service/RepairTab.tsx` (replaced by `ReplacementTab.tsx`)

---

## Task 1: SQL migration

**Files:**
- Create: `supabase/migrations/20260604210000_replacement_workflow.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Replacement workflow (spec: docs/superpowers/specs/2026-06-04-service-replacement-design.md)
-- Adds the orders.kind discriminator, links to service_tickets, COGS + actual
-- shipping cost columns, and ship/deliver timestamps. The existing
-- orders.status ('pending'|'approved'|'flagged'|'held') stays for Order
-- Review's pipeline; downstream Fulfillment / Post-Shipment state is implied
-- by shipped_at / delivered_at being non-null.

alter table public.orders
  add column if not exists kind text not null default 'sale',
  add column if not exists linked_ticket_id uuid references public.service_tickets(id) on delete set null,
  add column if not exists cogs_usd numeric(10,2),
  add column if not exists shipping_cost_usd numeric(10,2),
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz;

alter table public.orders
  drop constraint if exists orders_kind_check;
alter table public.orders
  add constraint orders_kind_check check (kind in ('sale', 'replacement'));

create index if not exists orders_kind_idx on public.orders(kind);
create index if not exists orders_linked_ticket_idx on public.orders(linked_ticket_id)
  where linked_ticket_id is not null;

alter table public.service_tickets
  add column if not exists replacement_order_id uuid references public.orders(id) on delete set null;

create index if not exists service_tickets_replacement_order_idx
  on public.service_tickets(replacement_order_id)
  where replacement_order_id is not null;

-- next_replacement_order_ref(): returns 'R-0001', 'R-0002', ... by reading
-- MAX(NULLIF(regexp_replace(order_ref, '^R-', ''), '')::int) + 1.
create or replace function public.next_replacement_order_ref()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n int;
begin
  select coalesce(max(nullif(regexp_replace(order_ref, '^R-', ''), '')::int), 0)
    into n
    from public.orders
    where order_ref ~ '^R-\d+$';
  return 'R-' || lpad((n + 1)::text, 4, '0');
end $$;

revoke all on function public.next_replacement_order_ref() from anon, public;
grant execute on function public.next_replacement_order_ref() to authenticated;
```

- [ ] **Step 2: Apply migration via MCP**

Use `mcp__claude_ai_Supabase__apply_migration` with project_id `txeftbbzeflequvrmjjr`, name `20260604210000_replacement_workflow`, and the SQL above.

Verify with `mcp__claude_ai_Supabase__execute_sql`:
```sql
select column_name, data_type, column_default
from information_schema.columns
where table_schema='public' and table_name='orders'
  and column_name in ('kind','linked_ticket_id','cogs_usd','shipping_cost_usd','shipped_at','delivered_at')
order by column_name;
```
Expected: 6 rows.

```sql
select public.next_replacement_order_ref();
```
Expected: `R-0001` (or `R-XXXX` if any pre-existing `R-` refs).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260604210000_replacement_workflow.sql
git commit -m "feat(db): replacement workflow schema (#55)"
```

---

## Task 2: lib/orders.ts — extend types

**Files:**
- Modify: `app/src/lib/orders.ts`

- [ ] **Step 1: Extend the LineItem and Order types**

Replace the `LineItem` definition at `app/src/lib/orders.ts:8-13` and the `Order` definition at `app/src/lib/orders.ts:24-62` with:

```ts
export type LineItem =
  | { sku: string; name: string; qty: number; price_usd: number }       // sale (legacy shape)
  | { kind: 'part'; part_id: string; sku: string; name: string; qty: number; cost_per_unit_usd: number }
  | { kind: 'unit'; unit_serial: string; batch: string; name: string; qty: 1; cost_usd: number };

export type OrderKind = 'sale' | 'replacement';

export type Order = {
  id: string;
  order_ref: string;
  kind: OrderKind;
  status: OrderStatus;
  linked_ticket_id: string | null;
  cogs_usd: number | null;
  shipping_cost_usd: number | null;
  shipped_at: string | null;
  delivered_at: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  quo_thread_url: string | null;
  address_line: string | null;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  address_verdict: 'house' | 'apt' | 'remote' | 'condo';
  address_verified_at: string | null;
  address_match: 'match' | 'mismatch' | 'unverifiable' | null;
  address_google_formatted: string | null;
  address_google_postal: string | null;
  address_customer_postal: string | null;
  address_claude_verdict: 'plausible' | 'implausible' | 'unknown' | null;
  address_claude_notes: string | null;
  address_claude_postal: string | null;
  freight_estimate_usd: number;
  freight_threshold_usd: number;
  currency: string;
  total_usd: number;
  subtotal_usd: number | null;
  tax_usd: number | null;
  discount_total_usd: number | null;
  discount_codes: string[] | null;
  payment_methods: string[] | null;
  financial_status: string | null;
  line_items: LineItem[];
  sales_confirmed_fit: boolean;
  dispositioned_by: string | null;
  dispositioned_at: string | null;
  created_at: string;
  placed_at: string | null;
};

/** Type guard for replacement-shaped line items. */
export function isReplacementLine(li: LineItem): li is Extract<LineItem, { kind: 'part' | 'unit' }> {
  return 'kind' in li && (li.kind === 'part' || li.kind === 'unit');
}
```

- [ ] **Step 2: Verify TS compiles**

Run: `cd app && npx tsc --noEmit`
Expected: no new errors. (Existing call sites using `li.sku / li.name / li.qty` still typecheck because all three line-item shapes carry those fields — except the unit shape which uses `unit_serial`, not `sku`. Verify call sites in `LineItemsCard.tsx` aren't accessing `sku` unconditionally; if they are, update them in Task 9.)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/orders.ts
git commit -m "feat(orders): extend Order type with kind + COGS + ship/deliver timestamps"
```

---

## Task 3: lib/orders.ts — `nextReplacementOrderRef` + `createReplacementOrder`

**Files:**
- Modify: `app/src/lib/orders.ts`
- Create: `app/src/lib/orders.test.ts` (if missing)

- [ ] **Step 1: Write the failing tests**

Create or append to `app/src/lib/orders.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextReplacementOrderRef, createReplacementOrder } from './orders';
import { supabase } from './supabase';

vi.mock('./supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn() }));

describe('nextReplacementOrderRef', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the value of the next_replacement_order_ref RPC', async () => {
    (supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: 'R-0042', error: null });
    const ref = await nextReplacementOrderRef();
    expect(ref).toBe('R-0042');
    expect(supabase.rpc).toHaveBeenCalledWith('next_replacement_order_ref');
  });

  it('throws when the RPC errors', async () => {
    (supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(nextReplacementOrderRef()).rejects.toThrow('rpc failed');
  });
});

describe('createReplacementOrder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts an order with kind=replacement and computes COGS', async () => {
    (supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: 'R-0007', error: null });
    const insertSingle = vi.fn().mockResolvedValue({ data: { id: 'o1', order_ref: 'R-0007' }, error: null });
    const select = vi.fn().mockReturnValue({ single: insertSingle });
    const insert = vi.fn().mockReturnValue({ select });
    const ticketUpdate = vi.fn().mockResolvedValue({ error: null });
    const partsUpdate = vi.fn().mockResolvedValue({ error: null });
    const unitsUpdate = vi.fn().mockResolvedValue({ error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'orders') return { insert };
      if (table === 'service_tickets') return { update: () => ({ eq: ticketUpdate }) };
      if (table === 'parts') return { update: () => ({ eq: partsUpdate }) };
      if (table === 'units') return { update: () => ({ eq: unitsUpdate }) };
      throw new Error(`unexpected table ${table}`);
    });

    const result = await createReplacementOrder({
      ticket_id: 't1',
      customer_name: 'Linda Smith',
      address: { address_line: '123 Maple', city: 'Toronto', region_state: 'ON',
                 country: 'CA', postal_code: 'M5J 2N8' },
      line_items: [
        { kind: 'part', part_id: 'p1', sku: 'HINGE-01', name: 'Lid Hinge', qty: 2, cost_per_unit_usd: 4.2 },
        { kind: 'unit', unit_serial: 'LL01-284', batch: 'B7', name: 'LILA Pro (B7 White)', qty: 1, cost_usd: 312 },
      ],
    });

    expect(result.order_ref).toBe('R-0007');
    const insertArg = insert.mock.calls[0][0];
    expect(insertArg.kind).toBe('replacement');
    expect(insertArg.status).toBe('pending');
    expect(insertArg.order_ref).toBe('R-0007');
    expect(insertArg.linked_ticket_id).toBe('t1');
    expect(insertArg.cogs_usd).toBeCloseTo(4.2 * 2 + 312, 2);
    expect(ticketUpdate).toHaveBeenCalled();
    expect(partsUpdate).toHaveBeenCalled();
    expect(unitsUpdate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run src/lib/orders.test.ts`
Expected: FAIL with `nextReplacementOrderRef is not a function` (or similar).

- [ ] **Step 3: Implement `nextReplacementOrderRef` and `createReplacementOrder`**

Append to `app/src/lib/orders.ts`:

```ts
/** Returns the next replacement order ref (R-0001, R-0002, ...). Server-side
 *  RPC to avoid client-side races on the counter. */
export async function nextReplacementOrderRef(): Promise<string> {
  const { data, error } = await supabase.rpc('next_replacement_order_ref');
  if (error) throw new Error(error.message);
  if (typeof data !== 'string' || !data.startsWith('R-')) {
    throw new Error(`Unexpected response from next_replacement_order_ref: ${JSON.stringify(data)}`);
  }
  return data;
}

export type ReplacementLineItem =
  | { kind: 'part'; part_id: string; sku: string; name: string; qty: number; cost_per_unit_usd: number }
  | { kind: 'unit'; unit_serial: string; batch: string; name: string; qty: 1; cost_usd: number };

export type ReplacementOrderInput = {
  ticket_id: string;
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  address: {
    address_line: string | null;
    city: string;
    region_state: string | null;
    country: 'US' | 'CA';
    postal_code: string | null;
  };
  line_items: ReplacementLineItem[];
};

function computeCogs(items: ReplacementLineItem[]): number {
  return items.reduce((sum, li) => {
    if (li.kind === 'part') return sum + li.cost_per_unit_usd * li.qty;
    return sum + li.cost_usd;
  }, 0);
}

/** Creates a replacement order (kind='replacement', status='pending'),
 *  back-links the ticket, decrements parts.on_hand, and reserves any units.
 *  Returns the new order_ref + id. */
export async function createReplacementOrder(input: ReplacementOrderInput):
  Promise<{ id: string; order_ref: string }> {
  if (input.line_items.length === 0) throw new Error('At least one line item required');
  const order_ref = await nextReplacementOrderRef();
  const cogs_usd = computeCogs(input.line_items);

  // 1. Insert the order. Address verdict defaults to 'house' so the address
  //    card still renders; operator can re-run verify if they need to.
  const { data: row, error: insErr } = await supabase
    .from('orders')
    .insert({
      order_ref,
      kind: 'replacement',
      status: 'pending',
      linked_ticket_id: input.ticket_id,
      cogs_usd,
      customer_name: input.customer_name,
      customer_email: input.customer_email ?? null,
      customer_phone: input.customer_phone ?? null,
      address_line: input.address.address_line,
      city: input.address.city,
      region_state: input.address.region_state,
      country: input.address.country,
      address_verdict: 'house',
      postal_code: input.address.postal_code,
      address_customer_postal: input.address.postal_code,
      freight_estimate_usd: 0,
      freight_threshold_usd: 0,
      currency: 'USD',
      total_usd: 0,
      sales_confirmed_fit: false,
      line_items: input.line_items,
    })
    .select('id, order_ref')
    .single();
  if (insErr || !row) throw new Error(`Create order: ${insErr?.message ?? 'no row'}`);

  // 2. Back-link the ticket.
  const { error: tErr } = await supabase
    .from('service_tickets')
    .update({ replacement_order_id: row.id })
    .eq('id', input.ticket_id);
  if (tErr) throw new Error(`Link ticket: ${tErr.message}`);

  // 3. Decrement parts.on_hand for each part line item.
  for (const li of input.line_items) {
    if (li.kind !== 'part') continue;
    const { data: cur, error: rErr } = await supabase
      .from('parts').select('on_hand').eq('id', li.part_id).single();
    if (rErr) throw new Error(`Read part ${li.part_id}: ${rErr.message}`);
    const next = Math.max(0, (cur?.on_hand ?? 0) - li.qty);
    const { error: pErr } = await supabase
      .from('parts').update({ on_hand: next }).eq('id', li.part_id);
    if (pErr) throw new Error(`Decrement part ${li.part_id}: ${pErr.message}`);
  }

  // 4. Reserve units.
  for (const li of input.line_items) {
    if (li.kind !== 'unit') continue;
    const { error: uErr } = await supabase
      .from('units')
      .update({ status: 'reserved', customer_order_ref: row.order_ref, customer_name: input.customer_name })
      .eq('serial', li.unit_serial);
    if (uErr) throw new Error(`Reserve unit ${li.unit_serial}: ${uErr.message}`);
  }

  await logAction(
    'replacement_create',
    row.order_ref,
    `from ticket ${input.ticket_id} · ${input.line_items.length} items · COGS $${cogs_usd.toFixed(2)}`,
  );
  return { id: row.id, order_ref: row.order_ref };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run src/lib/orders.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orders.ts app/src/lib/orders.test.ts
git commit -m "feat(orders): createReplacementOrder + nextReplacementOrderRef"
```

---

## Task 4: lib/orders.ts — `markOrderShipped` + `markOrderDelivered`

**Files:**
- Modify: `app/src/lib/orders.ts`
- Modify: `app/src/lib/orders.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `app/src/lib/orders.test.ts`:

```ts
import { markOrderShipped, markOrderDelivered } from './orders';

describe('markOrderShipped', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets shipped_at and shipping_cost_usd', async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ update });
    await markOrderShipped('o1', 42.75);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      shipping_cost_usd: 42.75,
      shipped_at: expect.any(String),
    }));
  });
});

describe('markOrderDelivered', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets delivered_at on a sale order without touching tickets', async () => {
    const select = vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({
      data: { kind: 'sale', linked_ticket_id: null }, error: null }) });
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const ticketUpdate = vi.fn();
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'orders') return { update, select: () => ({ eq: () => ({ single: select().single }) }) };
      if (table === 'service_tickets') return { update: ticketUpdate };
      throw new Error(`unexpected table ${table}`);
    });
    await markOrderDelivered('o1');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ delivered_at: expect.any(String) }));
    expect(ticketUpdate).not.toHaveBeenCalled();
  });

  it('closes the linked ticket on a replacement order', async () => {
    const single = vi.fn().mockResolvedValue({
      data: { kind: 'replacement', linked_ticket_id: 't1' }, error: null });
    const eqSel = vi.fn().mockReturnValue({ single });
    const orderUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const ticketUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'orders') return { update: orderUpdate, select: () => ({ eq: eqSel }) };
      if (table === 'service_tickets') return { update: ticketUpdate };
      throw new Error(`unexpected table ${table}`);
    });
    await markOrderDelivered('o1');
    expect(orderUpdate).toHaveBeenCalled();
    expect(ticketUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'closed', resolved_at: expect.any(String),
    }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run src/lib/orders.test.ts`
Expected: FAIL with `markOrderShipped is not a function`.

- [ ] **Step 3: Implement both functions**

Append to `app/src/lib/orders.ts`:

```ts
/** Records that an order shipped. Sets shipped_at and shipping_cost_usd
 *  (the actual freight/label cost from Freightcom/ClickShip). Works for
 *  both sales and replacements. */
export async function markOrderShipped(orderId: string, shippingCostUsd: number): Promise<void> {
  if (!Number.isFinite(shippingCostUsd) || shippingCostUsd < 0) {
    throw new Error('shipping_cost_usd must be a non-negative number');
  }
  const { error } = await supabase
    .from('orders')
    .update({ shipped_at: new Date().toISOString(), shipping_cost_usd: shippingCostUsd })
    .eq('id', orderId);
  if (error) throw new Error(error.message);
  await logAction('order_shipped', orderId, `shipping $${shippingCostUsd.toFixed(2)}`);
}

/** Records that an order was delivered. For replacement orders, also closes
 *  the linked service ticket. Idempotent — safe to call twice. */
export async function markOrderDelivered(orderId: string): Promise<void> {
  const { data: row, error: rErr } = await supabase
    .from('orders')
    .select('kind, linked_ticket_id, order_ref')
    .eq('id', orderId)
    .single();
  if (rErr || !row) throw new Error(`Read order: ${rErr?.message ?? 'not found'}`);

  const deliveredAt = new Date().toISOString();
  const { error: uErr } = await supabase
    .from('orders')
    .update({ delivered_at: deliveredAt })
    .eq('id', orderId);
  if (uErr) throw new Error(uErr.message);
  await logAction('order_delivered', row.order_ref, '');

  if (row.kind === 'replacement' && row.linked_ticket_id) {
    const { error: tErr } = await supabase
      .from('service_tickets')
      .update({ status: 'closed', resolved_at: deliveredAt, closed_at: deliveredAt })
      .eq('id', row.linked_ticket_id);
    if (tErr) throw new Error(`Close ticket: ${tErr.message}`);
    await logAction('ticket_auto_closed', row.linked_ticket_id, `via replacement ${row.order_ref}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run src/lib/orders.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orders.ts app/src/lib/orders.test.ts
git commit -m "feat(orders): markOrderShipped + markOrderDelivered with auto-close"
```

---

## Task 5: lib/service.ts — extend ServiceTicket type

**Files:**
- Modify: `app/src/lib/service.ts`

- [ ] **Step 1: Add field to type**

In `app/src/lib/service.ts`, find the `ServiceTicket` type (starts at line 47). Add `replacement_order_id: string | null;` to the type. Insert it after the `closed_at: string | null;` line (around line 73):

```ts
  closed_at: string | null;
  replacement_order_id: string | null;
  kind: TicketKind;
```

- [ ] **Step 2: Verify TS compiles**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/service.ts
git commit -m "feat(service): add replacement_order_id to ServiceTicket type"
```

---

## Task 6: ReplacementPickerModal

**Files:**
- Create: `app/src/modules/Service/ReplacementPickerModal.tsx`
- Create: `app/src/modules/Service/__tests__/ReplacementPickerModal.test.tsx`
- Modify: `app/src/modules/Service/Service.module.css`

- [ ] **Step 1: Write the failing tests**

Create `app/src/modules/Service/__tests__/ReplacementPickerModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReplacementPickerModal from '../ReplacementPickerModal';

vi.mock('../../../lib/parts', () => ({
  useParts: () => ({
    parts: [
      { id: 'p1', sku: 'HINGE', name: 'Lid Hinge', category: 'replacement',
        on_hand: 5, cost_per_unit_usd: 4.2 },
      { id: 'p2', sku: 'MOTOR', name: 'Chamber Motor', category: 'replacement',
        on_hand: 0, cost_per_unit_usd: 42.0 },  // out of stock — should be filtered out
    ],
    loading: false,
  }),
}));
vi.mock('../../../lib/stock', () => ({
  useUnits: () => ({
    units: [
      { serial: 'LL01-284', batch: 'B7', status: 'ready', color: 'White' },
      { serial: 'LL01-300', batch: 'B7', status: 'shipped', color: 'White' },  // not ready — filtered out
    ],
    loading: false,
  }),
}));
vi.mock('../../../lib/orders', () => ({
  createReplacementOrder: vi.fn().mockResolvedValue({ id: 'o1', order_ref: 'R-0001' }),
}));
import { createReplacementOrder } from '../../../lib/orders';

const TICKET = {
  id: 't1',
  customer_name: 'Linda Smith',
  customer_email: 'linda@example.com',
  customer_phone: null,
  ticket_number: 'T-138',
};

const ADDRESS = {
  address_line: '123 Maple Lane',
  city: 'Toronto',
  region_state: 'ON',
  country: 'CA' as const,
  postal_code: 'M5J 2N8',
};

describe('ReplacementPickerModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists only in-stock parts and ready units in the picker', () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByPlaceholderText(/search parts or units/i));
    expect(screen.getByText('Lid Hinge')).toBeInTheDocument();
    expect(screen.getByText('LL01-284')).toBeInTheDocument();
    expect(screen.queryByText('Chamber Motor')).not.toBeInTheDocument();
    expect(screen.queryByText('LL01-300')).not.toBeInTheDocument();
  });

  it('adds parts to cart and recomputes COGS on qty change', () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('Lid Hinge'));
    expect(screen.getByText(/COGS total/)).toHaveTextContent('$4.20');
    fireEvent.click(screen.getByLabelText('Increase Lid Hinge qty'));
    expect(screen.getByText(/COGS total/)).toHaveTextContent('$8.40');
  });

  it('cannot add the same unit twice', () => {
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('LL01-284'));
    fireEvent.click(screen.getByText('LL01-284'));
    const cartLines = screen.getAllByText('LL01-284');
    // One in cart row, none re-added
    expect(cartLines.length).toBe(1);
  });

  it('confirm calls createReplacementOrder with the cart contents', async () => {
    const onCreated = vi.fn();
    render(<ReplacementPickerModal ticket={TICKET} address={ADDRESS}
      onClose={() => {}} onCreated={onCreated} />);
    fireEvent.click(screen.getByText('Lid Hinge'));
    fireEvent.click(screen.getByText('LL01-284'));
    fireEvent.click(screen.getByRole('button', { name: /create replacement order/i }));
    await waitFor(() => expect(createReplacementOrder).toHaveBeenCalledTimes(1));
    const arg = (createReplacementOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.ticket_id).toBe('t1');
    expect(arg.line_items).toHaveLength(2);
    expect(arg.line_items.find((l: { kind: string }) => l.kind === 'part').sku).toBe('HINGE');
    expect(arg.line_items.find((l: { kind: string }) => l.kind === 'unit').unit_serial).toBe('LL01-284');
    expect(onCreated).toHaveBeenCalledWith({ id: 'o1', order_ref: 'R-0001' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run src/modules/Service/__tests__/ReplacementPickerModal.test.tsx`
Expected: FAIL (component does not exist).

- [ ] **Step 3: Create the modal**

Create `app/src/modules/Service/ReplacementPickerModal.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useParts } from '../../lib/parts';
import { useUnits } from '../../lib/stock';
import { createReplacementOrder, type ReplacementLineItem } from '../../lib/orders';
import styles from './Service.module.css';

type CartLine = ReplacementLineItem;

type Props = {
  ticket: {
    id: string;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    ticket_number: string;
  };
  address: {
    address_line: string | null;
    city: string;
    region_state: string | null;
    country: 'US' | 'CA';
    postal_code: string | null;
  };
  onClose: () => void;
  onCreated: (result: { id: string; order_ref: string }) => void;
};

export default function ReplacementPickerModal({ ticket, address, onClose, onCreated }: Props) {
  const { parts } = useParts();
  const { units } = useUnits();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [addr, setAddr] = useState(address);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableParts = useMemo(
    () => parts.filter(p => p.category === 'replacement' && p.on_hand > 0
      && (search === '' || p.name.toLowerCase().includes(search.toLowerCase()))),
    [parts, search],
  );
  const availableUnits = useMemo(
    () => units.filter(u => u.status === 'ready'
      && (search === '' || u.serial.toLowerCase().includes(search.toLowerCase()))),
    [units, search],
  );

  const cogs = cart.reduce((sum, li) =>
    li.kind === 'part' ? sum + li.cost_per_unit_usd * li.qty : sum + li.cost_usd, 0);

  function addPart(p: typeof parts[number]) {
    setCart(prev => {
      const existing = prev.findIndex(l => l.kind === 'part' && l.part_id === p.id);
      if (existing >= 0) {
        const next = [...prev];
        const cur = next[existing] as Extract<CartLine, { kind: 'part' }>;
        next[existing] = { ...cur, qty: Math.min(p.on_hand, cur.qty + 1) };
        return next;
      }
      return [...prev, {
        kind: 'part', part_id: p.id, sku: p.sku, name: p.name,
        qty: 1, cost_per_unit_usd: p.cost_per_unit_usd ?? 0,
      }];
    });
  }

  function addUnit(u: typeof units[number]) {
    setCart(prev => {
      if (prev.some(l => l.kind === 'unit' && l.unit_serial === u.serial)) return prev;
      return [...prev, {
        kind: 'unit', unit_serial: u.serial, batch: u.batch,
        name: `LILA (${u.batch}, ${u.color ?? '?'})`, qty: 1, cost_usd: 312,  // TODO source from batch.unit_cost_usd
      }];
    });
  }

  function setQty(idx: number, qty: number) {
    setCart(prev => {
      const next = [...prev];
      const li = next[idx];
      if (li.kind !== 'part') return prev;
      const cap = parts.find(p => p.id === li.part_id)?.on_hand ?? li.qty;
      next[idx] = { ...li, qty: Math.max(1, Math.min(cap, qty)) };
      return next;
    });
  }

  function removeLine(idx: number) {
    setCart(prev => prev.filter((_, i) => i !== idx));
  }

  async function confirm() {
    if (cart.length === 0) { setError('Pick at least one item.'); return; }
    setBusy(true); setError(null);
    try {
      const result = await createReplacementOrder({
        ticket_id: ticket.id,
        customer_name: ticket.customer_name ?? 'Unknown',
        customer_email: ticket.customer_email,
        customer_phone: ticket.customer_phone,
        address: addr,
        line_items: cart,
      });
      onCreated(result);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <h3>Send replacement — {ticket.customer_name} (ticket {ticket.ticket_number})</h3>
          <button className={styles.modalClose} onClick={onClose} aria-label="Close">×</button>
        </header>

        <section className={styles.addressBlock}>
          <label>Ship to:</label>
          <input value={addr.address_line ?? ''}
            onChange={e => setAddr({ ...addr, address_line: e.target.value })}
            placeholder="Address" />
          <div className={styles.addressRow}>
            <input value={addr.city} onChange={e => setAddr({ ...addr, city: e.target.value })} placeholder="City" />
            <input value={addr.region_state ?? ''} onChange={e => setAddr({ ...addr, region_state: e.target.value })} placeholder="State/Prov" />
            <input value={addr.postal_code ?? ''} onChange={e => setAddr({ ...addr, postal_code: e.target.value })} placeholder="Postal" />
            <select value={addr.country} onChange={e => setAddr({ ...addr, country: e.target.value as 'US' | 'CA' })}>
              <option value="CA">CA</option><option value="US">US</option>
            </select>
          </div>
        </section>

        <input className={styles.modalSearch} placeholder="Search parts or units…"
          value={search} onChange={e => setSearch(e.target.value)} />

        <div className={styles.pickerList}>
          {availableParts.length > 0 && <h4>Parts</h4>}
          {availableParts.map(p => (
            <button key={p.id} className={styles.pickerRow} onClick={() => addPart(p)}>
              <span>{p.name}</span>
              <span className={styles.pickerMeta}>{p.on_hand} on hand · ${(p.cost_per_unit_usd ?? 0).toFixed(2)}</span>
            </button>
          ))}
          {availableUnits.length > 0 && <h4>Replacement Unit</h4>}
          {availableUnits.map(u => (
            <button key={u.serial} className={styles.pickerRow} onClick={() => addUnit(u)}>
              <span>{u.serial}</span>
              <span className={styles.pickerMeta}>{u.batch} · {u.color ?? '—'} · ready</span>
            </button>
          ))}
        </div>

        <ul className={styles.cartList}>
          {cart.map((li, i) => (
            <li key={li.kind === 'part' ? `p-${li.part_id}` : `u-${li.unit_serial}`}>
              {li.kind === 'part' ? (
                <>
                  <span>{li.qty}× {li.name}</span>
                  <span>${(li.cost_per_unit_usd * li.qty).toFixed(2)}</span>
                  <button aria-label={`Decrease ${li.name} qty`} onClick={() => setQty(i, li.qty - 1)}>−</button>
                  <button aria-label={`Increase ${li.name} qty`} onClick={() => setQty(i, li.qty + 1)}>+</button>
                </>
              ) : (
                <>
                  <span>{li.unit_serial}</span>
                  <span>${li.cost_usd.toFixed(2)}</span>
                </>
              )}
              <button aria-label="Remove line" onClick={() => removeLine(i)}>✕</button>
            </li>
          ))}
        </ul>

        <div className={styles.cogs}>COGS total: ${cogs.toFixed(2)}</div>
        {error && <p className={styles.error}>{error}</p>}

        <footer className={styles.modalFooter}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={confirm} disabled={busy || cart.length === 0}>
            {busy ? 'Creating…' : 'Create replacement order'}
          </button>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add CSS**

Append to `app/src/modules/Service/Service.module.css`:

```css
.modalBackdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modalCard {
  background: #fff; border-radius: 8px; width: 560px; max-width: 92vw;
  max-height: 85vh; display: flex; flex-direction: column;
  padding: 20px 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.2);
}
.modalHeader { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.modalHeader h3 { margin: 0; font-size: 1rem; }
.modalClose { background: transparent; border: none; font-size: 1.4rem; cursor: pointer; color: #666; }
.addressBlock label { font-size: .8rem; color: #555; display: block; margin-bottom: 4px; }
.addressBlock input { width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; margin-bottom: 4px; }
.addressRow { display: grid; grid-template-columns: 2fr 1fr 1fr 60px; gap: 4px; }
.addressRow input, .addressRow select { padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; }
.modalSearch { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; margin: 10px 0; box-sizing: border-box; }
.pickerList { overflow-y: auto; max-height: 220px; border: 1px solid #eee; border-radius: 6px; margin-bottom: 10px; }
.pickerList h4 { margin: 8px 12px 4px; font-size: .8rem; color: #555; text-transform: uppercase; }
.pickerRow { display: flex; justify-content: space-between; width: 100%; padding: 8px 12px; background: transparent; border: none; border-bottom: 1px solid #f1f1f1; cursor: pointer; text-align: left; }
.pickerRow:hover { background: #f7fafc; }
.pickerMeta { font-size: .8rem; color: #777; }
.cartList { list-style: none; padding: 0; margin: 0 0 8px; }
.cartList li { display: grid; grid-template-columns: 1fr auto auto auto auto; align-items: center; gap: 8px; padding: 4px 0; }
.cogs { font-weight: 600; margin: 8px 0; text-align: right; }
.modalFooter { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; }
.modalFooter button { padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.modalFooter button:last-child { background: #2b6cb0; color: #fff; border: 1px solid #2b6cb0; }
.modalFooter button:last-child:disabled { opacity: .6; cursor: not-allowed; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && npx vitest run src/modules/Service/__tests__/ReplacementPickerModal.test.tsx`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/modules/Service/ReplacementPickerModal.tsx \
        app/src/modules/Service/__tests__/ReplacementPickerModal.test.tsx \
        app/src/modules/Service/Service.module.css
git commit -m "feat(service): add ReplacementPickerModal"
```

---

## Task 7: TicketDetailPanel — Send replacement button

**Files:**
- Modify: `app/src/modules/Service/TicketDetailPanel.tsx`

- [ ] **Step 1: Wire the button + modal trigger**

Add to the imports at the top of `app/src/modules/Service/TicketDetailPanel.tsx`:

```ts
import ReplacementPickerModal from './ReplacementPickerModal';
import { useCustomers } from '../../lib/customers';
```

In the `TicketDetailPanel` component body, after the existing `useState` declarations (~line 36), add:

```tsx
const [pickerOpen, setPickerOpen] = useState(false);
const { customers } = useCustomers();
const linkedCustomer = useMemo(() =>
  ticket.customer_id ? customers.find(c => c.id === ticket.customer_id) : null,
  [customers, ticket.customer_id]);
const pickerAddress = useMemo(() => ({
  address_line: linkedCustomer?.address_line ?? null,
  city: linkedCustomer?.city ?? '',
  region_state: linkedCustomer?.region ?? null,
  country: (linkedCustomer?.country === 'US' ? 'US' : 'CA') as 'US' | 'CA',
  postal_code: linkedCustomer?.postal_code ?? null,
}), [linkedCustomer]);
```

Make sure `useMemo` is imported at the top: change `import { useState }` to `import { useState, useMemo }`.

In the JSX, find a sensible location near the top of the detail panel body (e.g. just after the ticket status/category block) and add:

```tsx
{ticket.replacement_order_id ? (
  <div className={styles.replacementLink}>
    Replacement order:&nbsp;
    <a href={`#/order-review?order_id=${ticket.replacement_order_id}`}>
      open in Order Review
    </a>
  </div>
) : (
  <button
    type="button"
    className={styles.replacementBtn}
    disabled={busy}
    onClick={() => setPickerOpen(true)}
  >
    Send replacement
  </button>
)}

{pickerOpen && (
  <ReplacementPickerModal
    ticket={{
      id: ticket.id,
      customer_name: ticket.customer_name,
      customer_email: ticket.customer_email,
      customer_phone: ticket.customer_phone,
      ticket_number: ticket.ticket_number,
    }}
    address={pickerAddress}
    onClose={() => setPickerOpen(false)}
    onCreated={(result) => {
      setPickerOpen(false);
      // Optimistic: redirect to OrderReview detail in next tick
      window.location.hash = `#/order-review?order_id=${result.id}`;
    }}
  />
)}
```

Append to `app/src/modules/Service/Service.module.css`:

```css
.replacementBtn {
  padding: 6px 14px; border-radius: 6px; background: #2b6cb0;
  color: #fff; border: 1px solid #2b6cb0; cursor: pointer; font-size: .85rem;
}
.replacementBtn:hover:not(:disabled) { background: #2c5282; }
.replacementBtn:disabled { opacity: .6; cursor: not-allowed; }
.replacementLink {
  padding: 8px 12px; background: #ebf8ff; border-radius: 6px;
  font-size: .85rem; color: #2b6cb0;
}
.replacementLink a { color: #2b6cb0; text-decoration: underline; }
```

- [ ] **Step 2: Verify TS compiles**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Sanity-check the existing TicketDetailPanel test still passes**

Run: `cd app && npx vitest run src/modules/Service/__tests__`
Expected: existing tests PASS (no test for the new button yet — we'll cover that in the e2e).

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Service/TicketDetailPanel.tsx app/src/modules/Service/Service.module.css
git commit -m "feat(service): Send replacement button on TicketDetailPanel"
```

---

## Task 8: ReplacementTab — new component

**Files:**
- Create: `app/src/modules/Service/ReplacementTab.tsx`
- Create: `app/src/modules/Service/__tests__/ReplacementTab.test.tsx`
- Modify: `app/src/lib/orders.ts` (add `useReplacementOrders` hook)

- [ ] **Step 1: Add the hook**

Append to `app/src/lib/orders.ts`:

```ts
/** Live-subscribed list of all replacement orders, newest first. */
export function useReplacementOrders(): { orders: Order[]; loading: boolean } {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('kind', 'replacement')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setOrders(data as Order[]);
      setLoading(false);

      channel = supabase
        .channel('orders:replacement:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
          setOrders(prev => {
            const row = (payload.new ?? payload.old) as Order | undefined;
            if (!row || row.kind !== 'replacement') return prev;
            if (payload.eventType === 'DELETE') return prev.filter(o => o.id !== row.id);
            const idx = prev.findIndex(o => o.id === row.id);
            if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
            return [row, ...prev];
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { orders, loading };
}
```

Make sure `useEffect` is imported in `orders.ts` (it should be already, near the top).

- [ ] **Step 2: Write failing tests**

Create `app/src/modules/Service/__tests__/ReplacementTab.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReplacementTab from '../ReplacementTab';

vi.mock('../../../lib/orders', () => ({
  useReplacementOrders: () => ({
    orders: [
      { id: 'o1', order_ref: 'R-0001', kind: 'replacement', status: 'pending',
        customer_name: 'Linda', cogs_usd: 12.5, shipped_at: null, delivered_at: null,
        created_at: new Date(Date.now() - 86400_000).toISOString(),
        linked_ticket_id: 't1',
        line_items: [{ kind: 'part', part_id: 'p1', sku: 'X', name: 'Hinge', qty: 2, cost_per_unit_usd: 4.2 }] },
      { id: 'o2', order_ref: 'R-0002', kind: 'replacement', status: 'approved',
        customer_name: 'Sam', cogs_usd: 312, shipped_at: null, delivered_at: null,
        created_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
        linked_ticket_id: 't2',
        line_items: [{ kind: 'unit', unit_serial: 'LL01-284', batch: 'B7', name: 'LILA', qty: 1, cost_usd: 312 }] },
    ],
    loading: false,
  }),
}));

describe('ReplacementTab', () => {
  it('lists replacement orders with order_ref, customer, COGS, stage', () => {
    render(<ReplacementTab />);
    expect(screen.getByText('R-0001')).toBeInTheDocument();
    expect(screen.getByText('R-0002')).toBeInTheDocument();
    expect(screen.getByText('Linda')).toBeInTheDocument();
    expect(screen.getByText(/\$12\.50/)).toBeInTheDocument();
  });

  it('shows KPI strip totals', () => {
    render(<ReplacementTab />);
    expect(screen.getByText(/Open: 2/i)).toBeInTheDocument();
  });
});
```

Run: `cd app && npx vitest run src/modules/Service/__tests__/ReplacementTab.test.tsx`
Expected: FAIL (component does not exist).

- [ ] **Step 3: Create ReplacementTab**

Create `app/src/modules/Service/ReplacementTab.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useReplacementOrders, type Order } from '../../lib/orders';
import { isReplacementLine } from '../../lib/orders';
import styles from './Service.module.css';

type Stage = 'pending' | 'approved' | 'fulfilling' | 'shipped' | 'delivered' | 'closed';

function stageFor(o: Order): Stage {
  if (o.delivered_at) return 'delivered';
  if (o.shipped_at) return 'shipped';
  if (o.status === 'approved') return 'fulfilling';
  return o.status as Stage;
}

function summarize(line_items: Order['line_items']): string {
  let parts = 0, units = 0;
  for (const li of line_items) {
    if (!isReplacementLine(li)) continue;
    if (li.kind === 'part') parts += li.qty;
    if (li.kind === 'unit') units += 1;
  }
  const parts_s = parts === 0 ? '' : `${parts} part${parts !== 1 ? 's' : ''}`;
  const units_s = units === 0 ? '' : `${units} unit${units !== 1 ? 's' : ''}`;
  return [parts_s, units_s].filter(Boolean).join(' + ') || '—';
}

const STAGES: { key: Stage | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'fulfilling', label: 'Fulfilling' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'closed', label: 'Closed' },
];

export default function ReplacementTab() {
  const { orders, loading } = useReplacementOrders();
  const [filter, setFilter] = useState<Stage | 'all'>('all');

  const filtered = useMemo(
    () => orders.filter(o => filter === 'all' || stageFor(o) === filter),
    [orders, filter],
  );

  const monthAgo = Date.now() - 30 * 86400_000;
  const open = orders.filter(o => !o.delivered_at).length;
  const shipped30 = orders.filter(o => o.shipped_at && new Date(o.shipped_at).getTime() > monthAgo).length;
  const delivered30 = orders.filter(o => o.delivered_at && new Date(o.delivered_at).getTime() > monthAgo).length;
  const cogs30: number[] = orders
    .filter(o => o.delivered_at && new Date(o.delivered_at).getTime() > monthAgo)
    .map(o => o.cogs_usd ?? 0);
  const avgCogs = cogs30.length === 0 ? null : cogs30.reduce((a, b) => a + b, 0) / cogs30.length;

  if (loading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Open</div><div className={styles.kpiValue}>Open: {open}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Shipped (30d)</div><div className={styles.kpiValue}>{shipped30}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Delivered (30d)</div><div className={styles.kpiValue}>{delivered30}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Avg COGS (30d)</div><div className={styles.kpiValue}>{avgCogs == null ? '—' : `$${avgCogs.toFixed(2)}`}</div></div>
      </div>

      <div className={styles.filterRow}>
        {STAGES.map(s => (
          <button key={s.key}
            className={`${styles.chip} ${filter === s.key ? styles.chipActive : ''}`}
            onClick={() => setFilter(s.key)}>{s.label}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No replacement orders.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Order #</th><th>Ticket</th><th>Customer</th><th>Items</th>
              <th>COGS</th><th>Stage</th><th>Days open</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(o => {
              const daysOpen = Math.floor((Date.now() - new Date(o.created_at).getTime()) / 86400_000);
              return (
                <tr key={o.id} className={styles.row}>
                  <td><a href={`#/order-review?order_id=${o.id}`}>{o.order_ref}</a></td>
                  <td>{o.linked_ticket_id ? <a href={`#/service?ticket_id=${o.linked_ticket_id}`}>open</a> : '—'}</td>
                  <td>{o.customer_name}</td>
                  <td>{summarize(o.line_items)}</td>
                  <td>${(o.cogs_usd ?? 0).toFixed(2)}</td>
                  <td>{stageFor(o)}</td>
                  <td>{daysOpen}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run src/modules/Service/__tests__/ReplacementTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orders.ts app/src/modules/Service/ReplacementTab.tsx app/src/modules/Service/__tests__/ReplacementTab.test.tsx
git commit -m "feat(service): ReplacementTab listing kind=replacement orders"
```

---

## Task 9: Service/index.tsx — rename + swap import + delete RepairTab

**Files:**
- Modify: `app/src/modules/Service/index.tsx`
- Delete: `app/src/modules/Service/RepairTab.tsx`

- [ ] **Step 1: Update Service/index.tsx**

Replace lines 1-15 of `app/src/modules/Service/index.tsx`:

```tsx
import { useState } from 'react';
import { InboxTab } from './InboxTab';
import { OnboardingTab } from './OnboardingTab';
import { SupportTab } from './SupportTab';
import ReplacementTab from './ReplacementTab';
import styles from './Service.module.css';

type Tab = 'inbox' | 'onboarding' | 'support' | 'replacement';

const TABS: { key: Tab; label: string }[] = [
  { key: 'inbox',       label: 'Inbox' },
  { key: 'onboarding',  label: 'Onboarding' },
  { key: 'support',     label: 'Support Tickets' },
  { key: 'replacement', label: 'Replacement' },
];
```

In the JSX, change `{tab === 'repair' && <RepairTab />}` to `{tab === 'replacement' && <ReplacementTab />}`.

- [ ] **Step 2: Delete the old file**

```bash
git rm app/src/modules/Service/RepairTab.tsx
```

- [ ] **Step 3: Verify TS compiles and tests pass**

Run: `cd app && npx tsc --noEmit && npx vitest run`
Expected: no TS errors; all tests pass. If any test imports `RepairTab` directly, update it.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Service/index.tsx
git commit -m "feat(service): swap Repair tab for Replacement tab"
```

---

## Task 10: Order Review — Replacement badge + originating ticket + line items + payment hide

**Files:**
- Modify: `app/src/modules/OrderReview/Detail.tsx`
- Modify: `app/src/modules/OrderReview/OrderRow.tsx`
- Modify: `app/src/modules/OrderReview/detail/LineItemsCard.tsx`
- Modify: `app/src/modules/OrderReview/OrderReview.module.css`

- [ ] **Step 1: Add the badge to OrderRow**

In `app/src/modules/OrderReview/OrderRow.tsx`, find where the row renders `order.order_ref` (it'll be near the top of the JSX) and add the badge next to it:

```tsx
{order.kind === 'replacement' && (
  <span className={styles.replBadge}>Replacement</span>
)}
```

- [ ] **Step 2: Add the badge + originating ticket to Detail.tsx**

In `app/src/modules/OrderReview/Detail.tsx`, just below the `<ConfirmBanner>` line in the return JSX, add:

```tsx
{order.kind === 'replacement' && (
  <div className={styles.replHeaderBanner}>
    <strong>Replacement order</strong>
    {order.linked_ticket_id && (
      <>
        &nbsp;·&nbsp;
        <a href={`#/service?ticket_id=${order.linked_ticket_id}`}>
          originating ticket
        </a>
      </>
    )}
    {order.cogs_usd != null && <>&nbsp;·&nbsp;COGS ${order.cogs_usd.toFixed(2)}</>}
  </div>
)}
```

- [ ] **Step 3: Handle replacement line items in LineItemsCard**

In `app/src/modules/OrderReview/detail/LineItemsCard.tsx`, the existing renderer assumes a flat `{ sku, name, qty, price_usd }` shape. Refactor to render the discriminated union:

```tsx
{order.line_items.map((li, i) => {
  if ('kind' in li && li.kind === 'part') {
    return (
      <li key={`p-${i}`}>
        <span>{li.qty}× {li.name}</span>
        <span className={styles.sku}>{li.sku}</span>
        <span>${(li.cost_per_unit_usd * li.qty).toFixed(2)}</span>
      </li>
    );
  }
  if ('kind' in li && li.kind === 'unit') {
    return (
      <li key={`u-${i}`}>
        <span>{li.name}</span>
        <span className={styles.sku}>{li.unit_serial}</span>
        <span>${li.cost_usd.toFixed(2)}</span>
      </li>
    );
  }
  // Sale line item (legacy shape)
  return (
    <li key={`s-${i}`}>
      <span>{li.qty}× {li.name}</span>
      <span className={styles.sku}>{li.sku}</span>
      <span>${((li as { price_usd: number }).price_usd * li.qty).toFixed(2)}</span>
    </li>
  );
})}
```

(Adapt the exact JSX to match what `LineItemsCard.tsx` currently renders. The point: branch on `'kind' in li` to handle the new shapes.)

For replacement orders, hide the freight/payment cards in the Detail layout. Find where `FreightCard` and any payment-related card are rendered and wrap them:

```tsx
{order.kind === 'sale' && <FreightCard order={order} />}
{order.kind === 'sale' && /* ... any payment card ... */}
```

- [ ] **Step 4: Add CSS**

Append to `app/src/modules/OrderReview/OrderReview.module.css`:

```css
.replBadge {
  display: inline-block; margin-left: 6px;
  padding: 1px 8px; border-radius: 999px;
  background: #fef3c7; color: #b7791f;
  font-size: .7rem; font-weight: 500;
}
.replHeaderBanner {
  background: #fffbeb; border-left: 4px solid #f6ad55;
  padding: 8px 12px; border-radius: 6px;
  font-size: .85rem; margin-bottom: 12px;
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd app && npx tsc --noEmit && npx vitest run src/modules/OrderReview`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/modules/OrderReview/
git commit -m "feat(order-review): replacement badge + originating ticket + line items"
```

---

## Task 11: Fulfillment — shipping cost prompt + badge

**Files:**
- Modify: `app/src/modules/Fulfillment/queue/StepFulfilled.tsx`
- Modify: `app/src/modules/Fulfillment/queue/QueueSidebar.tsx`
- Modify: `app/src/modules/Fulfillment/Fulfillment.module.css` (or wherever)

- [ ] **Step 1: Add the badge to QueueSidebar**

In `app/src/modules/Fulfillment/queue/QueueSidebar.tsx`, find where each queue row renders the order ref and add (mirroring Task 10):

```tsx
{row.kind === 'replacement' && <span className={styles.replBadge}>Replacement</span>}
```

(Adapt — the queue may join on `orders.kind`; if not, add a small select for it.)

- [ ] **Step 2: Add shipping-cost prompt to StepFulfilled**

In `app/src/modules/Fulfillment/queue/StepFulfilled.tsx`, before the existing "Mark fulfilled" action, add a controlled input + call `markOrderShipped`:

```tsx
import { useState } from 'react';
import { markOrderShipped } from '../../../lib/orders';

// inside the component:
const [shippingCost, setShippingCost] = useState<string>('');
const [shipBusy, setShipBusy] = useState(false);
const [shipError, setShipError] = useState<string | null>(null);

async function ship() {
  const n = Number(shippingCost);
  if (!Number.isFinite(n) || n < 0) { setShipError('Enter a valid shipping cost.'); return; }
  setShipBusy(true); setShipError(null);
  try {
    await markOrderShipped(orderId, n);
    onMarkedShipped();    // whatever the existing "next-step" prop is called
  } catch (e) {
    setShipError((e as Error).message);
  } finally {
    setShipBusy(false);
  }
}

// JSX (add above the existing fulfill button):
<label>
  Actual shipping cost (USD):&nbsp;
  <input type="number" step="0.01" min="0"
    value={shippingCost} onChange={e => setShippingCost(e.target.value)}
    placeholder="42.75" />
</label>
<button onClick={ship} disabled={shipBusy || shippingCost === ''}>
  {shipBusy ? 'Saving…' : 'Mark shipped'}
</button>
{shipError && <p className={styles.error}>{shipError}</p>}
```

(Wire `orderId` and `onMarkedShipped` from existing props.)

- [ ] **Step 3: Verify build + tests**

Run: `cd app && npx tsc --noEmit && npx vitest run src/modules/Fulfillment`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Fulfillment/
git commit -m "feat(fulfillment): shipping_cost_usd prompt + replacement badge"
```

---

## Task 12: Post-Shipment — Mark delivered + badge

**Files:**
- Modify: `app/src/modules/PostShipment/HistoryTab.tsx` (or the order-detail surface where tracking lives)
- Modify: `app/src/modules/PostShipment/PostShipment.module.css`

- [ ] **Step 1: Add Mark-delivered button**

In `app/src/modules/PostShipment/HistoryTab.tsx`, for each order row that has `shipped_at` but no `delivered_at`, add a "Mark delivered" button:

```tsx
import { markOrderDelivered } from '../../lib/orders';

// inside the row renderer:
{order.shipped_at && !order.delivered_at && (
  <button
    className={styles.markDeliveredBtn}
    onClick={async () => {
      try { await markOrderDelivered(order.id); }
      catch (e) { alert((e as Error).message); }
    }}
  >Mark delivered</button>
)}
```

Also add the replacement badge wherever the row renders the order_ref (mirroring Task 10).

- [ ] **Step 2: CSS**

```css
.markDeliveredBtn {
  padding: 4px 10px; border-radius: 4px;
  background: #c6f6d5; color: #22543d;
  border: 1px solid #9ae6b4; cursor: pointer; font-size: .8rem;
}
.markDeliveredBtn:hover { background: #9ae6b4; }
```

- [ ] **Step 3: Verify tests**

Run: `cd app && npx vitest run src/modules/PostShipment`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/PostShipment/
git commit -m "feat(post-shipment): Mark delivered button + replacement badge"
```

---

## Task 13: Playwright end-to-end

**Files:**
- Create: `app/tests/e2e/replacement-workflow.spec.ts`

- [ ] **Step 1: Write the e2e**

Create `app/tests/e2e/replacement-workflow.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('replacement workflow: ticket → modal → order → fulfillment → delivered → ticket closed', async ({ page }) => {
  // PRECONDITIONS: seed DB with one open service ticket linked to a customer
  // with at least one ready unit + one in-stock part. Use a Supabase fixture
  // script before this test (app/tests/e2e/fixtures/replacement-seed.ts) that
  // inserts a unique-named ticket + customer + part + unit.

  // 1. Log in (existing auth helper)
  await page.goto('/');
  // (insert existing login helper here)

  // 2. Open Service → Inbox → click the seeded ticket
  await page.click('text=Service');
  await page.click('text=Inbox');
  await page.click('text=E2E-TICKET-REPL');
  await page.click('button:has-text("Send replacement")');

  // 3. Modal: pick a part + a unit, confirm
  await page.fill('input[placeholder="Search parts or units…"]', 'E2E-PART');
  await page.click('text=E2E-PART');
  await page.fill('input[placeholder="Search parts or units…"]', 'E2E-LL');
  await page.click('text=E2E-LL01-E2E');
  await page.click('button:has-text("Create replacement order")');

  // 4. Order Review → assert replacement order with badge
  await expect(page.locator('text=Replacement order')).toBeVisible();
  const orderRef = await page.locator('text=/R-\\d{4}/').first().textContent();
  expect(orderRef).toMatch(/R-\d{4}/);
  await page.click('button:has-text("Approve")');

  // 5. Fulfillment → enter shipping cost + mark shipped
  await page.click('text=Fulfillment');
  await page.click(`text=${orderRef}`);
  await page.fill('input[type="number"]', '42.75');
  await page.click('button:has-text("Mark shipped")');

  // 6. Post-Shipment → mark delivered
  await page.click('text=Post-Shipment');
  await page.click('text=History');
  await page.click(`tr:has-text("${orderRef}") >> button:has-text("Mark delivered")`);

  // 7. Service → ticket should be closed
  await page.click('text=Service');
  await page.click('text=Inbox');
  await page.click('button:has-text("Closed")');                       // filter chip
  await expect(page.locator('text=E2E-TICKET-REPL')).toBeVisible();
});
```

A fixture seeder script `app/tests/e2e/fixtures/replacement-seed.ts` is required — same shape as any existing e2e fixture in this repo. If no convention exists, document the manual setup at the top of the spec file and skip-mark the test (`test.skip(`)) until the fixture is wired.

- [ ] **Step 2: Run the e2e**

Run: `cd app && npx playwright test tests/e2e/replacement-workflow.spec.ts`
Expected: PASS (or skip if the fixture isn't set up — leave a clear TODO in the test).

- [ ] **Step 3: Commit**

```bash
git add app/tests/e2e/replacement-workflow.spec.ts
git commit -m "test(e2e): replacement workflow end-to-end"
```

---

## Task 14: Final integration check + dev smoke

**Files:** none (verification only).

- [ ] **Step 1: Build + full test suite**

Run: `cd app && npm run build && npx vitest run`
Expected: build succeeds; all unit tests pass.

- [ ] **Step 2: Dev server smoke**

Run: `cd app && npm run dev`
Open the app, click through:
- Service → Replacement tab loads (empty)
- Open a real open service ticket → "Send replacement" appears → modal opens → picker lists parts + units
- Cancel the modal, confirm no DB writes

(No code change here; this is the manual UI smoke step per CLAUDE.md "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete.")

- [ ] **Step 3: Final commit (if any cleanup)**

If anything needed adjustment during the smoke:

```bash
git add -A
git commit -m "chore: replacement workflow polish"
```

---

## Self-review checklist (writer's pass)

**Spec coverage:**
- ✅ Schema (`kind`, `linked_ticket_id`, `cogs_usd`, `shipping_cost_usd`, `shipped_at`, `delivered_at`, `service_tickets.replacement_order_id`, `next_replacement_order_ref()`) → Task 1
- ✅ `createReplacementOrder` with COGS + parts/units bookkeeping → Task 3
- ✅ `markOrderShipped` + `markOrderDelivered` + ticket auto-close → Task 4
- ✅ ReplacementPickerModal with cart, address, ranked picker → Task 6
- ✅ TicketDetailPanel "Send replacement" button + replacement_order_id backlink display → Task 7
- ✅ ReplacementTab listing `kind='replacement'` orders → Task 8
- ✅ Service/index.tsx rename → Task 9
- ✅ OrderReview badge + originating-ticket link + payment hide → Task 10
- ✅ Fulfillment badge + shipping_cost prompt → Task 11
- ✅ PostShipment Mark-delivered + badge → Task 12
- ✅ Playwright e2e → Task 13
- ✅ Activity log events (`replacement_create`, `order_shipped`, `order_delivered`, `ticket_auto_closed`) — embedded in Tasks 3, 4

**Gaps / explicit deferrals:**
- `replacement_queue` table coexistence — noted in plan header; not retired in this work.
- Unit batch cost lookup: the picker hard-codes `cost_usd: 312` per unit in Task 6 — flagged with a TODO comment to source from `batches.unit_cost_usd` once the customer-batch join is wired (small follow-up).
- Cancellation: re-incrementing `parts.on_hand` on order cancellation is NOT in this plan — defer until we add a cancel-replacement-order action. Document in commit log.

**Type consistency check:** `nextReplacementOrderRef`, `createReplacementOrder`, `markOrderShipped`, `markOrderDelivered`, `useReplacementOrders`, `isReplacementLine`, `ReplacementLineItem`, `ReplacementOrderInput` — all referenced names match across tasks. ✓
