# Make Lila — Order Review Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Order Review design spec into a working module: `orders` table seeded with 8 mock rows, a sidebar + detail UI where reviewers disposition orders (approve / flag / hold / need info), each action writing an `activity_log` row and cross-reviewer-visible via realtime.

**Architecture:** Direct extension of the shared-infra stack. New Supabase table with RLS and realtime publication. New React module at `app/src/modules/OrderReview/` composed of small focused files (one card per concern). DB access lives in `app/src/lib/orders.ts`; components receive data via props/hooks and never import `supabase` directly. All new tests use the same Vitest + Playwright pattern established in shared-infra.

**Tech Stack:** Same as shared-infra — React 19, TypeScript, Vite, @supabase/supabase-js, Vitest, @testing-library/react, Playwright, CSS Modules. No new libraries.

**Related docs:** Design spec at [docs/2026-04-17-make-lila-order-review-design.md](./2026-04-17-make-lila-order-review-design.md). Full app spec at [docs/2026-04-16-make-lila-app-design.md](./2026-04-16-make-lila-app-design.md) §3.

---

## File Structure

New files:

```
E:\Claude\makelila\
  app\src\
    modules\OrderReview\
      index.tsx              Layout shell + URL-driven selection state
      OrderReview.module.css Module-scoped styling
      Sidebar.tsx            Status tabs + search + order list
      OrderRow.tsx           One sidebar row (country flag, tags, status border)
      Detail.tsx             Right-side panel composer
      detail\
        CustomerCard.tsx     name/email/phone + Open QUO ↗
        AddressCard.tsx      address + verdict banner + map placeholder
        FreightCard.tsx      cost bar + threshold marker
        LineItemsCard.tsx    line_items table
        NotesCard.tsx        textarea; autosave on blur
        ActionBar.tsx        4 buttons with inline reason input
        ConfirmBanner.tsx    3s auto-dismiss success banner
    lib\
      orders.ts              useOrders(), useOrder(id), disposition(), needInfo(), updateNotes()
      orders.test.ts         vi.hoisted supabase mocks
    modules\OrderReview\__tests__\
      Sidebar.test.tsx
      Detail.test.tsx
  supabase\migrations\
    <timestamp>_orders.sql
    <timestamp>_seed_orders.sql
  app\tests\e2e\
    order-review.spec.ts
```

Modified files:

```
app\src\App.tsx                      add nested /order-review/:id route
app\src\modules\OrderReview.tsx      DELETE — replaced by OrderReview/index.tsx
```

### File responsibility boundaries

- `lib/orders.ts` — sole DB access. Exports hooks + action functions. Never reaches into React outside of the hooks.
- `OrderReview/index.tsx` — layout shell and selection routing only. Delegates list rendering to `Sidebar`, detail rendering to `Detail`.
- `Sidebar.tsx` / `OrderRow.tsx` — list UI. Zero DB calls; read from `useOrders` passed through props.
- `Detail.tsx` + `detail/*.tsx` — each card receives an `order` prop and renders. `ActionBar` and `NotesCard` additionally receive action callbacks as props (also no direct DB calls) so they can be unit-tested without a live stack.

---

## Task 1: `orders` migration

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\<timestamp>_orders.sql`

- [ ] **Step 1: Generate empty migration**

Run:
```bash
cd E:\Claude\makelila
./app/node_modules/.bin/supabase migration new orders
```

Expected: prints `Created new migration at supabase\migrations\<timestamp>_orders.sql`.

- [ ] **Step 2: Write migration SQL**

Paste into the new file:

```sql
-- orders: triage queue for incoming orders before fulfillment
create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  order_ref     text unique not null,
  status        text not null default 'pending'
                check (status in ('pending','approved','flagged','held')),

  customer_name  text not null,
  customer_email text,
  customer_phone text,
  quo_thread_url text,

  address_line   text not null,
  city           text not null,
  region_state   text,
  country        text not null check (country in ('US','CA')),
  address_verdict text not null
                  check (address_verdict in ('house','apt','remote','condo')),

  freight_estimate_usd  numeric(10,2) not null,
  freight_threshold_usd numeric(10,2) not null,

  total_usd     numeric(10,2) not null,
  line_items    jsonb not null default '[]'::jsonb,

  notes         text not null default '',
  dispositioned_by uuid references auth.users(id),
  dispositioned_at timestamptz,

  created_at    timestamptz not null default now()
);

create index if not exists idx_orders_status_created
  on public.orders (status, created_at desc);

alter table public.orders enable row level security;

create policy "orders_select"
  on public.orders for select
  to authenticated
  using (true);

create policy "orders_update"
  on public.orders for update
  to authenticated
  using (true);

alter publication supabase_realtime add table public.orders;
```

- [ ] **Step 3: Apply migration to local stack**

Run:
```bash
cd E:\Claude\makelila
./app/node_modules/.bin/supabase db reset --local
```

Expected: migrations apply in order; final line reads "Finished supabase db reset on branch main." Local Postgres at `127.0.0.1:54322` now has `public.orders`.

- [ ] **Step 4: Smoke-test schema**

Run:
```bash
docker exec supabase_db_makelila psql -U postgres -d postgres -c "
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-000000000099', 'test@virgohome.io','authenticated','authenticated');

insert into public.orders (
  order_ref, customer_name, address_line, city, country,
  address_verdict, freight_estimate_usd, freight_threshold_usd, total_usd
) values (
  '#TEST-1', 'Smoke Tester', '1 Way', 'Portland', 'US',
  'house', 89.50, 200.00, 1149.00
);

select order_ref, status, address_verdict from public.orders;

-- verify RLS enabled and realtime publication
select rowsecurity from pg_tables where schemaname='public' and tablename='orders';
select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename='orders';

delete from public.orders where order_ref='#TEST-1';
delete from auth.users where id='00000000-0000-0000-0000-000000000099';
"
```

Expected: insert succeeds, select returns one row `status=pending address_verdict=house`, `rowsecurity=t`, publication shows `orders`.

- [ ] **Step 5: Commit**

```bash
cd E:\Claude\makelila
git add supabase/migrations/
git commit -m "feat(db): add orders table with RLS and realtime"
```

---

## Task 2: `seed_orders` migration

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\<timestamp>_seed_orders.sql`

Eight orders. Spread: 6 pending, 1 flagged, 1 held · 5 US, 3 CA · 2 apt/condo · 1 over freight threshold.

- [ ] **Step 1: Generate migration**

```bash
cd E:\Claude\makelila
./app/node_modules/.bin/supabase migration new seed_orders
```

- [ ] **Step 2: Write seed SQL**

```sql
insert into public.orders (
  order_ref, status, customer_name, customer_email, customer_phone, quo_thread_url,
  address_line, city, region_state, country, address_verdict,
  freight_estimate_usd, freight_threshold_usd,
  total_usd, line_items
) values
  ('#3847', 'pending', 'Keith Taitano', 'keith.taitano@gmail.com', '+15035550101',
   'https://my.quo.com/inbox/PNY7S3rMek',
   '2847 SW Corbett Ave', 'Portland', 'OR', 'US', 'house',
   89.50, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3848', 'pending', 'Marianne Chen', 'marianne.chen@protonmail.com', '+16042225599',
   null,
   '1050 Burrard St #2201', 'Vancouver', 'BC', 'CA', 'apt',
   115.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3849', 'pending', 'Raymond Park', 'ray.park@hotmail.com', '+14168904412',
   null,
   '88 Scott St #3106', 'Toronto', 'ON', 'CA', 'condo',
   135.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3850', 'pending', 'Ashley Brooks', 'abrooks@yahoo.com', '+12069991112',
   null,
   '415 1st Ave N', 'Seattle', 'WA', 'US', 'house',
   95.00, 200.00, 2298.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":2,"price_usd":1149.00}]'::jsonb),

  ('#3851', 'pending', 'Gordon Huang', 'gordon.h@icloud.com', '+14155550123',
   'https://my.quo.com/inbox/QH81MRZtxC',
   '2150 Lombard St', 'San Francisco', 'CA', 'US', 'house',
   105.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3852', 'pending', 'Nora Bélanger', 'nora.belanger@videotron.ca', '+15145551234',
   null,
   '1234 Rue Sherbrooke O', 'Montréal', 'QC', 'CA', 'house',
   125.00, 200.00, 1244.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00},{"sku":"LL-ACC-01","name":"Starter soil kit","qty":1,"price_usd":95.00}]'::jsonb),

  ('#3845', 'flagged', 'Derek Sloan', 'dsloan@example.com', '+19075550000',
   null,
   'Mile 63 Haul Rd', 'Coldfoot', 'AK', 'US', 'remote',
   275.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3846', 'held', 'Melanie Ortiz', 'm.ortiz@outlook.com', '+13055550189',
   null,
   '845 Collins Ave', 'Miami Beach', 'FL', 'US', 'apt',
   150.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb)
on conflict (order_ref) do nothing;
```

- [ ] **Step 3: Apply and verify**

```bash
cd E:\Claude\makelila
./app/node_modules/.bin/supabase db reset --local
```

Then:
```bash
docker exec supabase_db_makelila psql -U postgres -d postgres -c "
select status, count(*) from public.orders group by status order by status;
select count(*) filter (where country='US') as us,
       count(*) filter (where country='CA') as ca from public.orders;
select count(*) from public.orders where freight_estimate_usd > freight_threshold_usd;
"
```

Expected: 4 status groups (6 pending, 1 flagged, 1 held), 5 US / 3 CA, 1 over-threshold.

- [ ] **Step 4: Commit**

```bash
cd E:\Claude\makelila
git add supabase/migrations/
git commit -m "feat(db): seed orders with 8 mock rows (6 pending, 1 flagged, 1 held)"
```

---

## Task 3: `lib/orders.ts` — `disposition`, `needInfo`, `updateNotes` (TDD)

**Files:**
- Create: `E:\Claude\makelila\app\src\lib\orders.test.ts`
- Create: `E:\Claude\makelila\app\src\lib\orders.ts`

- [ ] **Step 1: Write failing test**

Paste into `app/src/lib/orders.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMock, eqMock, insertMock, fromMock, getUserMock, logActionMock } = vi.hoisted(() => {
  const updateMock = vi.fn();
  const eqMock = vi.fn();
  const insertMock = vi.fn();
  const fromMock = vi.fn((table: string) => {
    if (table === 'orders') {
      // disposition chain: .update({...}).eq('id', id) — eq resolves the promise
      return { update: updateMock };
    }
    // activity_log path, in case it slips through un-mocked
    return { insert: insertMock };
  });
  const getUserMock = vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
  );
  const logActionMock = vi.fn(() => Promise.resolve());
  return { updateMock, eqMock, insertMock, fromMock, getUserMock, logActionMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: getUserMock },
  },
}));
vi.mock('./activityLog', () => ({
  logAction: logActionMock,
}));

import { disposition, needInfo, updateNotes } from './orders';

describe('disposition', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
    fromMock.mockClear();
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
  });

  it('updates status + timestamps and writes activity_log verb-form type', async () => {
    await disposition('order-1', 'approved', 'Looks good');

    expect(fromMock).toHaveBeenCalledWith('orders');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      dispositioned_by: 'user-1',
    }));
    expect(eqMock).toHaveBeenCalledWith('id', 'order-1');
    expect(logActionMock).toHaveBeenCalledWith(
      'order_approve',
      expect.any(String),
      'Looks good',
    );
  });

  it.each([
    ['flagged' as const, 'order_flag'],
    ['held' as const,    'order_hold'],
  ])('maps %s → %s', async (status, type) => {
    await disposition('order-2', status, 'reason');
    expect(logActionMock).toHaveBeenCalledWith(type, expect.any(String), 'reason');
  });

  it('throws if unauthenticated', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    await expect(disposition('order-3', 'approved')).rejects.toThrow(/not authenticated/i);
  });

  it('surfaces the UPDATE error', async () => {
    eqMock.mockResolvedValueOnce({ data: null, error: new Error('RLS denied') });
    await expect(disposition('order-4', 'approved')).rejects.toThrow(/RLS denied/);
    expect(logActionMock).not.toHaveBeenCalled();
  });
});

describe('needInfo', () => {
  beforeEach(() => {
    updateMock.mockReset();
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
  });

  it('writes activity_log without changing status', async () => {
    await needInfo('order-1', 'Need a photo of the driveway');
    expect(updateMock).not.toHaveBeenCalled();
    expect(logActionMock).toHaveBeenCalledWith(
      'order_need_info',
      expect.any(String),
      'Need a photo of the driveway',
    );
  });
});

describe('updateNotes', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
    logActionMock.mockReset();
  });

  it('issues an UPDATE and does not log', async () => {
    await updateNotes('order-1', 'internal follow-up needed');
    expect(updateMock).toHaveBeenCalledWith({ notes: 'internal follow-up needed' });
    expect(eqMock).toHaveBeenCalledWith('id', 'order-1');
    expect(logActionMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd E:\Claude\makelila\app
npm run test:run -- orders
```

Expected: FAIL — module `./orders` not found.

- [ ] **Step 3: Implement `lib/orders.ts` (disposition/needInfo/updateNotes only)**

```ts
import { supabase } from './supabase';
import { logAction } from './activityLog';

export type OrderStatus = 'pending' | 'approved' | 'flagged' | 'held';

export type LineItem = {
  sku: string;
  name: string;
  qty: number;
  price_usd: number;
};

export type Order = {
  id: string;
  order_ref: string;
  status: OrderStatus;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  quo_thread_url: string | null;
  address_line: string;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  address_verdict: 'house' | 'apt' | 'remote' | 'condo';
  freight_estimate_usd: number;
  freight_threshold_usd: number;
  total_usd: number;
  line_items: LineItem[];
  notes: string;
  dispositioned_by: string | null;
  dispositioned_at: string | null;
  created_at: string;
};

const ACTION_TYPE: Record<Exclude<OrderStatus, 'pending'>, string> = {
  approved: 'order_approve',
  flagged:  'order_flag',
  held:     'order_hold',
};

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('orders: not authenticated');
  return data.user.id;
}

export async function disposition(
  id: string,
  status: Exclude<OrderStatus, 'pending'>,
  reason?: string,
): Promise<void> {
  const userId = await currentUserId();

  const { error } = await supabase
    .from('orders')
    .update({
      status,
      dispositioned_by: userId,
      dispositioned_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;

  await logAction(ACTION_TYPE[status], `Order ${id.slice(0, 8)}`, reason ?? '');
}

export async function needInfo(id: string, note: string = ''): Promise<void> {
  await currentUserId();
  await logAction('order_need_info', `Order ${id.slice(0, 8)}`, note);
}

export async function updateNotes(id: string, notes: string): Promise<void> {
  const { error } = await supabase.from('orders').update({ notes }).eq('id', id);
  if (error) throw error;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd E:\Claude\makelila\app
npm run test:run -- orders
```

Expected: 6 tests pass (1 approve + 2 mapped statuses via `it.each` + 1 unauth + 1 update-error + 1 needInfo + 1 updateNotes = 7 total including the `it.each` expanding to 2).

- [ ] **Step 5: Commit**

```bash
cd E:\Claude\makelila
git add app/src/lib/orders.ts app/src/lib/orders.test.ts
git commit -m "feat(app): orders client lib — disposition, needInfo, updateNotes"
```

---

## Task 4: `lib/orders.ts` — `useOrders` + `useOrder` hooks

**Files:**
- Modify: `E:\Claude\makelila\app\src\lib\orders.ts` (append hooks)

No unit tests for the realtime hooks here — mocking the full channel API is noisy and the integration is verified by the Playwright e2e in Task 13. Component tests in Tasks 11/12 use a stub `useOrders` via prop drilling.

- [ ] **Step 1: Append imports and hooks to `lib/orders.ts`**

At the top of the file, add:
```ts
import { useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
```

At the bottom of the file, add:
```ts
function applyChange(cache: Order[], payload: { eventType: string; new: Order | null; old: { id: string } | null }): Order[] {
  if (payload.eventType === 'DELETE' && payload.old) {
    return cache.filter(o => o.id !== payload.old!.id);
  }
  if (payload.new) {
    const existing = cache.findIndex(o => o.id === payload.new!.id);
    if (existing >= 0) {
      const next = [...cache];
      next[existing] = payload.new;
      return next;
    }
    return [payload.new, ...cache];
  }
  return cache;
}

export function useOrders(): {
  all: Order[];
  pending: Order[];
  held: Order[];
  flagged: Order[];
  loading: boolean;
} {
  const [cache, setCache] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false });

      if (cancelled) return;
      if (!error && data) setCache(data as Order[]);
      setLoading(false);

      channel = supabase
        .channel('orders:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders' },
          (payload) => {
            setCache(prev => applyChange(prev, {
              eventType: payload.eventType,
              new: payload.new as Order | null,
              old: payload.old as { id: string } | null,
            }));
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void channel.unsubscribe();
    };
  }, []);

  return useMemo(() => ({
    all:     cache,
    pending: cache.filter(o => o.status === 'pending'),
    held:    cache.filter(o => o.status === 'held'),
    flagged: cache.filter(o => o.status === 'flagged'),
    loading,
  }), [cache, loading]);
}

export function useOrder(id: string | null): { order: Order | null; loading: boolean } {
  const { all, loading } = useOrders();
  const order = id ? all.find(o => o.id === id) ?? null : null;
  return { order, loading: loading && !order };
}
```

- [ ] **Step 2: Verify the whole test suite still passes**

```bash
cd E:\Claude\makelila\app
npm run test:run
```

Expected: prior passing counts (orders = 7 + activityLog = 3 + auth = 2 + supabase = 2 + sanity = 1 = 15 tests total).

- [ ] **Step 3: Verify build succeeds**

```bash
cd E:\Claude\makelila\app
npm run build
```

Expected: build completes, no TS errors.

- [ ] **Step 4: Commit**

```bash
cd E:\Claude\makelila
git add app/src/lib/orders.ts
git commit -m "feat(app): add useOrders + useOrder realtime hooks"
```

---

## Task 5: Module shell — `OrderReview/index.tsx` + router update

**Files:**
- Delete: `E:\Claude\makelila\app\src\modules\OrderReview.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\index.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\OrderReview.module.css`
- Modify: `E:\Claude\makelila\app\src\App.tsx` (nest the `:orderId` route)

- [ ] **Step 1: Create stub CSS module**

Paste into `app/src/modules/OrderReview/OrderReview.module.css`:
```css
.layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  height: calc(100vh - 160px);
  min-height: 560px;
  background: #fff;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  overflow: hidden;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-ink-subtle);
  font-size: 12px;
  padding: 40px;
}
```

- [ ] **Step 2: Create `OrderReview/index.tsx` with a minimal shell**

```tsx
import { useNavigate, useParams } from 'react-router-dom';
import { useOrders, useOrder } from '../../lib/orders';
import styles from './OrderReview.module.css';

export default function OrderReview() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { pending, held, flagged, loading } = useOrders();
  const { order: selected } = useOrder(orderId ?? null);

  // Auto-select the first pending order if no selection
  if (!loading && !orderId && pending.length > 0) {
    navigate(`/order-review/${pending[0].id}`, { replace: true });
  }

  return (
    <div className={styles.layout}>
      <aside>
        {/* Sidebar comes in Task 6 */}
        <div className={styles.empty}>
          {loading ? 'Loading…' : `${pending.length} pending · ${held.length} held · ${flagged.length} flagged`}
        </div>
      </aside>
      <section>
        {selected ? (
          <div className={styles.empty}>Selected: {selected.order_ref}</div>
        ) : (
          <div className={styles.empty}>Select an order from the left to review.</div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Delete the old single-file placeholder**

```bash
cd E:\Claude\makelila
rm app/src/modules/OrderReview.tsx
```

- [ ] **Step 4: Update router to add the `:orderId` nested route**

In [app/src/App.tsx](app/src/App.tsx), replace the existing Order Review route line:
```tsx
<Route path="order-review"  element={<OrderReview />} />
```
with:
```tsx
<Route path="order-review"          element={<OrderReview />} />
<Route path="order-review/:orderId" element={<OrderReview />} />
```

The `OrderReview` component imports automatically resolve to the new `modules/OrderReview/index.tsx` path.

- [ ] **Step 5: Manual verification**

Start dev server (if not already running):
```bash
cd E:\Claude\makelila\app
npm run dev
```

Visit `http://localhost:5173/order-review` in a signed-in browser.

Expected: module renders with "6 pending · 1 held · 1 flagged" text in the left column and "Selected: #3847" (or whichever pending order has earliest created_at) in the right; URL redirects to `/order-review/<uuid>`.

Stop the dev server before continuing.

- [ ] **Step 6: Verify build**

```bash
cd E:\Claude\makelila\app
npm run build
```

Expected: build passes.

- [ ] **Step 7: Commit**

```bash
cd E:\Claude\makelila
git add app/src/modules/OrderReview/ app/src/App.tsx
git rm app/src/modules/OrderReview.tsx
git commit -m "feat(app): OrderReview module shell + nested /:orderId route"
```

---

## Task 6: Sidebar + OrderRow

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\Sidebar.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\OrderRow.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\OrderReview\OrderReview.module.css` (append sidebar styles)
- Modify: `E:\Claude\makelila\app\src\modules\OrderReview\index.tsx` (use the new Sidebar)

- [ ] **Step 1: Append sidebar styles to `OrderReview.module.css`**

```css
.sidebar {
  background: var(--color-dark-1);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebarHeader {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-dark-3);
}

.tabBar {
  display: flex;
  gap: 2px;
  margin-bottom: 8px;
}

.tab {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--color-ink-subtle);
  font-size: 10px;
  font-weight: 700;
  padding: 6px 0;
  cursor: pointer;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.tab.activeTab {
  background: var(--color-crimson);
  color: #fff;
}

.search {
  width: 100%;
  background: var(--color-dark-2);
  border: 1px solid var(--color-dark-3);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 11px;
  color: #ccc;
}

.list {
  flex: 1;
  overflow-y: auto;
}

.emptyList {
  padding: 20px 14px;
  color: var(--color-ink-faint);
  font-size: 11px;
  text-align: center;
}

.row {
  padding: 10px 14px;
  border-bottom: 1px solid #252525;
  cursor: pointer;
  transition: background 0.1s;
}

.row:hover { background: #232323; }

.row.selected {
  background: #2a1010;
  border-left: 3px solid var(--color-crimson);
  padding-left: 11px;
}

.row.flaggedRow {
  border-left: 3px solid var(--color-error-strong);
  padding-left: 11px;
  background: #1a1010;
}

.rowName {
  font-size: 12px;
  font-weight: 600;
  color: #e8e8e8;
}

.rowMeta {
  font-size: 10px;
  color: #888;
  margin-top: 2px;
}

.tag {
  display: inline-block;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 700;
  margin-right: 4px;
}
.tagCa { background: var(--color-crimson); color: #fff; }
.tagUs { background: var(--color-us-navy); color: #fff; }
.tagWarn { background: #742a2a; color: #feb2b2; }
```

- [ ] **Step 2: Implement `OrderRow.tsx`**

```tsx
import type { Order } from '../../lib/orders';
import styles from './OrderReview.module.css';

export function OrderRow({
  order,
  isSelected,
  onClick,
}: {
  order: Order;
  isSelected: boolean;
  onClick: () => void;
}) {
  const cls = [
    styles.row,
    isSelected ? styles.selected : '',
    order.status === 'flagged' ? styles.flaggedRow : '',
  ].filter(Boolean).join(' ');

  const countryTag = order.country === 'CA' ? styles.tagCa : styles.tagUs;
  const isRiskAddress = order.address_verdict === 'apt' || order.address_verdict === 'condo' || order.address_verdict === 'remote';

  return (
    <div className={cls} onClick={onClick} role="button" tabIndex={0}>
      <div className={styles.rowName}>{order.customer_name}</div>
      <div className={styles.rowMeta}>
        <span className={`${styles.tag} ${countryTag}`}>{order.country}</span>
        {isRiskAddress && (
          <span className={`${styles.tag} ${styles.tagWarn}`}>{order.address_verdict}</span>
        )}
        {order.order_ref} · {order.city}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement `Sidebar.tsx`**

```tsx
import { useMemo, useState } from 'react';
import type { Order, OrderStatus } from '../../lib/orders';
import { OrderRow } from './OrderRow';
import styles from './OrderReview.module.css';

type Tab = 'pending' | 'held' | 'flagged' | 'all';

export function Sidebar({
  pending, held, flagged, all,
  selectedId,
  onSelect,
}: {
  pending: Order[];
  held: Order[];
  flagged: Order[];
  all: Order[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('pending');
  const [query, setQuery] = useState('');

  const source = tab === 'pending' ? pending
               : tab === 'held'    ? held
               : tab === 'flagged' ? flagged
               : all;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return source;
    return source.filter(o =>
      o.customer_name.toLowerCase().includes(q) ||
      o.order_ref.toLowerCase().includes(q) ||
      (o.customer_email ?? '').toLowerCase().includes(q),
    );
  }, [source, query]);

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'pending', label: 'Pending', count: pending.length },
    { key: 'held',    label: 'Held',    count: held.length },
    { key: 'flagged', label: 'Flagged', count: flagged.length },
    { key: 'all',     label: 'All',     count: all.length },
  ];

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>
        <div className={styles.tabBar}>
          {tabs.map(t => (
            <button
              key={t.key}
              className={`${styles.tab} ${tab === t.key ? styles.activeTab : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>
        <input
          className={styles.search}
          placeholder="Search name, email, order #"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </div>
      <div className={styles.list}>
        {visible.length === 0 ? (
          <div className={styles.emptyList}>No orders in this tab.</div>
        ) : visible.map(o => (
          <OrderRow
            key={o.id}
            order={o}
            isSelected={o.id === selectedId}
            onClick={() => onSelect(o.id)}
          />
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Rewire `OrderReview/index.tsx` to use the Sidebar**

Replace `index.tsx` with:
```tsx
import { useNavigate, useParams } from 'react-router-dom';
import { useOrders, useOrder } from '../../lib/orders';
import { Sidebar } from './Sidebar';
import styles from './OrderReview.module.css';

export default function OrderReview() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { all, pending, held, flagged, loading } = useOrders();
  const { order: selected } = useOrder(orderId ?? null);

  if (!loading && !orderId && pending.length > 0) {
    navigate(`/order-review/${pending[0].id}`, { replace: true });
  }

  return (
    <div className={styles.layout}>
      <Sidebar
        all={all}
        pending={pending}
        held={held}
        flagged={flagged}
        selectedId={orderId ?? null}
        onSelect={(id) => navigate(`/order-review/${id}`)}
      />
      <section>
        {selected ? (
          <div className={styles.empty}>Selected: {selected.order_ref}</div>
        ) : (
          <div className={styles.empty}>Select an order from the left to review.</div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Verify dev server**

```bash
cd E:\Claude\makelila\app
npm run dev
```

Visit `http://localhost:5173/order-review`.

Expected: sidebar shows four tabs with counts, search box, list of pending orders, clicking a row swaps the right-side placeholder.

Stop the server.

- [ ] **Step 6: Verify build + full test suite still green**

```bash
cd E:\Claude\makelila\app
npm run build
npm run test:run
```

Expected: build passes; tests still pass (we added UI, not tests).

- [ ] **Step 7: Commit**

```bash
cd E:\Claude\makelila
git add app/src/modules/OrderReview/
git commit -m "feat(app): OrderReview Sidebar with status tabs + search"
```

---

## Task 7: Detail composer + static cards (Customer / Address / Freight / LineItems)

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\Detail.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\detail\CustomerCard.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\detail\AddressCard.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\detail\FreightCard.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\detail\LineItemsCard.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\OrderReview\OrderReview.module.css` (append detail styles)
- Modify: `E:\Claude\makelila\app\src\modules\OrderReview\index.tsx` (use Detail)

These four cards are pure rendering — they receive an `order` prop and output JSX, no state, no callbacks. They're grouped into one task because each is small (~30 lines) and tests for pure rendering are low-value.

- [ ] **Step 1: Append detail styles to `OrderReview.module.css`**

```css
.detail {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: var(--color-surface);
}

.detailBody {
  flex: 1;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card {
  background: #fff;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.cardHead {
  padding: 9px 14px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 9px;
  font-weight: 700;
  color: var(--color-crimson);
  letter-spacing: 0.7px;
  text-transform: uppercase;
}

.cardBody { padding: 12px 14px; font-size: 12px; color: var(--color-ink); }

.muted { color: var(--color-ink-subtle); font-size: 11px; }

.quoLink {
  display: inline-block;
  margin-top: 6px;
  background: var(--color-info);
  color: #fff;
  padding: 5px 12px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  text-decoration: none;
}

.verdict {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  border-width: 1.5px;
  border-style: solid;
  margin-top: 10px;
}
.verdictHouse {
  background: var(--color-success-bg);
  border-color: var(--color-success-border);
  color: var(--color-success);
}
.verdictApt, .verdictCondo, .verdictRemote {
  background: var(--color-error-bg);
  border-color: var(--color-error-border);
  color: var(--color-error);
}

.mapMock {
  height: 140px;
  border-radius: var(--radius-sm);
  margin-top: 10px;
  background: linear-gradient(135deg, #e8f4f8 0%, #d4eaf5 30%, #c8e6c9 60%, #dcedc8 100%);
}

.costBarWrap {
  background: #e2e8f0;
  border-radius: 3px;
  height: 8px;
  margin-top: 6px;
  position: relative;
}
.costBarFill {
  height: 100%;
  border-radius: 3px;
}
.costBarUnder { background: #48bb78; }
.costBarOver  { background: #e53e3e; }
.costThreshold {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  background: #e53e3e;
}

.liTable {
  width: 100%;
  font-size: 11px;
  border-collapse: collapse;
}
.liTable th, .liTable td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
}
.liTable th { color: var(--color-ink-subtle); font-weight: 700; font-size: 10px; text-transform: uppercase; }
.liTable tfoot td { font-weight: 700; }
```

- [ ] **Step 2: Create `detail/CustomerCard.tsx`**

```tsx
import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

export function CustomerCard({ order }: { order: Order }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Customer</div>
      <div className={styles.cardBody}>
        <div style={{ fontWeight: 700 }}>{order.customer_name}</div>
        {order.customer_email && <div className={styles.muted}>{order.customer_email}</div>}
        {order.customer_phone && <div className={styles.muted}>{order.customer_phone}</div>}
        {order.quo_thread_url && (
          <a
            className={styles.quoLink}
            href={order.quo_thread_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open QUO ↗
          </a>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `detail/AddressCard.tsx`**

```tsx
import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

const VERDICT_CLASS: Record<Order['address_verdict'], string> = {
  house:  styles.verdictHouse,
  apt:    styles.verdictApt,
  condo:  styles.verdictCondo,
  remote: styles.verdictRemote,
};

const VERDICT_LABEL: Record<Order['address_verdict'], string> = {
  house:  'Single-family · standard delivery',
  apt:    'Apartment · delivery may need coordination',
  condo:  'Condo · concierge / dock concerns',
  remote: 'Remote area · freight surcharge likely',
};

export function AddressCard({ order }: { order: Order }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Shipping Address</div>
      <div className={styles.cardBody}>
        <div>{order.address_line}</div>
        <div className={styles.muted}>
          {order.city}{order.region_state ? `, ${order.region_state}` : ''} · {order.country}
        </div>
        <div className={`${styles.verdict} ${VERDICT_CLASS[order.address_verdict]}`}>
          <strong>{order.address_verdict.toUpperCase()}</strong>
          <span>{VERDICT_LABEL[order.address_verdict]}</span>
        </div>
        <div className={styles.mapMock} aria-label="Map preview placeholder" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `detail/FreightCard.tsx`**

```tsx
import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

export function FreightCard({ order }: { order: Order }) {
  const scale = order.freight_threshold_usd * 1.25;
  const pct = Math.min(100, (order.freight_estimate_usd / scale) * 100);
  const thresholdPct = (order.freight_threshold_usd / scale) * 100;
  const over = order.freight_estimate_usd > order.freight_threshold_usd;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Freight Estimate</div>
      <div className={styles.cardBody}>
        <div>
          <strong>${order.freight_estimate_usd.toFixed(2)}</strong>
          <span className={styles.muted}>
            &nbsp;· threshold ${order.freight_threshold_usd.toFixed(2)}
            {over && <strong style={{ color: 'var(--color-error)' }}> · OVER</strong>}
          </span>
        </div>
        <div className={styles.costBarWrap}>
          <div
            className={`${styles.costBarFill} ${over ? styles.costBarOver : styles.costBarUnder}`}
            style={{ width: `${pct}%` }}
          />
          <div className={styles.costThreshold} style={{ left: `${thresholdPct}%` }} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `detail/LineItemsCard.tsx`**

```tsx
import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

export function LineItemsCard({ order }: { order: Order }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Line Items</div>
      <div className={styles.cardBody}>
        <table className={styles.liTable}>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Item</th>
              <th>Qty</th>
              <th style={{ textAlign: 'right' }}>Price</th>
            </tr>
          </thead>
          <tbody>
            {order.line_items.map((li, i) => (
              <tr key={`${li.sku}-${i}`}>
                <td>{li.sku}</td>
                <td>{li.name}</td>
                <td>{li.qty}</td>
                <td style={{ textAlign: 'right' }}>${(li.qty * li.price_usd).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Total</td>
              <td style={{ textAlign: 'right' }}>${order.total_usd.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Create `Detail.tsx` composer**

```tsx
import type { Order } from '../../lib/orders';
import { CustomerCard } from './detail/CustomerCard';
import { AddressCard }  from './detail/AddressCard';
import { FreightCard }  from './detail/FreightCard';
import { LineItemsCard } from './detail/LineItemsCard';
import styles from './OrderReview.module.css';

export function Detail({ order }: { order: Order }) {
  return (
    <section className={styles.detail}>
      <div className={styles.detailBody}>
        <CustomerCard order={order} />
        <AddressCard order={order} />
        <FreightCard order={order} />
        <LineItemsCard order={order} />
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Wire `Detail` into `index.tsx`**

Replace the placeholder right-side block in `index.tsx` with:
```tsx
{selected ? (
  <Detail order={selected} />
) : (
  <div className={styles.empty}>Select an order from the left to review.</div>
)}
```

And at the top of the file, add the import:
```tsx
import { Detail } from './Detail';
```

- [ ] **Step 8: Verify dev server + build**

```bash
cd E:\Claude\makelila\app
npm run dev
```

Visit `/order-review`, click a few rows. Each card renders with real seeded data. The over-threshold order (Derek Sloan in Alaska) should show the cost bar crossing the threshold marker with a red fill.

Stop dev server.

```bash
npm run build
```

Expected: build passes.

- [ ] **Step 9: Commit**

```bash
cd E:\Claude\makelila
git add app/src/modules/OrderReview/
git commit -m "feat(app): OrderReview Detail composer with customer/address/freight/line-items cards"
```

---

## Task 8: NotesCard with blur-autosave

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\detail\NotesCard.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\OrderReview\OrderReview.module.css` (append)
- Modify: `E:\Claude\makelila\app\src\modules\OrderReview\Detail.tsx` (import + render)

- [ ] **Step 1: Append styles**

```css
.notesArea {
  width: 100%;
  min-height: 80px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-family: inherit;
  color: var(--color-ink);
}

.notesStatus {
  margin-top: 6px;
  font-size: 10px;
  color: var(--color-ink-faint);
}
```

- [ ] **Step 2: Implement `NotesCard.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { Order } from '../../../lib/orders';
import { updateNotes } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

export function NotesCard({
  order,
  saveNotes = updateNotes,
}: {
  order: Order;
  saveNotes?: (id: string, notes: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(order.notes);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Reset draft if selected order changes or external update comes in
  useEffect(() => {
    setDraft(order.notes);
    setStatus('idle');
  }, [order.id, order.notes]);

  const handleBlur = async () => {
    if (draft === order.notes) return;
    setStatus('saving');
    try {
      await saveNotes(order.id, draft);
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Review Notes</div>
      <div className={styles.cardBody}>
        <textarea
          className={styles.notesArea}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={handleBlur}
          placeholder="Internal notes (visible to the whole team; saves when you click out)"
        />
        <div className={styles.notesStatus}>
          {status === 'saving' && 'Saving…'}
          {status === 'saved'  && 'Saved ✓'}
          {status === 'error'  && 'Save failed — try again'}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add NotesCard to `Detail.tsx`**

Import:
```tsx
import { NotesCard } from './detail/NotesCard';
```

Insert after `LineItemsCard`:
```tsx
<NotesCard order={order} />
```

- [ ] **Step 4: Manual verification**

```bash
cd E:\Claude\makelila\app
npm run dev
```

Visit `/order-review`, select an order, type in the Notes textarea, **click out**. Expect "Saved ✓" status. Refresh the page — the note should persist. Type in the textarea but don't blur — no network request fires.

Stop dev server.

- [ ] **Step 5: Commit**

```bash
cd E:\Claude\makelila
git add app/src/modules/OrderReview/
git commit -m "feat(app): OrderReview NotesCard with blur-autosave"
```

---

## Task 9: ActionBar + ConfirmBanner

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\detail\ActionBar.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\detail\ConfirmBanner.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\OrderReview\OrderReview.module.css` (append)
- Modify: `E:\Claude\makelila\app\src\modules\OrderReview\Detail.tsx` (wire disposition actions + banner)
- Modify: `E:\Claude\makelila\app\src\modules\OrderReview\index.tsx` (post-disposition navigation)

- [ ] **Step 1: Append styles**

```css
.actionBar {
  padding: 12px 18px;
  border-top: 1px solid var(--color-border);
  background: #fff;
  display: flex;
  align-items: center;
  gap: 10px;
}

.actionBtn {
  border: none;
  padding: 9px 22px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.actionConfirm { background: var(--color-success); color: #fff; }
.actionFlag    { background: #fff; color: var(--color-error-strong); border: 1.5px solid var(--color-error-strong); }
.actionHold    { background: #fff; color: var(--color-warning); border: 1.5px solid var(--color-warning-border); }
.actionInfo    { background: #fff; color: var(--color-ink-muted); border: 1.5px solid var(--color-border); }

.reasonRow { display: flex; gap: 8px; flex: 1; align-items: center; }
.reasonInput {
  flex: 1;
  padding: 8px 10px;
  font-size: 11px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-family: inherit;
}
.reasonSubmit { background: var(--color-ink); color: #fff; border: none; padding: 8px 14px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 700; cursor: pointer; }
.reasonCancel { background: #fff; color: var(--color-ink-subtle); border: 1px solid var(--color-border); padding: 8px 14px; border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; }

.banner {
  background: var(--color-success-bg);
  border: 1.5px solid var(--color-success-border);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  margin: 16px 18px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--color-success);
}
.bannerClose {
  background: transparent;
  border: none;
  color: var(--color-success);
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
}
```

- [ ] **Step 2: Implement `ConfirmBanner.tsx`**

```tsx
import { useEffect } from 'react';
import styles from '../OrderReview.module.css';

export function ConfirmBanner({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div className={styles.banner} role="status">
      <span>{message}</span>
      <button className={styles.bannerClose} onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  );
}
```

- [ ] **Step 3: Implement `ActionBar.tsx`**

```tsx
import { useState } from 'react';
import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

type ExpandedAction = 'flag' | 'hold' | 'info' | null;

export function ActionBar({
  order,
  onApprove,
  onFlag,
  onHold,
  onNeedInfo,
}: {
  order: Order;
  onApprove: () => void;
  onFlag: (reason: string) => void;
  onHold: (reason: string) => void;
  onNeedInfo: (note: string) => void;
}) {
  const [expanded, setExpanded] = useState<ExpandedAction>(null);
  const [reason, setReason] = useState('');

  const submit = () => {
    if (expanded === 'flag') {
      if (!reason.trim()) return;
      onFlag(reason);
    } else if (expanded === 'hold') {
      onHold(reason);
    } else if (expanded === 'info') {
      onNeedInfo(reason);
    }
    setExpanded(null);
    setReason('');
  };

  const cancel = () => { setExpanded(null); setReason(''); };

  if (expanded) {
    const placeholder =
      expanded === 'flag' ? 'Why is this being flagged? (required)' :
      expanded === 'hold' ? 'Why is this being held? (optional)' :
                            'What info is needed from the customer? (optional)';
    const submitDisabled = expanded === 'flag' && !reason.trim();
    return (
      <div className={styles.actionBar}>
        <div className={styles.reasonRow}>
          <input
            className={styles.reasonInput}
            autoFocus
            value={reason}
            placeholder={placeholder}
            onChange={e => setReason(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !submitDisabled) submit();
              if (e.key === 'Escape') cancel();
            }}
          />
          <button
            className={styles.reasonSubmit}
            disabled={submitDisabled}
            onClick={submit}
          >Submit</button>
          <button className={styles.reasonCancel} onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  }

  // Don't show the action bar if the order isn't in a disposition-able state
  if (order.status !== 'pending' && order.status !== 'held') {
    return (
      <div className={styles.actionBar}>
        <span className={styles.muted} style={{ fontSize: 11 }}>
          This order is {order.status}. No actions available.
        </span>
      </div>
    );
  }

  return (
    <div className={styles.actionBar}>
      <button className={`${styles.actionBtn} ${styles.actionConfirm}`} onClick={onApprove}>✓ Confirm</button>
      <button className={`${styles.actionBtn} ${styles.actionFlag}`}    onClick={() => setExpanded('flag')}>⚑ Flag</button>
      <button className={`${styles.actionBtn} ${styles.actionHold}`}    onClick={() => setExpanded('hold')}>⏸ Hold</button>
      <button className={`${styles.actionBtn} ${styles.actionInfo}`}    onClick={() => setExpanded('info')}>? Need Info</button>
    </div>
  );
}
```

- [ ] **Step 4: Wire disposition + banner in `Detail.tsx`**

Replace `Detail.tsx` with:
```tsx
import { useState } from 'react';
import type { Order } from '../../lib/orders';
import { disposition, needInfo } from '../../lib/orders';
import { CustomerCard } from './detail/CustomerCard';
import { AddressCard }  from './detail/AddressCard';
import { FreightCard }  from './detail/FreightCard';
import { LineItemsCard } from './detail/LineItemsCard';
import { NotesCard }    from './detail/NotesCard';
import { ActionBar }    from './detail/ActionBar';
import { ConfirmBanner } from './detail/ConfirmBanner';
import styles from './OrderReview.module.css';

export function Detail({
  order,
  onAfterDisposition,
}: {
  order: Order;
  onAfterDisposition: () => void;
}) {
  const [banner, setBanner] = useState<string | null>(null);

  const wrap = async (label: string, fn: () => Promise<void>) => {
    await fn();
    setBanner(`${label} · ${order.customer_name}`);
    onAfterDisposition();
  };

  return (
    <section className={styles.detail}>
      <ConfirmBanner message={banner} onDismiss={() => setBanner(null)} />
      <div className={styles.detailBody}>
        <CustomerCard order={order} />
        <AddressCard order={order} />
        <FreightCard order={order} />
        <LineItemsCard order={order} />
        <NotesCard order={order} />
      </div>
      <ActionBar
        order={order}
        onApprove={() => wrap('Approved', () => disposition(order.id, 'approved'))}
        onFlag={(reason) => wrap('Flagged', () => disposition(order.id, 'flagged', reason))}
        onHold={(reason) => wrap('Held',    () => disposition(order.id, 'held',    reason))}
        onNeedInfo={(note) => wrap('Need-info logged', () => needInfo(order.id, note))}
      />
    </section>
  );
}
```

- [ ] **Step 5: Update `index.tsx` to navigate after disposition**

Replace the body of `OrderReview` (in `index.tsx`) with:
```tsx
export default function OrderReview() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { all, pending, held, flagged, loading } = useOrders();
  const { order: selected } = useOrder(orderId ?? null);

  if (!loading && !orderId && pending.length > 0) {
    navigate(`/order-review/${pending[0].id}`, { replace: true });
  }

  const afterDisposition = () => {
    const remaining = pending.filter(o => o.id !== orderId);
    if (remaining.length > 0) {
      navigate(`/order-review/${remaining[0].id}`);
    } else {
      navigate('/order-review');
    }
  };

  return (
    <div className={styles.layout}>
      <Sidebar
        all={all}
        pending={pending}
        held={held}
        flagged={flagged}
        selectedId={orderId ?? null}
        onSelect={(id) => navigate(`/order-review/${id}`)}
      />
      {selected ? (
        <Detail order={selected} onAfterDisposition={afterDisposition} />
      ) : (
        <section className={styles.empty}>
          {loading ? 'Loading…' : 'Select an order from the left to review.'}
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Manual verification**

```bash
cd E:\Claude\makelila\app
npm run dev
```

Walk through:
1. Visit `/order-review` signed in → first pending row selected.
2. Click **Confirm** → banner shows "Approved · <name>"; row disappears from Pending tab; selection jumps to the next pending row.
3. Click **Flag** on another order → reason input appears; Submit is disabled until you type. Submit → banner; order moves to Flagged tab.
4. Click **Hold** → reason input appears; Submit works with empty reason.
5. Click **Need Info** → reason input appears; Submit works; status does NOT change; the order stays in Pending.
6. Visit Activity Log → new `order_approve`, `order_flag`, `order_hold`, `order_need_info` entries appear at the top.

Stop dev server.

- [ ] **Step 7: Verify build + unit tests**

```bash
cd E:\Claude\makelila\app
npm run build
npm run test:run
```

Expected: build + existing tests pass.

- [ ] **Step 8: Commit**

```bash
cd E:\Claude\makelila
git add app/src/modules/OrderReview/
git commit -m "feat(app): ActionBar with inline reason input + ConfirmBanner + post-disposition nav"
```

---

## Task 10: Component tests — Sidebar + Detail interactivity

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\__tests__\Sidebar.test.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview\__tests__\Detail.test.tsx`

- [ ] **Step 1: Write `Sidebar.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import type { Order } from '../../../lib/orders';

function mkOrder(partial: Partial<Order> & { id: string; status: Order['status'] }): Order {
  return {
    id: partial.id,
    order_ref: partial.order_ref ?? `#${partial.id}`,
    status: partial.status,
    customer_name: partial.customer_name ?? 'Test User',
    customer_email: null,
    customer_phone: null,
    quo_thread_url: null,
    address_line: '1 Way',
    city: 'Portland',
    region_state: 'OR',
    country: 'US',
    address_verdict: 'house',
    freight_estimate_usd: 89.5,
    freight_threshold_usd: 200,
    total_usd: 1149,
    line_items: [],
    notes: '',
    dispositioned_by: null,
    dispositioned_at: null,
    created_at: '2026-04-17T00:00:00Z',
  };
}

describe('Sidebar', () => {
  const p1 = mkOrder({ id: 'p1', status: 'pending', customer_name: 'Alice Ames' });
  const p2 = mkOrder({ id: 'p2', status: 'pending', customer_name: 'Bob Boxer' });
  const h1 = mkOrder({ id: 'h1', status: 'held',    customer_name: 'Held Customer' });
  const f1 = mkOrder({ id: 'f1', status: 'flagged', customer_name: 'Flagged Customer' });

  const render_ = (selectedId: string | null = null, onSelect = vi.fn()) =>
    render(
      <Sidebar
        all={[p1, p2, h1, f1]}
        pending={[p1, p2]}
        held={[h1]}
        flagged={[f1]}
        selectedId={selectedId}
        onSelect={onSelect}
      />,
    );

  it('shows only pending rows in the default tab', () => {
    render_();
    expect(screen.getByText('Alice Ames')).toBeInTheDocument();
    expect(screen.getByText('Bob Boxer')).toBeInTheDocument();
    expect(screen.queryByText('Held Customer')).not.toBeInTheDocument();
    expect(screen.queryByText('Flagged Customer')).not.toBeInTheDocument();
  });

  it('switches tab content when a tab is clicked', () => {
    render_();
    fireEvent.click(screen.getByText(/Flagged \(1\)/));
    expect(screen.getByText('Flagged Customer')).toBeInTheDocument();
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();
  });

  it('filters by search query within the active tab', () => {
    render_();
    const searchBox = screen.getByPlaceholderText(/search name/i);
    fireEvent.change(searchBox, { target: { value: 'bob' } });
    expect(screen.getByText('Bob Boxer')).toBeInTheDocument();
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();
  });

  it('invokes onSelect with the row id when a row is clicked', () => {
    const onSelect = vi.fn();
    render_(null, onSelect);
    fireEvent.click(screen.getByText('Alice Ames'));
    expect(onSelect).toHaveBeenCalledWith('p1');
  });

  it('shows empty-state copy when the active tab has no rows', () => {
    render(
      <Sidebar
        all={[]} pending={[]} held={[]} flagged={[]}
        selectedId={null} onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/no orders in this tab/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Write `Detail.test.tsx`**

This test exercises the ActionBar through Detail using mocked `disposition`/`needInfo`/`updateNotes`. It verifies the correct status/type per button.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { dispositionMock, needInfoMock, updateNotesMock } = vi.hoisted(() => ({
  dispositionMock: vi.fn(() => Promise.resolve()),
  needInfoMock:    vi.fn(() => Promise.resolve()),
  updateNotesMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    disposition: dispositionMock,
    needInfo:    needInfoMock,
    updateNotes: updateNotesMock,
  };
});

import { Detail } from '../Detail';
import type { Order } from '../../../lib/orders';

const order: Order = {
  id: 'order-1',
  order_ref: '#3847',
  status: 'pending',
  customer_name: 'Keith Taitano',
  customer_email: 'k@example.com',
  customer_phone: null,
  quo_thread_url: null,
  address_line: '2847 SW Corbett',
  city: 'Portland', region_state: 'OR', country: 'US',
  address_verdict: 'house',
  freight_estimate_usd: 89.5, freight_threshold_usd: 200,
  total_usd: 1149,
  line_items: [{ sku: 'LL01', name: 'Lila 01', qty: 1, price_usd: 1149 }],
  notes: '',
  dispositioned_by: null, dispositioned_at: null,
  created_at: '2026-04-17T00:00:00Z',
};

describe('Detail', () => {
  beforeEach(() => {
    dispositionMock.mockClear();
    needInfoMock.mockClear();
    updateNotesMock.mockClear();
  });

  it('Confirm calls disposition with status=approved', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith('order-1', 'approved');
    });
  });

  it('Flag requires a reason before Submit is enabled', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /flag/i }));
    const submit = screen.getByRole('button', { name: /submit/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/flagged/i), { target: { value: 'bad zip' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith('order-1', 'flagged', 'bad zip');
    });
  });

  it('Hold allows empty reason', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /hold/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith('order-1', 'held', '');
    });
  });

  it('Need Info calls needInfo (not disposition)', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /need info/i }));
    fireEvent.change(screen.getByPlaceholderText(/info is needed/i), { target: { value: 'driveway photo' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => {
      expect(needInfoMock).toHaveBeenCalledWith('order-1', 'driveway photo');
      expect(dispositionMock).not.toHaveBeenCalled();
    });
  });

  it('Notes textarea fires updateNotes on blur, not on change', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/internal notes/i);
    fireEvent.change(textarea, { target: { value: 'needs follow-up' } });
    expect(updateNotesMock).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    await waitFor(() => {
      expect(updateNotesMock).toHaveBeenCalledWith('order-1', 'needs follow-up');
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd E:\Claude\makelila\app
npm run test:run
```

Expected: all prior tests pass, plus 5 Sidebar + 5 Detail = 10 new tests.

- [ ] **Step 4: Commit**

```bash
cd E:\Claude\makelila
git add app/src/modules/OrderReview/__tests__/
git commit -m "test(app): component tests for Sidebar filtering + Detail actions"
```

---

## Task 11: Playwright E2E — unauth redirect for Order Review routes

**Files:**
- Create: `E:\Claude\makelila\app\tests\e2e\order-review.spec.ts`

Scoped to match the shared-infra e2e pattern: two hermetic tests with no auth. The authed approval flow is covered by the Task 10 component tests (mocked `disposition`) plus the manual two-browser walkthrough in Task 12. Reasoning: wiring Playwright up for authenticated Supabase sessions requires either a service-role-key shim or brittle localStorage probing — neither earns its keep against a simple manual run.

- [ ] **Step 1: Write `order-review.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

test('unauthed /order-review redirects to /login', async ({ page }) => {
  await page.goto('order-review');
  await expect(page).toHaveURL(/\/login/);
});

test('unauthed /order-review/:id redirects to /login', async ({ page }) => {
  await page.goto('order-review/00000000-0000-0000-0000-000000000000');
  await expect(page).toHaveURL(/\/login/);
});
```

- [ ] **Step 2: Run the e2e**

```bash
cd E:\Claude\makelila\app
npm run e2e
```

Expected: 4 tests passing (2 existing shared-infra smokes + 2 new Order Review redirects).

- [ ] **Step 3: Commit**

```bash
cd E:\Claude\makelila
git add app/tests/e2e/order-review.spec.ts
git commit -m "test(app): Playwright smoke — unauth redirect for order-review routes"
```

---

## Task 12: Fresh-install regression + prod build + deploy

**Files:**
- None modified (verification-only task)

- [ ] **Step 1: Clean regression run**

```bash
cd E:\Claude\makelila\app
rm -rf node_modules
npm ci
npm run test:run
npm run build
npm run e2e
```

Expected: all green.

- [ ] **Step 2: Manual walkthrough against design spec**

Run `npm run dev` and walk through each item in the design spec's "Done criteria":

1. ✅ `orders` table exists with RLS and realtime (verify in `supabase/migrations/`)
2. ✅ `/order-review` renders sidebar; selection renders detail
3. ✅ Confirm / Flag / Hold disposition + log; Need Info logs without status change
4. ✅ Notes autosave on blur
5. ✅ Two-browser realtime: sign in as the same user in browser A and an incognito browser B. In A, approve an order → verify it vanishes from B's sidebar within ~1s.
6. ✅ All tests green (ran in Step 1)
7. Deferred to Step 3 below

- [ ] **Step 3: Push + watch deploy**

Push via GitHub Desktop (13 commits since v0.1.0-infra).

Watch https://github.com/virgohomeio/makelila/actions for the `Deploy to GitHub Pages` workflow to complete green.

- [ ] **Step 4: Production verification**

Visit https://lila.vip/ signed in with an @virgohome.io account.

1. Navigate to Order Review → sidebar shows pending orders (same seeded data, because the remote DB has the same migrations applied — see Step 6 below).
2. Click an order → detail renders with all cards.
3. Click Confirm → banner, row removed, next pending selected.
4. Navigate to Activity Log → entry visible.

- [ ] **Step 5: Apply migrations to the remote DB**

If remote doesn't have the new tables/seeded orders yet, apply them:

```bash
cd E:\Claude\makelila
export SUPABASE_DB_PASSWORD=<db password from Supabase dashboard → Project Settings → Database>
./app/node_modules/.bin/supabase db push
```

Expected: `Applying migration 20260417..._orders.sql` and `...seed_orders.sql` succeed against the remote. Production verification in Step 4 should now work.

Note: the seed migration uses `on conflict (email) do nothing` — safe to re-run. Actually, it uses `on conflict (order_ref) do nothing` — same idempotent guarantee.

- [ ] **Step 6: Create the release on GitHub**

Navigate to https://github.com/virgohomeio/makelila/releases/new:

- **Tag:** `v0.2.0-order-review` (Create new tag on publish)
- **Target:** `main`
- **Title:** `v0.2.0-order-review — Order Review module`
- **Description:**
  ```
  Second release. Adds the Order Review module:

  - `orders` table in Supabase with RLS + realtime publication
  - 8 seeded mock orders (6 pending, 1 flagged, 1 held)
  - Sidebar with status tabs + search; realtime-driven list
  - Detail panel with customer, address (with verdict), freight meter,
    line items, internal notes (autosaved), and action bar
  - Four dispositions: Confirm / Flag / Hold / Need Info (the last
    logs without changing status)
  - Each disposition writes an `activity_log` entry; realtime drops
    the row from other reviewers' pending lists within ~1s

  Deferred: real Shopify integration, computed address verdict and
  freight, QUO iframe embed.
  ```

Click **Publish release**. The tag is now on the remote.

- [ ] **Step 7: Sync the local tag to match**

```bash
cd E:\Claude\makelila
git fetch --tags origin
git rev-parse v0.2.0-order-review
```

Expected: local tag resolves to the tip of main.

---

## Done criteria

The Order Review module is done when all of the following hold:

1. All unit tests pass (`npm run test:run`).
2. All e2e tests pass locally (`npm run e2e`).
3. Production build succeeds (`npm run build`).
4. Deploy to `https://lila.vip/` is green.
5. Two-browser manual realtime verification passes.
6. Remote Supabase has the `orders` migrations applied and the seed rows loaded.
7. `v0.2.0-order-review` tag exists on remote, release published.

## Next plans (not in scope here)

- Stock module (largest data model; other modules depend on its tables)
- Fulfillment Queue (consumes approved orders from this plan)
- Post-Shipment
- Activity Log dashboard upgrade (richer UI than the current simple feed)
- Real Shopify integration (feeds the `orders` table in this plan)
