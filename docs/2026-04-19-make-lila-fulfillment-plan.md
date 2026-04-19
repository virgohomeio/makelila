# Make Lila — Fulfillment Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Fulfillment Queue + Shelf sub-tabs end-to-end: approved orders auto-enqueue, reviewers walk each order through a 5-step state machine (Assign → Test → Label → Dock → Email → Fulfilled), and 150 P100 units are laid out on 30 drag-droppable skids with a rework panel.

**Architecture:** React + Supabase. Three new tables (`shelf_slots`, `fulfillment_queue`, `unit_reworks`) with RLS + realtime; one trigger auto-enqueues on `orders.status='approved'`; one Supabase Storage bucket for ship-label PDFs; one Deno edge function `send-fulfillment-email` sends via Resend. Follows the same file/test patterns established by the shipped Order Review module.

**Tech Stack:** React 19 + TypeScript + Vite + React Router v7, `@supabase/supabase-js`, Vitest, Playwright, Resend (transactional email), Supabase Storage. Package manager: npm.

**Related docs:** Design spec at `docs/2026-04-19-make-lila-fulfillment-design.md`. Prior shipped modules: shared-infra (`v0.1.0-infra`), Order Review (`v0.2.0-order-review`).

---

## File Structure

```
app/src/modules/Fulfillment/
  index.tsx                    Tab shell (Queue · Shelf) + sub-tab routing
  Fulfillment.module.css       Shared styles: tabs, step bar, skid cards, slots, reworks panel

  queue/
    index.tsx                  Sidebar + right step-view composer
    QueueSidebar.tsx           Deadline-sorted list of in-flight queue rows
    QueueHeader.tsx            Customer + order_ref + due date + step progress bar
    StepAssign.tsx             Step 1 — pick a serial
    StepTest.tsx               Step 2 — verify test + flag rework
    StepLabel.tsx              Step 3 — carrier + tracking + optional PDF upload
    StepDock.tsx               Step 4 — 4-item checklist
    StepEmail.tsx              Step 5 — starter tracking (US) + send
    StepFulfilled.tsx          Step 6 — terminal success view

  shelf/
    index.tsx                  Grid + confirm-layout + auto-assign preview
    SkidCard.tsx               30× — 3 portrait top + 2 landscape bottom
    Slot.tsx                   Individual slot (serial / batch / status color)
    ReworksPanel.tsx           Open-reworks list with resolve button

  __tests__/
    QueueSidebar.test.tsx
    StepTest.test.tsx
    StepEmail.test.tsx

app/src/lib/
  fulfillment.ts               All DB + edge-fn access; types, hooks, action functions
  fulfillment.test.ts          vi.hoisted-mocked; state transitions + rework

supabase/migrations/
  <ts>_shelf_slots.sql
  <ts>_fulfillment_queue.sql
  <ts>_unit_reworks.sql
  <ts>_seed_shelf_p100.sql
  <ts>_order_labels_bucket.sql

supabase/functions/
  send-fulfillment-email/
    index.ts

docs/
  2026-04-19-make-lila-fulfillment-plan.md      (this file)
  2026-04-19-make-lila-fulfillment-design.md    (spec)
  fulfillment-email-setup.md                    (Resend + DNS + API key runbook)
```

### File responsibility boundaries

- `lib/fulfillment.ts` — all DB/edge-fn access. Components never import `supabase` directly.
- `Fulfillment/index.tsx` — tab routing; no business logic.
- Queue step components — each fits in under ~80 lines. Take the queue row + action callbacks as props; no direct DB calls.
- Shelf components — pure render; drag state lives in `shelf/index.tsx`.

---

## Task 1: `shelf_slots` migration

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\<timestamp>_shelf_slots.sql`

- [ ] **Step 1: Generate migration**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase migration new shelf_slots
```

- [ ] **Step 2: Write SQL**

```sql
-- shelf_slots: 150 fixed physical positions (30 skids × 5 slots).
-- Slot-index convention: 0,1,2 = top row (portrait), 3,4 = bottom row (landscape).
create table if not exists public.shelf_slots (
  skid       text not null,
  slot_index smallint not null check (slot_index between 0 and 4),
  serial     text unique,
  batch      text,
  status     text not null default 'empty'
             check (status in ('available','reserved','rework','empty')),
  updated_at timestamptz not null default now(),
  primary key (skid, slot_index)
);

create index if not exists idx_shelf_slots_status on public.shelf_slots (status);

alter table public.shelf_slots enable row level security;

create policy "shelf_slots_select"
  on public.shelf_slots for select
  to authenticated
  using (true);

create policy "shelf_slots_update"
  on public.shelf_slots for update
  to authenticated
  using (true)
  with check (true);

alter publication supabase_realtime add table public.shelf_slots;
```

- [ ] **Step 3: Apply + smoke test**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/Docker/Docker/resources/bin:/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase db reset --local
```

```bash
docker exec supabase_db_makelila psql -U postgres -d postgres -c "
\d public.shelf_slots
select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename='shelf_slots';
"
```

Expected: table shown with 6 columns + pk + index, realtime publication includes `shelf_slots`.

- [ ] **Step 4: Commit**

```bash
cd /e/Claude/makelila
git add supabase/migrations/
git commit -m "feat(db): shelf_slots table for fulfillment inventory grid"
```

---

## Task 2: `fulfillment_queue` migration + auto-enqueue trigger

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\<timestamp>_fulfillment_queue.sql`

- [ ] **Step 1: Generate migration**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase migration new fulfillment_queue
```

- [ ] **Step 2: Write SQL**

```sql
-- fulfillment_queue: one row per approved order; 5-step state machine + fulfilled terminal.
create table if not exists public.fulfillment_queue (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  step smallint not null default 1 check (step between 1 and 6),

  assigned_serial text references public.shelf_slots(serial) on delete set null,

  test_report_url text,
  test_confirmed_at timestamptz,
  test_confirmed_by uuid references auth.users(id),

  carrier text check (carrier in ('UPS','FedEx','Purolator','Canada Post')),
  tracking_num text,
  label_pdf_path text,
  label_confirmed_at timestamptz,
  label_confirmed_by uuid references auth.users(id),

  dock_printed  boolean not null default false,
  dock_affixed  boolean not null default false,
  dock_docked   boolean not null default false,
  dock_notified boolean not null default false,
  dock_confirmed_at timestamptz,
  dock_confirmed_by uuid references auth.users(id),

  starter_tracking_num text,
  email_sent_at timestamptz,
  email_sent_by uuid references auth.users(id),

  fulfilled_at timestamptz,
  fulfilled_by uuid references auth.users(id),

  due_date date,
  created_at timestamptz not null default now()
);

create index if not exists idx_fulfillment_queue_due on public.fulfillment_queue (due_date asc);
create index if not exists idx_fulfillment_queue_step on public.fulfillment_queue (step);

alter table public.fulfillment_queue enable row level security;

create policy "fulfillment_queue_select"
  on public.fulfillment_queue for select
  to authenticated using (true);

create policy "fulfillment_queue_insert"
  on public.fulfillment_queue for insert
  to authenticated with check (true);

create policy "fulfillment_queue_update"
  on public.fulfillment_queue for update
  to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.fulfillment_queue;

-- Auto-enqueue trigger: when orders.status flips to 'approved', insert a queue row.
create or replace function public.auto_enqueue_approved_order()
returns trigger language plpgsql as $$
begin
  if new.status = 'approved' and (old.status is null or old.status <> 'approved') then
    insert into public.fulfillment_queue (order_id, due_date)
    values (new.id, (now() + interval '7 days')::date)
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists auto_enqueue_on_approve on public.orders;
create trigger auto_enqueue_on_approve
  after update of status on public.orders
  for each row execute function public.auto_enqueue_approved_order();
```

- [ ] **Step 3: Apply + smoke test**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/Docker/Docker/resources/bin:/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase db reset --local
```

```bash
docker exec supabase_db_makelila psql -U postgres -d postgres -c "
-- Approve an existing pending order → queue row appears
update public.orders set status='approved', dispositioned_at=now() where order_ref='#1107';
select order_ref, status from public.orders where order_ref='#1107';
select count(*) as queued from public.fulfillment_queue where order_id = (select id from public.orders where order_ref='#1107');

-- Revert for a clean slate
update public.orders set status='pending', dispositioned_at=null where order_ref='#1107';
delete from public.fulfillment_queue where order_id = (select id from public.orders where order_ref='#1107');
"
```

Expected: `queued = 1` after approve. Trigger works.

- [ ] **Step 4: Commit**

```bash
cd /e/Claude/makelila
git add supabase/migrations/
git commit -m "feat(db): fulfillment_queue state machine + auto-enqueue trigger"
```

---

## Task 3: `unit_reworks` migration

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\<timestamp>_unit_reworks.sql`

- [ ] **Step 1: Generate migration**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase migration new unit_reworks
```

- [ ] **Step 2: Write SQL**

```sql
-- unit_reworks: audit log of flagged-for-rework units.
create table if not exists public.unit_reworks (
  id bigserial primary key,
  serial text not null,
  skid text,
  slot_index smallint,
  order_id uuid references public.orders(id),
  issue text not null,
  flagged_by uuid not null references auth.users(id),
  flagged_by_name text not null,
  flagged_at timestamptz not null default now(),
  resolved_by uuid references auth.users(id),
  resolved_by_name text,
  resolved_at timestamptz,
  resolution_notes text
);

create index if not exists idx_unit_reworks_open
  on public.unit_reworks (flagged_at desc)
  where resolved_at is null;

alter table public.unit_reworks enable row level security;

create policy "unit_reworks_select"
  on public.unit_reworks for select
  to authenticated using (true);

create policy "unit_reworks_insert"
  on public.unit_reworks for insert
  to authenticated with check (flagged_by = auth.uid());

create policy "unit_reworks_update"
  on public.unit_reworks for update
  to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.unit_reworks;
```

- [ ] **Step 3: Apply**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/Docker/Docker/resources/bin:/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase db reset --local
```

- [ ] **Step 4: Commit**

```bash
cd /e/Claude/makelila
git add supabase/migrations/
git commit -m "feat(db): unit_reworks audit table"
```

---

## Task 4: Seed 150 P100 units across 30 skids

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\<timestamp>_seed_shelf_p100.sql`

- [ ] **Step 1: Generate migration**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase migration new seed_shelf_p100
```

- [ ] **Step 2: Write SQL**

The P100 batch arrived April 13, 2026. Seeds 150 serials `LL01-00000000001` – `LL01-00000000150` across 30 skids `A1`–`A30`, 5 slots each. Skid A1 gets serials 1–5, A2 gets 6–10, etc. All status `available`.

```sql
-- Seed 150 P100 units across 30 skids (A1-A30, 5 slots each).
-- Batch P100 arrived April 13, 2026. Slot indexes: 0,1,2 top (portrait); 3,4 bottom (landscape).
insert into public.shelf_slots (skid, slot_index, serial, batch, status)
select
  'A' || skid_num  as skid,
  slot_idx         as slot_index,
  'LL01-' || lpad(((skid_num - 1) * 5 + slot_idx + 1)::text, 11, '0') as serial,
  'P100'           as batch,
  'available'      as status
from generate_series(1, 30) as skid_num
cross join generate_series(0, 4) as slot_idx
on conflict (skid, slot_index) do update
  set serial = excluded.serial,
      batch = excluded.batch,
      status = excluded.status;
```

- [ ] **Step 3: Apply + verify**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/Docker/Docker/resources/bin:/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase db reset --local
```

```bash
docker exec supabase_db_makelila psql -U postgres -d postgres -c "
select count(*) as total from public.shelf_slots;
select status, count(*) from public.shelf_slots group by status;
select skid, slot_index, serial, batch
  from public.shelf_slots
 where skid in ('A1','A30')
 order by skid, slot_index;
"
```

Expected:
- `total = 150`
- `available = 150`
- A1: slots 0–4 with serials `LL01-00000000001` … `LL01-00000000005`
- A30: slots 0–4 with serials `LL01-00000000146` … `LL01-00000000150`

- [ ] **Step 4: Commit**

```bash
cd /e/Claude/makelila
git add supabase/migrations/
git commit -m "feat(db): seed 150 P100 units across 30 skids (A1-A30)"
```

---

## Task 5: `order-labels` storage bucket

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\<timestamp>_order_labels_bucket.sql`

- [ ] **Step 1: Generate migration**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase migration new order_labels_bucket
```

- [ ] **Step 2: Write SQL**

```sql
-- order-labels: private bucket for shipping label PDFs uploaded during Step 3.
-- Path convention: <order_id>/label-<timestamp>.pdf
insert into storage.buckets (id, name, public)
values ('order-labels', 'order-labels', false)
on conflict (id) do nothing;

-- Authenticated users can read any label.
create policy "order_labels_select"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'order-labels');

-- Authenticated users can upload labels.
create policy "order_labels_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'order-labels');

-- Authenticated users can replace labels.
create policy "order_labels_update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'order-labels')
  with check (bucket_id = 'order-labels');
```

- [ ] **Step 3: Apply + verify**

```bash
cd /e/Claude/makelila && export PATH="/c/Program Files/Docker/Docker/resources/bin:/c/Program Files/nodejs:$PATH" && ./app/node_modules/.bin/supabase db reset --local
```

```bash
docker exec supabase_db_makelila psql -U postgres -d postgres -c "
select id, public from storage.buckets where id='order-labels';
select policyname from pg_policies where tablename='objects' and policyname like 'order_labels%';
"
```

Expected: bucket exists with `public=false`, three policies (`order_labels_select/insert/update`).

- [ ] **Step 4: Commit**

```bash
cd /e/Claude/makelila
git add supabase/migrations/
git commit -m "feat(db): order-labels private storage bucket for ship-label PDFs"
```

---

## Task 6: `lib/fulfillment.ts` — types + realtime hooks

**Files:**
- Create: `E:\Claude\makelila\app\src\lib\fulfillment.ts`

No unit tests for the realtime hooks (mocking the full channel API is noisy; integration is verified by Playwright smoke + manual). Action functions get full TDD in Task 7+8.

- [ ] **Step 1: Write types + hooks**

```ts
import { useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type FulfillmentStep = 1 | 2 | 3 | 4 | 5 | 6;
export type ShelfSlotStatus = 'available' | 'reserved' | 'rework' | 'empty';

export type FulfillmentQueueRow = {
  id: string;
  order_id: string;
  step: FulfillmentStep;
  assigned_serial: string | null;

  test_report_url: string | null;
  test_confirmed_at: string | null;
  test_confirmed_by: string | null;

  carrier: string | null;
  tracking_num: string | null;
  label_pdf_path: string | null;
  label_confirmed_at: string | null;
  label_confirmed_by: string | null;

  dock_printed: boolean;
  dock_affixed: boolean;
  dock_docked: boolean;
  dock_notified: boolean;
  dock_confirmed_at: string | null;
  dock_confirmed_by: string | null;

  starter_tracking_num: string | null;
  email_sent_at: string | null;
  email_sent_by: string | null;

  fulfilled_at: string | null;
  fulfilled_by: string | null;

  due_date: string | null;
  created_at: string;
};

export type ShelfSlot = {
  skid: string;
  slot_index: number;
  serial: string | null;
  batch: string | null;
  status: ShelfSlotStatus;
  updated_at: string;
};

export type UnitRework = {
  id: number;
  serial: string;
  skid: string | null;
  slot_index: number | null;
  order_id: string | null;
  issue: string;
  flagged_by: string;
  flagged_by_name: string;
  flagged_at: string;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
};

// --- useFulfillmentQueue ---

export function useFulfillmentQueue(): {
  all: FulfillmentQueueRow[];
  ready: FulfillmentQueueRow[];
  fulfilled: FulfillmentQueueRow[];
  loading: boolean;
} {
  const [cache, setCache] = useState<FulfillmentQueueRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('fulfillment_queue')
        .select('*')
        .order('due_date', { ascending: true });
      if (cancelled) return;
      if (!error && data) setCache(data as FulfillmentQueueRow[]);
      setLoading(false);

      channel = supabase
        .channel('fulfillment_queue:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'fulfillment_queue' },
          (payload) => {
            setCache(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(r => r.id !== (payload.old as { id: string }).id);
              }
              if (payload.new) {
                const row = payload.new as FulfillmentQueueRow;
                const idx = prev.findIndex(r => r.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
                return [...prev, row];
              }
              return prev;
            });
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return useMemo(() => ({
    all: cache,
    ready: cache.filter(r => r.step < 6),
    fulfilled: cache.filter(r => r.step === 6),
    loading,
  }), [cache, loading]);
}

// --- useShelf ---

export function useShelf(): { slots: ShelfSlot[]; loading: boolean } {
  const [slots, setSlots] = useState<ShelfSlot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('shelf_slots')
        .select('*')
        .order('skid', { ascending: true })
        .order('slot_index', { ascending: true });
      if (cancelled) return;
      if (!error && data) setSlots(data as ShelfSlot[]);
      setLoading(false);

      channel = supabase
        .channel('shelf_slots:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'shelf_slots' },
          (payload) => {
            setSlots(prev => {
              const row = payload.new as ShelfSlot | null;
              if (!row) return prev;
              const idx = prev.findIndex(s => s.skid === row.skid && s.slot_index === row.slot_index);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [...prev, row];
            });
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { slots, loading };
}

// --- useOpenReworks ---

export function useOpenReworks(): { reworks: UnitRework[]; loading: boolean } {
  const [reworks, setReworks] = useState<UnitRework[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('unit_reworks')
        .select('*')
        .is('resolved_at', null)
        .order('flagged_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setReworks(data as UnitRework[]);
      setLoading(false);

      channel = supabase
        .channel('unit_reworks:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'unit_reworks' },
          (payload) => {
            setReworks(prev => {
              if (payload.eventType === 'INSERT' && payload.new) {
                return [payload.new as UnitRework, ...prev];
              }
              if (payload.eventType === 'UPDATE' && payload.new) {
                const row = payload.new as UnitRework;
                if (row.resolved_at) return prev.filter(r => r.id !== row.id);
                const idx = prev.findIndex(r => r.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              }
              return prev;
            });
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { reworks, loading };
}
```

- [ ] **Step 2: Verify build**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /e/Claude/makelila
git add app/src/lib/fulfillment.ts
git commit -m "feat(app): fulfillment lib — types + realtime hooks (queue, shelf, reworks)"
```

---

## Task 7: Queue action functions (TDD)

**Files:**
- Create: `E:\Claude\makelila\app\src\lib\fulfillment.test.ts`
- Modify: `E:\Claude\makelila\app\src\lib\fulfillment.ts` (append functions)

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/fulfillment.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMock, eqMock, fromMock, getUserMock, logActionMock } = vi.hoisted(() => {
  const updateMock = vi.fn();
  const eqMock = vi.fn();
  const fromMock = vi.fn(() => ({ update: updateMock }));
  const getUserMock = vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
  );
  const logActionMock = vi.fn(() => Promise.resolve());
  return { updateMock, eqMock, fromMock, getUserMock, logActionMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: getUserMock },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import { confirmTestReport, toggleDockCheck, setStarterTracking } from './fulfillment';

describe('confirmTestReport', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
  });

  it('updates test_report_url + advances step 2→3 + logs fq_test_ok', async () => {
    await confirmTestReport('queue-1', 'https://drive.example/report.pdf');
    expect(fromMock).toHaveBeenCalledWith('fulfillment_queue');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      step: 3,
      test_report_url: 'https://drive.example/report.pdf',
      test_confirmed_by: 'user-1',
    }));
    expect(eqMock).toHaveBeenCalledWith('id', 'queue-1');
    expect(logActionMock).toHaveBeenCalledWith('fq_test_ok', 'queue-1', expect.any(String));
  });

  it('treats empty URL as null', async () => {
    await confirmTestReport('queue-1');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      test_report_url: null,
      step: 3,
    }));
  });

  it('throws if unauthenticated', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    await expect(confirmTestReport('queue-1')).rejects.toThrow(/not authenticated/i);
  });
});

describe('toggleDockCheck', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
  });

  it('flips the named boolean', async () => {
    await toggleDockCheck('queue-1', 'printed', true);
    expect(updateMock).toHaveBeenCalledWith({ dock_printed: true });
    expect(eqMock).toHaveBeenCalledWith('id', 'queue-1');
  });
});

describe('setStarterTracking', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
  });

  it('updates starter_tracking_num on the queue row', async () => {
    await setStarterTracking('queue-1', '1ZA99 starter');
    expect(updateMock).toHaveBeenCalledWith({ starter_tracking_num: '1ZA99 starter' });
    expect(eqMock).toHaveBeenCalledWith('id', 'queue-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run test:run -- fulfillment
```

Expected: FAIL — `confirmTestReport` / `toggleDockCheck` / `setStarterTracking` not exported.

- [ ] **Step 3: Append action functions to `fulfillment.ts`**

Append to `app/src/lib/fulfillment.ts`:

```ts
import { logAction } from './activityLog';

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('fulfillment: not authenticated');
  return data.user.id;
}

/** Step 1: reserve the serial for this queue row; advance 1→2. */
export async function assignUnit(queueId: string, serial: string): Promise<void> {
  const userId = await currentUserId();
  // Reserve shelf slot
  const { error: slotErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'reserved', updated_at: new Date().toISOString() })
    .eq('serial', serial);
  if (slotErr) throw slotErr;
  // Advance queue row
  const { error: qErr } = await supabase
    .from('fulfillment_queue')
    .update({ assigned_serial: serial, step: 2 })
    .eq('id', queueId);
  if (qErr) throw qErr;
  await logAction('fq_assign', queueId, `Assigned ${serial}`);
  void userId;
}

/** Step 2 pass: advance 2→3 with optional test report URL. */
export async function confirmTestReport(queueId: string, testReportUrl?: string): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({
      step: 3,
      test_report_url: testReportUrl?.trim() || null,
      test_confirmed_at: new Date().toISOString(),
      test_confirmed_by: userId,
    })
    .eq('id', queueId);
  if (error) throw error;
  await logAction('fq_test_ok', queueId, 'Test verified');
}

/** Step 2 fail: flag rework → drops order back to step 1; flips slot to 'rework'. */
export async function flagRework(
  queueId: string,
  serial: string,
  issue: string,
  flaggedByName: string,
): Promise<void> {
  const userId = await currentUserId();
  // Insert rework row
  const { error: rwErr } = await supabase.from('unit_reworks').insert({
    serial,
    issue,
    flagged_by: userId,
    flagged_by_name: flaggedByName,
  });
  if (rwErr) throw rwErr;
  // Flip shelf slot to rework
  const { error: slotErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'rework', updated_at: new Date().toISOString() })
    .eq('serial', serial);
  if (slotErr) throw slotErr;
  // Drop queue row to step 1 + clear assigned serial
  const { error: qErr } = await supabase
    .from('fulfillment_queue')
    .update({ step: 1, assigned_serial: null })
    .eq('id', queueId);
  if (qErr) throw qErr;
  await logAction('fq_test_flagged', queueId, `${serial}: ${issue}`);
}

/** Step 3: upload PDF (optional) + save carrier/tracking; advance 3→4. */
export async function confirmLabel(
  queueId: string,
  input: { carrier: string; tracking_num: string; label_pdf?: File },
): Promise<void> {
  const userId = await currentUserId();
  let label_pdf_path: string | null = null;
  if (input.label_pdf) {
    const path = `${queueId}/label-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from('order-labels')
      .upload(path, input.label_pdf, { contentType: 'application/pdf' });
    if (upErr) throw upErr;
    label_pdf_path = path;
  }
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({
      step: 4,
      carrier: input.carrier,
      tracking_num: input.tracking_num,
      ...(label_pdf_path ? { label_pdf_path } : {}),
      label_confirmed_at: new Date().toISOString(),
      label_confirmed_by: userId,
    })
    .eq('id', queueId);
  if (error) throw error;
  await logAction('fq_label_confirmed', queueId, `${input.carrier} · ${input.tracking_num}`);
}

/** Step 4: toggle one of the 4 dock checklist booleans. */
export async function toggleDockCheck(
  queueId: string,
  field: 'printed' | 'affixed' | 'docked' | 'notified',
  value: boolean,
): Promise<void> {
  const column = ({
    printed: 'dock_printed', affixed: 'dock_affixed',
    docked: 'dock_docked', notified: 'dock_notified',
  } as const)[field];
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ [column]: value })
    .eq('id', queueId);
  if (error) throw error;
}

/** Step 4: all 4 checks confirmed → advance 4→5. */
export async function confirmDock(queueId: string): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({
      step: 5,
      dock_confirmed_at: new Date().toISOString(),
      dock_confirmed_by: userId,
    })
    .eq('id', queueId);
  if (error) throw error;
  await logAction('fq_dock_confirmed', queueId, 'Dock check complete');
}

/** Step 5: US-only starter tracking input. */
export async function setStarterTracking(queueId: string, starter_tracking_num: string): Promise<void> {
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ starter_tracking_num })
    .eq('id', queueId);
  if (error) throw error;
}

/** Step 5: invoke edge function to send the email (advances 5→6). */
export async function sendFulfillmentEmail(queueId: string): Promise<{ email_id: string }> {
  await currentUserId();
  const { data, error } = await supabase.functions.invoke<{ email_id: string }>(
    'send-fulfillment-email',
    { body: { queue_id: queueId } },
  );
  if (error) throw error;
  if (!data) throw new Error('send-fulfillment-email returned no data');
  return data;
}
```

- [ ] **Step 4: Run test to verify passes**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run test:run
```

Expected: previous 25 tests still pass + new `confirmTestReport` (3) + `toggleDockCheck` (1) + `setStarterTracking` (1) = 30 total.

- [ ] **Step 5: Commit**

```bash
cd /e/Claude/makelila
git add app/src/lib/fulfillment.ts app/src/lib/fulfillment.test.ts
git commit -m "feat(app): fulfillment queue action fns (assign/confirm/flag/label/dock/email)"
```

---

## Task 8: Shelf + rework action functions (TDD)

**Files:**
- Modify: `E:\Claude\makelila\app\src\lib\fulfillment.test.ts`
- Modify: `E:\Claude\makelila\app\src\lib\fulfillment.ts`

- [ ] **Step 1: Append test cases**

Append to `app/src/lib/fulfillment.test.ts`:

```ts
import { swapSlots, confirmShelfLayout, resolveRework } from './fulfillment';

describe('resolveRework', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
  });

  it('writes resolved_at + flips slot to available + logs rework_resolved', async () => {
    await resolveRework(42, 'LL01-00000000050', 'Replaced pad', 'Junaid');
    // First update: unit_reworks
    // Second update: shelf_slots
    // (both via same update/eq mock chain — we just check at least one call matches each shape)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      resolution_notes: 'Replaced pad',
      resolved_by: 'user-1',
      resolved_by_name: 'Junaid',
    }));
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'available',
    }));
    expect(logActionMock).toHaveBeenCalledWith('rework_resolved', 'LL01-00000000050', 'Replaced pad');
  });
});

describe('confirmShelfLayout', () => {
  beforeEach(() => {
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
  });

  it('logs shelf_layout_saved without touching shelf_slots', async () => {
    await confirmShelfLayout();
    expect(logActionMock).toHaveBeenCalledWith('shelf_layout_saved', 'Shelf', expect.any(String));
  });
});
```

- [ ] **Step 2: Run test to verify fails**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run test:run -- fulfillment
```

Expected: FAIL — `swapSlots` / `confirmShelfLayout` / `resolveRework` not exported.

- [ ] **Step 3: Append functions to `fulfillment.ts`**

```ts
/** Swap two shelf slots atomically (serial/batch/status). */
export async function swapSlots(
  a: { skid: string; slot_index: number },
  b: { skid: string; slot_index: number },
): Promise<void> {
  await currentUserId();
  // Fetch both rows
  const { data, error } = await supabase
    .from('shelf_slots')
    .select('*')
    .or(`and(skid.eq.${a.skid},slot_index.eq.${a.slot_index}),and(skid.eq.${b.skid},slot_index.eq.${b.slot_index})`);
  if (error) throw error;
  if (!data || data.length !== 2) throw new Error(`swapSlots: expected 2 rows, got ${data?.length ?? 0}`);

  const rowA = data.find(r => r.skid === a.skid && r.slot_index === a.slot_index)!;
  const rowB = data.find(r => r.skid === b.skid && r.slot_index === b.slot_index)!;

  const now = new Date().toISOString();
  const { error: errA } = await supabase
    .from('shelf_slots')
    .update({ serial: rowB.serial, batch: rowB.batch, status: rowB.status, updated_at: now })
    .eq('skid', a.skid).eq('slot_index', a.slot_index);
  if (errA) throw errA;
  const { error: errB } = await supabase
    .from('shelf_slots')
    .update({ serial: rowA.serial, batch: rowA.batch, status: rowA.status, updated_at: now })
    .eq('skid', b.skid).eq('slot_index', b.slot_index);
  if (errB) throw errB;
}

/** UX checkpoint: logs that the current shelf layout was reviewed. */
export async function confirmShelfLayout(): Promise<void> {
  await currentUserId();
  await logAction('shelf_layout_saved', 'Shelf', 'Layout reviewed');
}

/** Resolve an open rework → flip the slot back to available. */
export async function resolveRework(
  reworkId: number,
  serial: string,
  notes: string | undefined,
  resolvedByName: string,
): Promise<void> {
  const userId = await currentUserId();
  const { error: rwErr } = await supabase
    .from('unit_reworks')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
      resolved_by_name: resolvedByName,
      resolution_notes: notes?.trim() || null,
    })
    .eq('id', reworkId);
  if (rwErr) throw rwErr;
  const { error: slotErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'available', updated_at: new Date().toISOString() })
    .eq('serial', serial);
  if (slotErr) throw slotErr;
  await logAction('rework_resolved', serial, notes ?? 'Resolved');
}
```

- [ ] **Step 4: Run test to verify passes**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run test:run
```

Expected: 32 tests pass (30 + 2 new).

- [ ] **Step 5: Commit**

```bash
cd /e/Claude/makelila
git add app/src/lib/fulfillment.ts app/src/lib/fulfillment.test.ts
git commit -m "feat(app): fulfillment shelf + rework action fns (swap/confirmLayout/resolve)"
```

---

## Task 9: `send-fulfillment-email` edge function

**Files:**
- Create: `E:\Claude\makelila\supabase\functions\send-fulfillment-email\index.ts`
- Modify: `E:\Claude\makelila\supabase\config.toml` (add `[functions.send-fulfillment-email]`)

- [ ] **Step 1: Write the edge function**

```ts
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type QueueRow = {
  id: string;
  order_id: string;
  step: number;
  assigned_serial: string | null;
  carrier: string | null;
  tracking_num: string | null;
  starter_tracking_num: string | null;
  email_sent_at: string | null;
};

type OrderRow = {
  order_ref: string;
  customer_name: string;
  customer_email: string | null;
  country: 'US' | 'CA';
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!supabaseUrl || !serviceKey || !resendKey) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const body = await req.json() as { queue_id?: string };
  if (!body.queue_id) {
    return new Response(JSON.stringify({ error: 'queue_id required' }), {
      status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Fetch queue row + joined order
  const { data: q, error: qErr } = await admin
    .from('fulfillment_queue')
    .select('*')
    .eq('id', body.queue_id)
    .single<QueueRow>();
  if (qErr || !q) {
    return new Response(JSON.stringify({ error: 'queue row not found' }), {
      status: 404, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
  if (q.email_sent_at) {
    return new Response(JSON.stringify({ error: 'email already sent' }), {
      status: 409, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
  if (q.step !== 5) {
    return new Response(JSON.stringify({ error: `queue row at step ${q.step}, must be 5` }), {
      status: 409, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  const { data: order, error: oErr } = await admin
    .from('orders')
    .select('order_ref, customer_name, customer_email, country')
    .eq('id', q.order_id)
    .single<OrderRow>();
  if (oErr || !order || !order.customer_email) {
    return new Response(JSON.stringify({ error: 'order missing or has no customer_email' }), {
      status: 404, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  if (order.country === 'US' && !q.starter_tracking_num) {
    return new Response(JSON.stringify({ error: 'US orders require starter_tracking_num' }), {
      status: 409, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  const firstName = order.customer_name.split(' ')[0] ?? order.customer_name;
  const starterLine = order.country === 'US'
    ? `\nStarter kit · ${q.carrier}: ${q.starter_tracking_num}`
    : '';
  const text =
    `Hi ${firstName},\n\n` +
    `Your LILA Pro is on the way. Here are your tracking details:\n\n` +
    `LILA Pro · ${q.carrier}: ${q.tracking_num}` + starterLine + `\n\n` +
    `Expected delivery in 3–7 business days.\n\n` +
    `Questions? Just reply to this email.\n\n` +
    `Thanks for your order —\n` +
    `Team Lila\n` +
    `support@lilacomposter.com`;

  // Send via Resend
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Team Lila <support@lilacomposter.com>',
      reply_to: 'support@lilacomposter.com',
      to: [order.customer_email],
      subject: `Your LILA Pro has shipped! (${order.order_ref})`,
      text,
    }),
  });
  if (!resendRes.ok) {
    const bodyText = await resendRes.text();
    return new Response(
      JSON.stringify({ error: `Resend ${resendRes.status}: ${bodyText.slice(0, 400)}` }),
      { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
  const sent = await resendRes.json() as { id: string };

  // Update queue row → step 6 + fulfilled
  const now = new Date().toISOString();
  // user_id from the JWT is available via req.headers; simplest: parse sub claim.
  const authz = req.headers.get('authorization') ?? '';
  const jwt = authz.replace(/^Bearer\s+/i, '');
  let userId: string | null = null;
  try {
    const [, payload] = jwt.split('.');
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    userId = decoded.sub ?? null;
  } catch { /* leave null */ }

  const { error: upErr } = await admin
    .from('fulfillment_queue')
    .update({
      step: 6,
      email_sent_at: now,
      email_sent_by: userId,
      fulfilled_at: now,
      fulfilled_by: userId,
    })
    .eq('id', body.queue_id);
  if (upErr) {
    return new Response(JSON.stringify({ error: `db update failed: ${upErr.message}` }), {
      status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  // Release the shelf slot back to empty (unit shipped)
  if (q.assigned_serial) {
    await admin.from('shelf_slots')
      .update({ serial: null, batch: null, status: 'empty', updated_at: now })
      .eq('serial', q.assigned_serial);
  }

  return new Response(
    JSON.stringify({ email_id: sent.id }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
});
```

- [ ] **Step 2: Build check**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build
```

Expected: clean. Deno code under `supabase/functions/` is outside app's tsconfig include.

- [ ] **Step 3: Commit**

```bash
cd /e/Claude/makelila
git add supabase/functions/send-fulfillment-email/
git commit -m "feat(edge): send-fulfillment-email via Resend API + queue→step 6"
```

---

## Task 10: Resend setup doc

**Files:**
- Create: `E:\Claude\makelila\docs\fulfillment-email-setup.md`

- [ ] **Step 1: Write the doc**

```markdown
# Fulfillment Email Setup (Resend)

The "Send email" button in Fulfillment Step 5 invokes a Supabase Edge Function
(`send-fulfillment-email`) that posts to Resend's API using a verified domain.
Sender: `Team Lila <support@lilacomposter.com>`. Reply-To: same.

## 1. Create the Resend account + API key

1. Sign up at https://resend.com (free tier: 3000 emails/month).
2. Go to **Domains → Add domain → lilacomposter.com**.
3. Resend shows 3 DNS records:
   - SPF (TXT)
   - DKIM (CNAME × 2)
4. Add them to GoDaddy DNS for `lilacomposter.com`:
   - GoDaddy admin → Domains → lilacomposter.com → DNS → Add record
   - Copy each record exactly; Resend's UI has a copy button next to each value
5. Wait for propagation (usually <5 min, sometimes up to 1 hour). Click **Verify**.
6. Go to **API Keys → Create API key**. Name it `make-lila`. Copy the `re_...` value (shown once).

## 2. Set Supabase secret + deploy the function

```powershell
cd E:\Claude\makelila
$env:SUPABASE_ACCESS_TOKEN = "<your sbp_ token>"
.\app\node_modules\.bin\supabase.cmd secrets set RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
.\app\node_modules\.bin\supabase.cmd functions deploy send-fulfillment-email --project-ref txeftbbzeflequvrmjjr
```

Expect `Deployed Functions on project ...: send-fulfillment-email`.

## 3. Test

Walk an order through Steps 1–4 locally (or on lila.vip), then click **Send
email** in Step 5. The test customer email (use your own `@virgohome.io`
address as the customer on a seeded order) should arrive within ~1 min.

## Troubleshooting

- **Resend 401**: API key wrong. Re-create and `supabase secrets set` again.
- **Resend 403 / "Domain not verified"**: DNS records haven't propagated or
  weren't added correctly. Re-check in Resend → Domains.
- **Resend 422 / "from address not allowed"**: using a sender that isn't on
  the verified domain. Must be `*@lilacomposter.com`.
- **Edge function 409 "email already sent"**: the queue row's `email_sent_at`
  is populated. Not retriable; the order is already in Step 6.
- **Edge function 409 "US orders require starter_tracking_num"**: Step 5's
  starter-kit field wasn't filled before clicking Send.

## Rotating the API key

Rotate in Resend → API Keys → Revoke + Create new. Then:
```powershell
.\app\node_modules\.bin\supabase.cmd secrets set RESEND_API_KEY=re_<new>
.\app\node_modules\.bin\supabase.cmd functions deploy send-fulfillment-email --project-ref txeftbbzeflequvrmjjr
```
```

- [ ] **Step 2: Commit**

```bash
cd /e/Claude/makelila
git add docs/fulfillment-email-setup.md
git commit -m "docs(infra): Resend setup runbook for send-fulfillment-email"
```

---

## Task 11: Fulfillment module shell + router update

**Files:**
- Delete: `E:\Claude\makelila\app\src\modules\Fulfillment.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\index.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\Fulfillment.module.css`
- Modify: `E:\Claude\makelila\app\src\App.tsx`

- [ ] **Step 1: Write stub CSS**

Create `app/src/modules/Fulfillment/Fulfillment.module.css`:

```css
.layout {
  background: #fff;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  overflow: hidden;
}

.tabs {
  display: flex;
  border-bottom: 2px solid var(--color-crimson);
}
.tab {
  padding: 9px 20px;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-crimson);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-bottom: none;
  cursor: pointer;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  margin-right: 3px;
}
.tab.active {
  background: var(--color-crimson);
  color: #fff;
}

.tabPanel {
  padding: 16px;
  min-height: calc(100vh - 200px);
}
```

- [ ] **Step 2: Write `Fulfillment/index.tsx`**

```tsx
import { useNavigate, useParams } from 'react-router-dom';
import styles from './Fulfillment.module.css';

type Tab = 'queue' | 'shelf';

export default function Fulfillment() {
  const { tab } = useParams<{ tab?: Tab }>();
  const navigate = useNavigate();
  const active: Tab = tab === 'shelf' ? 'shelf' : 'queue';

  return (
    <div className={styles.layout}>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${active === 'queue' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/queue')}
        >Fulfillment Queue</button>
        <button
          className={`${styles.tab} ${active === 'shelf' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/shelf')}
        >Inventory Shelf</button>
      </div>
      <div className={styles.tabPanel}>
        {active === 'queue' ? (
          <div>Queue sub-tab — filled in by Task 12</div>
        ) : (
          <div>Shelf sub-tab — filled in by Task 19</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Delete old placeholder**

```bash
cd /e/Claude/makelila
rm app/src/modules/Fulfillment.tsx
```

- [ ] **Step 4: Update router**

In `app/src/App.tsx`, replace:

```tsx
<Route path="fulfillment"   element={<Fulfillment />} />
```

with:

```tsx
<Route path="fulfillment"       element={<Fulfillment />} />
<Route path="fulfillment/:tab"  element={<Fulfillment />} />
```

- [ ] **Step 5: Verify build + test**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

Expected: build clean; 32 tests still pass.

- [ ] **Step 6: Commit**

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/ app/src/App.tsx
git rm app/src/modules/Fulfillment.tsx
git commit -m "feat(app): Fulfillment module shell with Queue + Shelf tabs"
```

---

## Task 12: Queue sub-tab — QueueSidebar + QueueHeader + index

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\index.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\QueueSidebar.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\QueueHeader.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\Fulfillment.module.css` (append)
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\index.tsx` (wire in queue)

- [ ] **Step 1: Append queue/sidebar styles**

```css
.queueLayout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 0;
  height: calc(100vh - 220px);
  min-height: 500px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: #fff;
}

.sidebar {
  background: var(--color-dark-1);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.sidebarHeader {
  padding: 12px 14px;
  font-size: 9px;
  font-weight: 700;
  color: #aaa;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--color-dark-3);
}

.queueRow {
  padding: 10px 14px;
  border-bottom: 1px solid #252525;
  cursor: pointer;
  transition: background 0.1s;
}
.queueRow:hover { background: #232323; }
.queueRow.selected {
  background: #2a1010;
  border-left: 3px solid var(--color-crimson);
  padding-left: 11px;
}
.queueRow.overdue { border-left: 3px solid var(--color-error-strong); padding-left: 11px; }
.queueRow.fulfilled { opacity: 0.65; }

.rowName { font-size: 11px; font-weight: 600; color: #e8e8e8; }
.rowMeta { font-size: 10px; color: #888; margin-top: 2px; }
.rowDue  { font-size: 9px; font-weight: 700; margin-top: 3px; }
.rowDue.today { color: #fc8181; }
.rowDue.soon  { color: #fbd38d; }
.rowDue.ok    { color: #68d391; }
.rowDue.done  { color: #48bb78; }

.stepBadge {
  display: inline-block;
  font-size: 9px;
  background: #2d2d2d;
  color: #ccc;
  padding: 2px 6px;
  border-radius: 3px;
  font-weight: 700;
  margin-left: 6px;
}

.emptyList { padding: 20px 14px; color: var(--color-ink-faint); font-size: 11px; text-align: center; }

.detail {
  padding: 16px 18px;
  overflow-y: auto;
}

.header {
  padding-bottom: 10px;
  border-bottom: 2px solid var(--color-crimson);
  margin-bottom: 14px;
}
.headerTitle {
  font-size: 14px;
  font-weight: 800;
  color: var(--color-crimson);
}
.headerMeta {
  font-size: 11px;
  color: var(--color-ink-subtle);
  margin-top: 3px;
}

.progressBar {
  display: flex;
  gap: 4px;
  margin-top: 10px;
}
.progressStep {
  flex: 1;
  height: 4px;
  background: var(--color-border);
  border-radius: 2px;
}
.progressStep.done { background: var(--color-success); }
.progressStep.current { background: var(--color-crimson); }
```

- [ ] **Step 2: Write `QueueSidebar.tsx`**

```tsx
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

function dueClass(dueDate: string | null, fulfilled: boolean): string {
  if (fulfilled) return `${styles.rowDue} ${styles.done}`;
  if (!dueDate) return styles.rowDue;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate); due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return `${styles.rowDue} ${styles.today}`;
  if (days === 0) return `${styles.rowDue} ${styles.today}`;
  if (days <= 2) return `${styles.rowDue} ${styles.soon}`;
  return `${styles.rowDue} ${styles.ok}`;
}

function dueLabel(dueDate: string | null, fulfilled: boolean): string {
  if (fulfilled) return '✓ Fulfilled';
  if (!dueDate) return '—';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate); due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return `⏰ OVERDUE by ${Math.abs(days)}d`;
  if (days === 0) return '⏰ Due TODAY';
  return `⏰ Due in ${days}d`;
}

export function QueueSidebar({
  rows,
  orderLookup,
  selectedId,
  onSelect,
}: {
  rows: FulfillmentQueueRow[];
  orderLookup: Map<string, { order_ref: string; customer_name: string; city: string; country: 'US'|'CA' }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>READY TO SHIP ({rows.length})</div>
      {rows.length === 0 ? (
        <div className={styles.emptyList}>No queued orders.</div>
      ) : rows.map(r => {
        const o = orderLookup.get(r.order_id);
        const fulfilled = r.step === 6;
        const overdue = !fulfilled && r.due_date && new Date(r.due_date) < new Date(new Date().setHours(0,0,0,0));
        const cls = [
          styles.queueRow,
          r.id === selectedId ? styles.selected : '',
          overdue ? styles.overdue : '',
          fulfilled ? styles.fulfilled : '',
        ].filter(Boolean).join(' ');
        return (
          <div key={r.id} className={cls} onClick={() => onSelect(r.id)} role="button" tabIndex={0}>
            <div className={styles.rowName}>
              {o?.customer_name ?? r.order_id}
              <span className={styles.stepBadge}>{r.step}/6</span>
            </div>
            <div className={styles.rowMeta}>
              {o?.order_ref ?? '—'} · {o?.city ?? ''} · {o?.country ?? ''}
            </div>
            <div className={dueClass(r.due_date, fulfilled)}>
              {dueLabel(r.due_date, fulfilled)}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
```

- [ ] **Step 3: Write `QueueHeader.tsx`**

```tsx
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

export function QueueHeader({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { order_ref: string; customer_name: string; city: string; region_state: string | null; country: 'US'|'CA' };
}) {
  const STEP_LABELS = ['', 'Assign', 'Test', 'Label', 'Dock', 'Email', 'Fulfilled'];
  return (
    <div className={styles.header}>
      <div className={styles.headerTitle}>
        {order.customer_name} — LILA Pro
      </div>
      <div className={styles.headerMeta}>
        {order.order_ref} · {order.city}{order.region_state ? `, ${order.region_state}` : ''} · {order.country}
        {row.due_date && <> · Due {new Date(row.due_date).toLocaleDateString()}</>}
      </div>
      <div className={styles.progressBar} aria-label={`Step ${row.step} of 6 — ${STEP_LABELS[row.step]}`}>
        {[1,2,3,4,5,6].map(s => (
          <div
            key={s}
            className={[
              styles.progressStep,
              s < row.step ? styles.done : '',
              s === row.step ? styles.current : '',
            ].filter(Boolean).join(' ')}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `queue/index.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useFulfillmentQueue, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { QueueSidebar } from './QueueSidebar';
import { QueueHeader } from './QueueHeader';
import styles from '../Fulfillment.module.css';

type Order = {
  id: string;
  order_ref: string;
  customer_name: string;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
};

export default function Queue() {
  const { ready, fulfilled, loading } = useFulfillmentQueue();
  const rows = useMemo(() => [...ready, ...fulfilled], [ready, fulfilled]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  // Fetch orders referenced by the queue rows (one-shot; orders rarely change once approved)
  useEffect(() => {
    if (rows.length === 0) return;
    const ids = Array.from(new Set(rows.map(r => r.order_id)));
    void supabase
      .from('orders')
      .select('id, order_ref, customer_name, city, region_state, country')
      .in('id', ids)
      .then(({ data }) => setOrders((data as Order[]) ?? []));
  }, [rows]);

  const orderLookup = useMemo(() => {
    const m = new Map<string, Order>();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);

  // Default-select first row on load
  useEffect(() => {
    if (!selectedId && ready.length > 0) setSelectedId(ready[0].id);
  }, [ready, selectedId]);

  const selected = rows.find(r => r.id === selectedId) ?? null;
  const selectedOrder = selected ? orderLookup.get(selected.order_id) : null;

  return (
    <div className={styles.queueLayout}>
      <QueueSidebar
        rows={rows}
        orderLookup={orderLookup}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <section className={styles.detail}>
        {loading ? (
          <div>Loading…</div>
        ) : !selected || !selectedOrder ? (
          <div>Select a queued order from the left.</div>
        ) : (
          <>
            <QueueHeader row={selected} order={selectedOrder} />
            <div>Step {selected.step} — UI coming in Tasks 13–18</div>
          </>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Wire queue into module shell**

In `Fulfillment/index.tsx`, replace the `<div>Queue sub-tab — filled in by Task 12</div>` with `<Queue />` and add the import:

```tsx
import Queue from './queue';
```

- [ ] **Step 6: Verify build + tests**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

Expected: build clean; 32 tests pass.

- [ ] **Step 7: Commit**

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Fulfillment Queue shell — sidebar + header + step placeholder"
```

---

## Task 13: Step 1 — Assign Unit

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\StepAssign.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\Fulfillment.module.css` (append)
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\index.tsx` (wire in step switch)

- [ ] **Step 1: Append styles**

```css
.slotGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
  max-height: 420px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.slotPick {
  padding: 8px 10px;
  border: 1.5px solid var(--color-border);
  background: var(--color-success-bg);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 10px;
  text-align: center;
}
.slotPick:hover { border-color: var(--color-crimson); }
.slotPick.selected { border-color: var(--color-crimson); background: #fff5f5; }
.slotPick.suggested { outline: 2px dashed var(--color-warning-strong); }
.slotPickTop { font-family: ui-monospace, monospace; color: var(--color-ink); font-weight: 600; }
.slotPickBottom { font-size: 9px; color: var(--color-ink-subtle); margin-top: 2px; }
.slotPickBatch { display: inline-block; background: var(--color-info-bg); color: var(--color-info); font-size: 8px; padding: 1px 5px; border-radius: 3px; margin-left: 4px; }

.stepBar { margin-top: 14px; display: flex; gap: 8px; align-items: center; }
.confirmBtn {
  background: var(--color-success);
  color: #fff;
  border: none;
  padding: 9px 20px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.confirmBtn:disabled { background: var(--color-border); color: var(--color-ink-faint); cursor: not-allowed; }
```

- [ ] **Step 2: Compute auto-suggestion (front-row-first) + write `StepAssign.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { useShelf, assignUnit, type FulfillmentQueueRow, type ShelfSlot } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

function autoSuggestSerial(slots: ShelfSlot[]): string | null {
  // Prefer slot_index 3 or 4 (front row) first; then 0,1,2 (back row). Skid order A1→A30.
  const sorted = [...slots].sort((a, b) => {
    const aFront = a.slot_index >= 3 ? 0 : 1;
    const bFront = b.slot_index >= 3 ? 0 : 1;
    if (aFront !== bFront) return aFront - bFront;
    // Skid 'A7' → 7; 'A30' → 30
    const aNum = parseInt(a.skid.replace(/^[A-Z]+/, ''), 10);
    const bNum = parseInt(b.skid.replace(/^[A-Z]+/, ''), 10);
    if (aNum !== bNum) return aNum - bNum;
    return a.slot_index - b.slot_index;
  });
  return sorted.find(s => s.status === 'available' && s.serial)?.serial ?? null;
}

export function StepAssign({ row }: { row: FulfillmentQueueRow }) {
  const { slots, loading } = useShelf();
  const available = useMemo(() => slots.filter(s => s.status === 'available' && s.serial), [slots]);
  const suggested = useMemo(() => autoSuggestSerial(slots), [slots]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effective = picked ?? suggested;

  const handleConfirm = async () => {
    if (!effective) return;
    setBusy(true); setError(null);
    try {
      await assignUnit(row.id, effective);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div>Loading shelf…</div>;
  if (available.length === 0) return <div>No available units on the shelf. Flag a rework as resolved first.</div>;

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Assign a tested unit from the shelf</h3>
      <p style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginBottom: 10 }}>
        Auto-suggested next: <strong>{suggested ?? '—'}</strong>. Click any available slot to override.
      </p>
      <div className={styles.slotGrid}>
        {available.map(s => (
          <div
            key={`${s.skid}-${s.slot_index}`}
            className={[
              styles.slotPick,
              effective === s.serial ? styles.selected : '',
              s.serial === suggested ? styles.suggested : '',
            ].filter(Boolean).join(' ')}
            onClick={() => setPicked(s.serial!)}
          >
            <div className={styles.slotPickTop}>
              {s.serial?.slice(-5)}
              <span className={styles.slotPickBatch}>{s.batch}</span>
            </div>
            <div className={styles.slotPickBottom}>
              {s.skid} · slot {s.slot_index}
            </div>
          </div>
        ))}
      </div>
      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={handleConfirm} disabled={!effective || busy}>
          {busy ? 'Assigning…' : `✓ Confirm ${effective ?? ''}`}
        </button>
        {error && <span style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire step switch in `queue/index.tsx`**

Replace the `<div>Step {selected.step} — UI coming in Tasks 13–18</div>` with:

```tsx
{selected.step === 1 && <StepAssign row={selected} />}
{selected.step >= 2 && <div>Step {selected.step} — UI coming in Tasks 14–18</div>}
```

Add at top:
```tsx
import { StepAssign } from './StepAssign';
```

- [ ] **Step 4: Verify + commit**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

Expected: build clean, 32 tests.

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Fulfillment Step 1 — Assign Unit (with auto-suggest highlight)"
```

---

## Task 14: Step 2 — Test Report + flag rework

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\StepTest.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\index.tsx`

- [ ] **Step 1: Write `StepTest.tsx`**

```tsx
import { useState } from 'react';
import { confirmTestReport, flagRework, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { useAuth } from '../../../lib/auth';
import styles from '../Fulfillment.module.css';

export function StepTest({ row }: { row: FulfillmentQueueRow }) {
  const { profile, user } = useAuth();
  const name = profile?.display_name ?? user?.email ?? 'Unknown';
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'idle' | 'flagging'>('idle');
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePass = async () => {
    setBusy(true); setError(null);
    try { await confirmTestReport(row.id, url); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const handleFlag = async () => {
    if (!issue.trim() || !row.assigned_serial) return;
    setBusy(true); setError(null);
    try {
      await flagRework(row.id, row.assigned_serial, issue.trim(), name);
      setMode('idle'); setIssue('');
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        Verify the test report for unit <code>{row.assigned_serial}</code>
      </h3>
      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginBottom: 4 }}>
        Test report URL (optional):
      </label>
      <input
        type="url"
        placeholder="https://drive.google.com/..."
        value={url}
        onChange={e => setUrl(e.target.value)}
        style={{
          width: '100%', maxWidth: 500, padding: '6px 10px',
          border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 11,
        }}
      />
      {mode === 'idle' ? (
        <div className={styles.stepBar}>
          <button className={styles.confirmBtn} onClick={handlePass} disabled={busy}>
            {busy ? 'Saving…' : '✓ Test passed — proceed'}
          </button>
          <button
            onClick={() => setMode('flagging')}
            disabled={busy}
            style={{
              background: '#fff', color: 'var(--color-error-strong)',
              border: '1.5px solid var(--color-error-strong)',
              padding: '9px 18px', borderRadius: 4, fontSize: 12, fontWeight: 700,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >⚑ Flag to Aaron/Junaid</button>
        </div>
      ) : (
        <div className={styles.stepBar} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <textarea
            placeholder="What's wrong? (required)"
            value={issue}
            onChange={e => setIssue(e.target.value)}
            rows={2}
            style={{
              width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)',
              borderRadius: 4, fontSize: 11, fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleFlag}
              disabled={busy || !issue.trim()}
              style={{
                background: 'var(--color-error-strong)', color: '#fff', border: 'none',
                padding: '8px 16px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                cursor: (!busy && issue.trim()) ? 'pointer' : 'not-allowed',
              }}
            >{busy ? 'Flagging…' : '⚑ Flag rework'}</button>
            <button
              onClick={() => { setMode('idle'); setIssue(''); }}
              disabled={busy}
              style={{
                background: '#fff', color: 'var(--color-ink-subtle)',
                border: '1px solid var(--color-border)', padding: '8px 16px',
                borderRadius: 4, fontSize: 11,
              }}
            >Cancel</button>
          </div>
        </div>
      )}
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Wire in queue/index.tsx**

Add import:
```tsx
import { StepTest } from './StepTest';
```

Replace the step-2-or-more fallback with:
```tsx
{selected.step === 2 && <StepTest row={selected} />}
{selected.step >= 3 && <div>Step {selected.step} — UI coming in Tasks 15–18</div>}
```

- [ ] **Step 3: Verify + commit**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Fulfillment Step 2 — Test Report verify + flag rework"
```

---

## Task 15: Step 3 — Ship Label (with PDF upload)

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\StepLabel.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\index.tsx`

- [ ] **Step 1: Write `StepLabel.tsx`**

```tsx
import { useState } from 'react';
import { confirmLabel, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

const CARRIERS = ['UPS', 'FedEx', 'Purolator', 'Canada Post'] as const;

export function StepLabel({ row }: { row: FulfillmentQueueRow }) {
  const [carrier, setCarrier] = useState<string>('');
  const [tracking, setTracking] = useState<string>('');
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = carrier && tracking.trim();

  const handleConfirm = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      await confirmLabel(row.id, {
        carrier,
        tracking_num: tracking.trim(),
        ...(pdf ? { label_pdf: pdf } : {}),
      });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Attach the shipping label details</h3>

      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 8 }}>
        Carrier:
      </label>
      <select
        value={carrier}
        onChange={e => setCarrier(e.target.value)}
        style={{ padding: '6px 10px', fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 4 }}
      >
        <option value="">— select —</option>
        {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 10 }}>
        Tracking number:
      </label>
      <input
        type="text"
        value={tracking}
        onChange={e => setTracking(e.target.value)}
        placeholder="1Z… / paste from the label"
        style={{
          width: '100%', maxWidth: 340, padding: '6px 10px', fontSize: 11,
          border: '1px solid var(--color-border)', borderRadius: 4, fontFamily: 'ui-monospace, monospace',
        }}
      />

      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 10 }}>
        Label PDF (optional):
      </label>
      {pdf ? (
        <div style={{ fontSize: 11, color: 'var(--color-ink)', marginTop: 3 }}>
          {pdf.name} · {(pdf.size / 1024).toFixed(0)} KB
          <button
            onClick={() => setPdf(null)}
            style={{
              marginLeft: 8, background: 'transparent', border: '1px solid var(--color-border)',
              color: 'var(--color-ink-subtle)', padding: '2px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
            }}
          >Remove</button>
        </div>
      ) : (
        <input
          type="file"
          accept="application/pdf"
          onChange={e => setPdf(e.target.files?.[0] ?? null)}
          style={{ fontSize: 11 }}
        />
      )}

      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={handleConfirm} disabled={!ready || busy}>
          {busy ? 'Saving…' : '✓ Confirm label'}
        </button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Wire in queue/index.tsx**

```tsx
import { StepLabel } from './StepLabel';
```

Replace fallback:
```tsx
{selected.step === 3 && <StepLabel row={selected} />}
{selected.step >= 4 && <div>Step {selected.step} — UI coming in Tasks 16–18</div>}
```

- [ ] **Step 3: Verify + commit**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Fulfillment Step 3 — Ship Label (carrier + tracking + PDF upload)"
```

---

## Task 16: Step 4 — Dock Check

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\StepDock.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\index.tsx`

- [ ] **Step 1: Write `StepDock.tsx`**

```tsx
import { useState } from 'react';
import { toggleDockCheck, confirmDock, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

const ITEMS = [
  { key: 'printed' as const,  col: 'dock_printed' as const,  label: 'Label printed' },
  { key: 'affixed' as const,  col: 'dock_affixed' as const,  label: 'Label affixed to box' },
  { key: 'docked' as const,   col: 'dock_docked' as const,   label: 'Box on outbound dock' },
  { key: 'notified' as const, col: 'dock_notified' as const, label: 'Carrier notified for pickup' },
];

export function StepDock({ row }: { row: FulfillmentQueueRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allDone = ITEMS.every(i => row[i.col]);

  const toggle = async (item: typeof ITEMS[number]) => {
    const next = !row[item.col];
    try { await toggleDockCheck(row.id, item.key, next); }
    catch (e) { setError((e as Error).message); }
  };

  const confirm = async () => {
    if (!allDone) return;
    setBusy(true); setError(null);
    try { await confirmDock(row.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Dock handoff checklist</h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
        {ITEMS.map(i => (
          <li key={i.key} style={{ padding: '6px 0' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
              <input type="checkbox" checked={row[i.col]} onChange={() => toggle(i)} />
              {i.label}
            </label>
          </li>
        ))}
      </ul>
      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={confirm} disabled={!allDone || busy}>
          {busy ? 'Saving…' : '✓ Confirm dock & proceed to Step 5'}
        </button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Wire in queue/index.tsx**

```tsx
import { StepDock } from './StepDock';
```

Replace fallback:
```tsx
{selected.step === 4 && <StepDock row={selected} />}
{selected.step >= 5 && <div>Step {selected.step} — UI coming in Tasks 17–18</div>}
```

- [ ] **Step 3: Verify + commit**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Fulfillment Step 4 — Dock Check 4-item checklist"
```

---

## Task 17: Step 5 — Send Email + starter tracking

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\StepEmail.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\index.tsx`

- [ ] **Step 1: Write `StepEmail.tsx`**

```tsx
import { useState } from 'react';
import {
  setStarterTracking,
  sendFulfillmentEmail,
  type FulfillmentQueueRow,
} from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

export function StepEmail({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { customer_name: string; customer_email: string | null; order_ref: string; country: 'US'|'CA' };
}) {
  const [starter, setStarter] = useState(row.starter_tracking_num ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usOrder = order.country === 'US';
  const starterReady = !usOrder || starter.trim().length > 0;
  const canSend = starterReady && order.customer_email;

  const firstName = order.customer_name.split(' ')[0];
  const starterLine = usOrder ? `\nStarter kit · ${row.carrier}: ${starter || '<tbd>'}` : '';
  const preview =
    `Subject: Your LILA Pro has shipped! (${order.order_ref})\n` +
    `From: Team Lila <support@lilacomposter.com>\n` +
    `To: ${order.customer_email ?? '<no email>'}\n\n` +
    `Hi ${firstName},\n\n` +
    `Your LILA Pro is on the way. Here are your tracking details:\n\n` +
    `LILA Pro · ${row.carrier}: ${row.tracking_num}` + starterLine + `\n\n` +
    `Expected delivery in 3–7 business days.\n\n` +
    `Questions? Just reply to this email.\n\n` +
    `Thanks for your order —\nTeam Lila\nsupport@lilacomposter.com`;

  const handleStarterBlur = async () => {
    if (starter === (row.starter_tracking_num ?? '') || !usOrder) return;
    try { await setStarterTracking(row.id, starter); }
    catch (e) { setError((e as Error).message); }
  };

  const handleSend = async () => {
    if (!canSend) return;
    setBusy(true); setError(null);
    // Make sure starter tracking is persisted before sending
    if (usOrder && starter !== (row.starter_tracking_num ?? '')) {
      try { await setStarterTracking(row.id, starter); }
      catch (e) { setError((e as Error).message); setBusy(false); return; }
    }
    try { await sendFulfillmentEmail(row.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Send the shipment-confirmation email</h3>
      {usOrder && (
        <>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)' }}>
            Starter-kit tracking number (required for US):
          </label>
          <input
            type="text"
            value={starter}
            onChange={e => setStarter(e.target.value)}
            onBlur={handleStarterBlur}
            placeholder="1Z… starter-kit tracking"
            style={{
              width: '100%', maxWidth: 340, padding: '6px 10px', fontSize: 11,
              border: '1px solid var(--color-border)', borderRadius: 4, fontFamily: 'ui-monospace, monospace',
              marginBottom: 10,
            }}
          />
        </>
      )}
      <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginBottom: 4 }}>Preview:</div>
      <pre style={{
        background: 'var(--color-surface)', border: '1px solid var(--color-border)',
        padding: 10, borderRadius: 4, fontSize: 10, lineHeight: 1.5,
        whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto',
      }}>{preview}</pre>
      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={handleSend} disabled={!canSend || busy}>
          {busy ? 'Sending…' : '✉ Send email'}
        </button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Wire in queue/index.tsx**

```tsx
import { StepEmail } from './StepEmail';
```

Replace fallback:
```tsx
{selected.step === 5 && <StepEmail row={selected} order={selectedOrder} />}
{selected.step === 6 && <div>Step 6 fulfilled — UI coming in Task 18</div>}
```

Note: `selectedOrder` has `customer_email` but the current `Order` type in `queue/index.tsx` doesn't include it. Extend the `Order` type and the SELECT:

```tsx
type Order = {
  id: string;
  order_ref: string;
  customer_name: string;
  customer_email: string | null;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
};

// SELECT: ...select('id, order_ref, customer_name, customer_email, city, region_state, country')...
```

- [ ] **Step 3: Verify + commit**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Fulfillment Step 5 — Send Email + starter tracking (US)"
```

---

## Task 18: Step 6 — Fulfilled view

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\StepFulfilled.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\queue\index.tsx`

- [ ] **Step 1: Write `StepFulfilled.tsx`**

```tsx
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

export function StepFulfilled({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { customer_name: string; customer_email: string | null; order_ref: string; country: 'US'|'CA' };
}) {
  const handoffRef = `${row.id.slice(0, 8)}-${Math.floor(Date.now() / 1000).toString(36)}`;
  const fulfilledOn = row.fulfilled_at
    ? new Date(row.fulfilled_at).toLocaleString()
    : '—';
  return (
    <div>
      <div style={{
        background: 'var(--color-success-bg)',
        border: '1.5px solid var(--color-success-border)',
        borderRadius: 6,
        padding: '10px 14px',
        marginBottom: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <strong style={{ color: 'var(--color-success)', fontSize: 13 }}>
          ✓ Fulfilled · {fulfilledOn}
        </strong>
        <span style={{ color: 'var(--color-success)', fontSize: 11 }}>
          Email sent · Unit {row.assigned_serial}
        </span>
      </div>

      <div style={{
        border: '1px solid var(--color-border)', borderRadius: 6, padding: 14, fontSize: 11,
        display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 6, columnGap: 14,
      }}>
        <span style={{ color: 'var(--color-ink-subtle)' }}>Customer</span>
        <span>{order.customer_name}</span>
        <span style={{ color: 'var(--color-ink-subtle)' }}>Order ref</span>
        <span style={{ fontFamily: 'ui-monospace, monospace' }}>{order.order_ref}</span>
        <span style={{ color: 'var(--color-ink-subtle)' }}>Email</span>
        <span>{order.customer_email ?? '—'}</span>
        <span style={{ color: 'var(--color-ink-subtle)' }}>Serial shipped</span>
        <span style={{ fontFamily: 'ui-monospace, monospace' }}>{row.assigned_serial}</span>
        <span style={{ color: 'var(--color-ink-subtle)' }}>{row.carrier}</span>
        <span style={{ fontFamily: 'ui-monospace, monospace' }}>{row.tracking_num}</span>
        {order.country === 'US' && (
          <>
            <span style={{ color: 'var(--color-ink-subtle)' }}>Starter kit</span>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{row.starter_tracking_num ?? '—'}</span>
          </>
        )}
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
        <button
          onClick={() => navigator.clipboard.writeText(handoffRef)}
          style={{
            background: '#fff', color: 'var(--color-ink-muted)',
            border: '1px solid var(--color-border)', padding: '6px 12px',
            borderRadius: 4, fontSize: 11, cursor: 'pointer',
          }}
        >Copy handoff ref ({handoffRef})</button>
        {order.customer_email && (
          <a
            href={`mailto:${order.customer_email}`}
            style={{
              background: '#fff', color: 'var(--color-info)',
              border: '1px solid var(--color-border)', padding: '6px 12px',
              borderRadius: 4, fontSize: 11, textDecoration: 'none',
            }}
          >Open customer email thread</a>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire in queue/index.tsx**

```tsx
import { StepFulfilled } from './StepFulfilled';
```

Replace fallback:
```tsx
{selected.step === 6 && <StepFulfilled row={selected} order={selectedOrder} />}
```

- [ ] **Step 3: Verify + commit**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Fulfillment Step 6 — Fulfilled terminal view"
```

---

## Task 19: Shelf grid + SkidCard + Slot

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\shelf\index.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\shelf\SkidCard.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\shelf\Slot.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\Fulfillment.module.css` (append)
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\index.tsx` (wire shelf tab)

- [ ] **Step 1: Append shelf styles**

```css
.shelfLayout {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.shelfBar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.shelfStats { font-size: 11px; color: var(--color-ink-subtle); }
.shelfStats strong { color: var(--color-ink); font-weight: 700; }

.skidGrid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
}

.skidCard {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px;
  background: #fff;
}
.skidLabel {
  font-size: 10px;
  font-weight: 800;
  color: var(--color-crimson);
  margin-bottom: 6px;
  letter-spacing: 0.5px;
}
.skidRowTop {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin-bottom: 4px;
}
.skidRowBottom {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px;
}
.slot {
  border: 1.5px solid var(--color-border);
  border-radius: 3px;
  padding: 4px;
  text-align: center;
  font-size: 9px;
  cursor: grab;
  user-select: none;
  overflow: hidden;
}
.slot.portrait  { aspect-ratio: 4/6; }
.slot.landscape { aspect-ratio: 6/4; }
.slot.available { background: var(--color-success-bg); border-color: var(--color-success-border); color: var(--color-success); }
.slot.reserved  { background: var(--color-warning-bg); border-color: var(--color-warning-border); color: var(--color-warning); }
.slot.rework    { background: var(--color-error-bg); border-color: var(--color-error-border); color: var(--color-error); }
.slot.empty     { background: transparent; border-style: dashed; color: var(--color-ink-faint); }
.slot.dragging  { opacity: 0.3; }
.slot.dropTarget { outline: 2px dashed var(--color-crimson); outline-offset: 2px; }

.slotSerial { font-family: ui-monospace, monospace; font-weight: 700; font-size: 9px; }
.slotBatch { font-size: 8px; opacity: 0.7; margin-top: 2px; }
```

- [ ] **Step 2: Write `Slot.tsx`**

```tsx
import type { ShelfSlot } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

type DragHandlers = {
  onDragStart: (e: React.DragEvent, slot: ShelfSlot) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, slot: ShelfSlot) => void;
};

export function Slot({
  slot,
  shape,
  isDragging,
  isDropTarget,
  handlers,
}: {
  slot: ShelfSlot;
  shape: 'portrait' | 'landscape';
  isDragging: boolean;
  isDropTarget: boolean;
  handlers: DragHandlers;
}) {
  const cls = [
    styles.slot,
    shape === 'portrait' ? styles.portrait : styles.landscape,
    styles[slot.status],
    isDragging ? styles.dragging : '',
    isDropTarget ? styles.dropTarget : '',
  ].filter(Boolean).join(' ');

  const draggable = slot.status !== 'empty';

  return (
    <div
      className={cls}
      draggable={draggable}
      onDragStart={e => handlers.onDragStart(e, slot)}
      onDragEnd={handlers.onDragEnd}
      onDragOver={handlers.onDragOver}
      onDragLeave={handlers.onDragLeave}
      onDrop={e => handlers.onDrop(e, slot)}
      title={slot.serial ? `${slot.serial} (${slot.skid} · ${slot.slot_index})` : `empty ${slot.skid} · ${slot.slot_index}`}
    >
      {slot.serial ? (
        <>
          <div className={styles.slotSerial}>…{slot.serial.slice(-5)}</div>
          <div className={styles.slotBatch}>{slot.batch}</div>
        </>
      ) : <div className={styles.slotBatch}>empty</div>}
    </div>
  );
}
```

- [ ] **Step 3: Write `SkidCard.tsx`**

```tsx
import type { ShelfSlot } from '../../../lib/fulfillment';
import { Slot } from './Slot';
import styles from '../Fulfillment.module.css';

type DragHandlers = React.ComponentProps<typeof Slot>['handlers'];

export function SkidCard({
  skid,
  slots,
  dragSource,
  dragTarget,
  handlers,
}: {
  skid: string;
  slots: ShelfSlot[];
  dragSource: { skid: string; slot_index: number } | null;
  dragTarget: { skid: string; slot_index: number } | null;
  handlers: DragHandlers;
}) {
  const byIndex = new Map(slots.map(s => [s.slot_index, s]));
  const get = (idx: number) => byIndex.get(idx) ?? {
    skid, slot_index: idx, serial: null, batch: null, status: 'empty' as const, updated_at: '',
  };
  const isDrag = (idx: number) => dragSource?.skid === skid && dragSource.slot_index === idx;
  const isTarget = (idx: number) => dragTarget?.skid === skid && dragTarget.slot_index === idx;

  return (
    <div className={styles.skidCard}>
      <div className={styles.skidLabel}>{skid}</div>
      <div className={styles.skidRowTop}>
        {[0, 1, 2].map(i => (
          <Slot key={i} slot={get(i)} shape="portrait"
                isDragging={isDrag(i)} isDropTarget={isTarget(i)} handlers={handlers} />
        ))}
      </div>
      <div className={styles.skidRowBottom}>
        {[3, 4].map(i => (
          <Slot key={i} slot={get(i)} shape="landscape"
                isDragging={isDrag(i)} isDropTarget={isTarget(i)} handlers={handlers} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `shelf/index.tsx` (static grid — drag-drop in Task 20)**

```tsx
import { useMemo } from 'react';
import { useShelf, type ShelfSlot } from '../../../lib/fulfillment';
import { SkidCard } from './SkidCard';
import styles from '../Fulfillment.module.css';

function autoNextSerial(slots: ShelfSlot[]): string | null {
  const sorted = [...slots].sort((a, b) => {
    const aFront = a.slot_index >= 3 ? 0 : 1;
    const bFront = b.slot_index >= 3 ? 0 : 1;
    if (aFront !== bFront) return aFront - bFront;
    const an = parseInt(a.skid.replace(/^[A-Z]+/, ''), 10);
    const bn = parseInt(b.skid.replace(/^[A-Z]+/, ''), 10);
    if (an !== bn) return an - bn;
    return a.slot_index - b.slot_index;
  });
  return sorted.find(s => s.status === 'available' && s.serial)?.serial ?? null;
}

export default function Shelf() {
  const { slots, loading } = useShelf();

  const groupedBySkid = useMemo(() => {
    const m = new Map<string, ShelfSlot[]>();
    for (const s of slots) {
      if (!m.has(s.skid)) m.set(s.skid, []);
      m.get(s.skid)!.push(s);
    }
    return m;
  }, [slots]);

  const skidKeys = useMemo(() => Array.from({ length: 30 }, (_, i) => `A${i + 1}`), []);
  const stats = useMemo(() => {
    const out = { available: 0, reserved: 0, rework: 0, empty: 0 };
    for (const s of slots) out[s.status]++;
    return out;
  }, [slots]);
  const nextSerial = useMemo(() => autoNextSerial(slots), [slots]);

  if (loading) return <div>Loading shelf…</div>;

  return (
    <div className={styles.shelfLayout}>
      <div className={styles.shelfBar}>
        <div className={styles.shelfStats}>
          <strong>150 slots</strong> · {stats.available} available · {stats.reserved} reserved · {stats.rework} rework · {stats.empty} empty
        </div>
        <div className={styles.shelfStats}>
          Auto-assign next → <strong>{nextSerial ?? '—'}</strong>
        </div>
      </div>
      <div className={styles.skidGrid}>
        {skidKeys.map(skid => (
          <SkidCard
            key={skid}
            skid={skid}
            slots={groupedBySkid.get(skid) ?? []}
            dragSource={null}
            dragTarget={null}
            handlers={{
              onDragStart: () => {}, onDragEnd: () => {},
              onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {},
            }}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire Shelf tab in `Fulfillment/index.tsx`**

Add import:
```tsx
import Shelf from './shelf';
```

Replace `<div>Shelf sub-tab — filled in by Task 19</div>` with `<Shelf />`.

- [ ] **Step 6: Verify + commit**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Shelf grid — 30 skids × 5 slots (3 portrait + 2 landscape)"
```

---

## Task 20: Shelf drag-drop + Confirm layout button

**Files:**
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\shelf\index.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\Fulfillment.module.css` (minor addition for the button)

- [ ] **Step 1: Append confirm-button styles**

```css
.confirmLayoutBtn {
  background: var(--color-success);
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
.confirmLayoutBtn:disabled { background: var(--color-border); color: var(--color-ink-faint); cursor: not-allowed; }
.confirmLayoutBtn.saved { background: #c6f6d5; color: var(--color-success); }
```

- [ ] **Step 2: Extend `shelf/index.tsx` with drag state + swap logic**

Replace the whole file:

```tsx
import { useMemo, useState } from 'react';
import { useShelf, swapSlots, confirmShelfLayout, type ShelfSlot } from '../../../lib/fulfillment';
import { SkidCard } from './SkidCard';
import styles from '../Fulfillment.module.css';

type Pos = { skid: string; slot_index: number };

function autoNextSerial(slots: ShelfSlot[]): string | null {
  const sorted = [...slots].sort((a, b) => {
    const aFront = a.slot_index >= 3 ? 0 : 1;
    const bFront = b.slot_index >= 3 ? 0 : 1;
    if (aFront !== bFront) return aFront - bFront;
    const an = parseInt(a.skid.replace(/^[A-Z]+/, ''), 10);
    const bn = parseInt(b.skid.replace(/^[A-Z]+/, ''), 10);
    if (an !== bn) return an - bn;
    return a.slot_index - b.slot_index;
  });
  return sorted.find(s => s.status === 'available' && s.serial)?.serial ?? null;
}

export default function Shelf() {
  const { slots, loading } = useShelf();
  const [source, setSource] = useState<Pos | null>(null);
  const [target, setTarget] = useState<Pos | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupedBySkid = useMemo(() => {
    const m = new Map<string, ShelfSlot[]>();
    for (const s of slots) {
      if (!m.has(s.skid)) m.set(s.skid, []);
      m.get(s.skid)!.push(s);
    }
    return m;
  }, [slots]);

  const skidKeys = useMemo(() => Array.from({ length: 30 }, (_, i) => `A${i + 1}`), []);
  const stats = useMemo(() => {
    const out = { available: 0, reserved: 0, rework: 0, empty: 0 };
    for (const s of slots) out[s.status]++;
    return out;
  }, [slots]);
  const nextSerial = useMemo(() => autoNextSerial(slots), [slots]);

  const handlers = {
    onDragStart: (e: React.DragEvent, slot: ShelfSlot) => {
      setSource({ skid: slot.skid, slot_index: slot.slot_index });
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => { setSource(null); setTarget(null); },
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
    onDragLeave: () => { setTarget(null); },
    onDrop: async (e: React.DragEvent, slot: ShelfSlot) => {
      e.preventDefault();
      const from = source;
      if (!from) return;
      if (from.skid === slot.skid && from.slot_index === slot.slot_index) return;
      setBusy(true); setError(null);
      try {
        await swapSlots(from, { skid: slot.skid, slot_index: slot.slot_index });
        setDirty(true); setSaved(false);
      } catch (err) { setError((err as Error).message); }
      finally { setBusy(false); setSource(null); setTarget(null); }
    },
  };

  const handleConfirmLayout = async () => {
    setBusy(true); setError(null);
    try { await confirmShelfLayout(); setDirty(false); setSaved(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  if (loading) return <div>Loading shelf…</div>;

  return (
    <div className={styles.shelfLayout}>
      <div className={styles.shelfBar}>
        <div className={styles.shelfStats}>
          <strong>150 slots</strong> · {stats.available} available · {stats.reserved} reserved · {stats.rework} rework · {stats.empty} empty
        </div>
        <div className={styles.shelfStats}>
          Auto-assign next → <strong>{nextSerial ?? '—'}</strong>
        </div>
        <button
          className={`${styles.confirmLayoutBtn} ${saved ? styles.saved : ''}`}
          onClick={handleConfirmLayout}
          disabled={!dirty || busy}
        >
          {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Confirm layout'}
        </button>
        {error && <span style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</span>}
      </div>
      <div className={styles.skidGrid}>
        {skidKeys.map(skid => (
          <SkidCard
            key={skid}
            skid={skid}
            slots={groupedBySkid.get(skid) ?? []}
            dragSource={source}
            dragTarget={target}
            handlers={handlers}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify + commit**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Shelf drag-drop swap + Confirm layout checkpoint"
```

---

## Task 21: Reworks panel

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\shelf\ReworksPanel.tsx`
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\shelf\index.tsx` (render panel below grid)
- Modify: `E:\Claude\makelila\app\src\modules\Fulfillment\Fulfillment.module.css` (append)

- [ ] **Step 1: Append panel styles**

```css
.reworksPanel {
  border: 1px solid var(--color-error-border);
  background: var(--color-error-bg);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.reworksTitle { font-size: 11px; font-weight: 700; color: var(--color-error); margin-bottom: 8px; }
.reworkCard {
  background: #fff;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 6px;
  font-size: 11px;
}
.reworkMeta { color: var(--color-ink-subtle); font-size: 10px; margin-bottom: 3px; }
.reworkBody { color: var(--color-ink); white-space: pre-wrap; }
.reworkRow { display: flex; gap: 8px; margin-top: 6px; align-items: flex-start; }
```

- [ ] **Step 2: Write `ReworksPanel.tsx`**

```tsx
import { useState } from 'react';
import { useOpenReworks, resolveRework, type UnitRework } from '../../../lib/fulfillment';
import { useAuth } from '../../../lib/auth';
import styles from '../Fulfillment.module.css';

function ReworkCard({ rw, resolverName }: { rw: UnitRework; resolverName: string }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async () => {
    setBusy(true); setError(null);
    try { await resolveRework(rw.id, rw.serial, notes || undefined, resolverName); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.reworkCard}>
      <div className={styles.reworkMeta}>
        <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{rw.serial}</strong>
        {' · flagged by '}{rw.flagged_by_name}
        {' · '}{new Date(rw.flagged_at).toLocaleString()}
      </div>
      <div className={styles.reworkBody}>{rw.issue}</div>
      <div className={styles.reworkRow}>
        <input
          type="text"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Resolution notes (optional)"
          style={{
            flex: 1, padding: '5px 8px', border: '1px solid var(--color-border)',
            borderRadius: 3, fontSize: 10,
          }}
        />
        <button
          onClick={resolve}
          disabled={busy}
          style={{
            background: 'var(--color-success)', color: '#fff', border: 'none',
            padding: '5px 12px', borderRadius: 3, fontSize: 10, fontWeight: 700,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >{busy ? 'Resolving…' : 'Mark resolved'}</button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 10, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

export function ReworksPanel() {
  const { reworks, loading } = useOpenReworks();
  const { profile, user } = useAuth();
  const resolverName = profile?.display_name ?? user?.email ?? 'Unknown';

  if (loading) return null;
  return (
    <div className={styles.reworksPanel}>
      <div className={styles.reworksTitle}>
        {reworks.length === 0 ? 'No units pending rework.' : `Pending reworks (${reworks.length})`}
      </div>
      {reworks.map(rw => <ReworkCard key={rw.id} rw={rw} resolverName={resolverName} />)}
    </div>
  );
}
```

- [ ] **Step 3: Add panel to `shelf/index.tsx`**

Below the `<div className={styles.skidGrid}>` block in the return, add:

```tsx
<ReworksPanel />
```

Add import:
```tsx
import { ReworksPanel } from './ReworksPanel';
```

- [ ] **Step 4: Verify + commit**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run build && npm run test:run
```

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/
git commit -m "feat(app): Shelf reworks panel with mark-resolved flow"
```

---

## Task 22: Component tests

**Files:**
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\__tests__\QueueSidebar.test.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\__tests__\StepTest.test.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment\__tests__\StepEmail.test.tsx`

- [ ] **Step 1: `QueueSidebar.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueueSidebar } from '../queue/QueueSidebar';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

function mkRow(partial: Partial<FulfillmentQueueRow> & { id: string; order_id: string }): FulfillmentQueueRow {
  return {
    step: 1, assigned_serial: null,
    test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
    carrier: null, tracking_num: null, label_pdf_path: null,
    label_confirmed_at: null, label_confirmed_by: null,
    dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false,
    dock_confirmed_at: null, dock_confirmed_by: null,
    starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
    fulfilled_at: null, fulfilled_by: null,
    due_date: null, created_at: '2026-04-19T00:00:00Z',
    ...partial,
  };
}

describe('QueueSidebar', () => {
  const today = new Date().toISOString().slice(0, 10);
  const row1 = mkRow({ id: 'q1', order_id: 'o1', step: 1, due_date: today });
  const row2 = mkRow({ id: 'q2', order_id: 'o2', step: 3, due_date: '2099-01-01' });

  const orders = new Map([
    ['o1', { order_ref: '#1001', customer_name: 'Alice', city: 'Portland', country: 'US' as const }],
    ['o2', { order_ref: '#1002', customer_name: 'Bob',   city: 'Toronto',  country: 'CA' as const }],
  ]);

  it('renders each row with customer name and step badge', () => {
    render(<QueueSidebar rows={[row1, row2]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('1/6')).toBeInTheDocument();
    expect(screen.getByText('3/6')).toBeInTheDocument();
  });

  it('shows "Due TODAY" for today\'s deadline', () => {
    render(<QueueSidebar rows={[row1]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/Due TODAY/i)).toBeInTheDocument();
  });

  it('calls onSelect with the row id', () => {
    const onSelect = vi.fn();
    render(<QueueSidebar rows={[row1, row2]} orderLookup={orders} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Alice'));
    expect(onSelect).toHaveBeenCalledWith('q1');
  });

  it('shows empty-state when no rows', () => {
    render(<QueueSidebar rows={[]} orderLookup={orders} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/No queued orders/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: `StepTest.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { confirmTestMock, flagReworkMock } = vi.hoisted(() => ({
  confirmTestMock: vi.fn(() => Promise.resolve()),
  flagReworkMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return {
    ...actual,
    confirmTestReport: confirmTestMock,
    flagRework: flagReworkMock,
  };
});

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    profile: { id: 'u1', display_name: 'Aaron', role: 'member' },
    user: { id: 'u1', email: 'aaron@virgohome.io' },
    session: null, loading: false, signInWithGoogle: vi.fn(), signOut: vi.fn(),
  }),
}));

import { StepTest } from '../queue/StepTest';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const row: FulfillmentQueueRow = {
  id: 'q-test', order_id: 'o-test', step: 2, assigned_serial: 'LL01-00000000050',
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null, label_pdf_path: null,
  label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, created_at: '2026-04-19T00:00:00Z',
};

describe('StepTest', () => {
  beforeEach(() => {
    confirmTestMock.mockClear();
    flagReworkMock.mockClear();
  });

  it('Test passed calls confirmTestReport with the URL', async () => {
    render(<StepTest row={row} />);
    fireEvent.change(screen.getByPlaceholderText(/drive\.google/i), {
      target: { value: 'https://drive.example/test.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /test passed/i }));
    await waitFor(() => {
      expect(confirmTestMock).toHaveBeenCalledWith('q-test', 'https://drive.example/test.pdf');
    });
  });

  it('Flag rework requires an issue; calls flagRework with serial + issue + reporter', async () => {
    render(<StepTest row={row} />);
    fireEvent.click(screen.getByRole('button', { name: /flag to aaron/i }));
    const flagBtn = screen.getByRole('button', { name: /flag rework/i });
    expect(flagBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/what's wrong/i), {
      target: { value: 'visible crack on top lid' },
    });
    expect(flagBtn).toBeEnabled();
    fireEvent.click(flagBtn);
    await waitFor(() => {
      expect(flagReworkMock).toHaveBeenCalledWith('q-test', 'LL01-00000000050', 'visible crack on top lid', 'Aaron');
    });
  });
});
```

- [ ] **Step 3: `StepEmail.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { setStarterMock, sendEmailMock } = vi.hoisted(() => ({
  setStarterMock: vi.fn(() => Promise.resolve()),
  sendEmailMock: vi.fn(() => Promise.resolve({ email_id: 're_123' })),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return {
    ...actual,
    setStarterTracking: setStarterMock,
    sendFulfillmentEmail: sendEmailMock,
  };
});

import { StepEmail } from '../queue/StepEmail';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const rowBase: FulfillmentQueueRow = {
  id: 'q-e', order_id: 'o-e', step: 5, assigned_serial: 'LL01-00000000050',
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: 'UPS', tracking_num: '1ZABC',
  label_pdf_path: null, label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: true, dock_affixed: true, dock_docked: true, dock_notified: true,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, created_at: '2026-04-19T00:00:00Z',
};

const orderUS = { customer_name: 'Alice Ames', customer_email: 'a@ex.com', order_ref: '#1001', country: 'US' as const };
const orderCA = { customer_name: 'Bob Boxer',  customer_email: 'b@ex.com', order_ref: '#1002', country: 'CA' as const };

describe('StepEmail', () => {
  beforeEach(() => { setStarterMock.mockClear(); sendEmailMock.mockClear(); });

  it('US order: Send disabled until starter tracking is filled', () => {
    render(<StepEmail row={rowBase} order={orderUS} />);
    expect(screen.getByRole('button', { name: /send email/i })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/1Z.+starter/i), { target: { value: '1ZSTARTER' } });
    expect(screen.getByRole('button', { name: /send email/i })).toBeEnabled();
  });

  it('CA order: no starter field shown; Send enabled right away', () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    expect(screen.queryByPlaceholderText(/starter/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send email/i })).toBeEnabled();
  });

  it('Clicking Send calls sendFulfillmentEmail', async () => {
    render(<StepEmail row={rowBase} order={orderCA} />);
    fireEvent.click(screen.getByRole('button', { name: /send email/i }));
    await waitFor(() => expect(sendEmailMock).toHaveBeenCalledWith('q-e'));
  });
});
```

- [ ] **Step 4: Run suite**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run test:run
```

Expected: 32 (from Task 8) + 4 Sidebar + 2 StepTest + 3 StepEmail = **41 tests passing**.

- [ ] **Step 5: Commit**

```bash
cd /e/Claude/makelila
git add app/src/modules/Fulfillment/__tests__/
git commit -m "test(app): Fulfillment component tests — Sidebar + StepTest + StepEmail"
```

---

## Task 23: Playwright smoke — unauth redirects

**Files:**
- Create: `E:\Claude\makelila\app\tests\e2e\fulfillment.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';

test('unauthed /fulfillment redirects to /login', async ({ page }) => {
  await page.goto('fulfillment');
  await expect(page).toHaveURL(/\/login/);
});

test('unauthed /fulfillment/shelf redirects to /login', async ({ page }) => {
  await page.goto('fulfillment/shelf');
  await expect(page).toHaveURL(/\/login/);
});
```

- [ ] **Step 2: Run e2e**

```bash
cd /e/Claude/makelila/app && export PATH="/c/Program Files/nodejs:$PATH" && npm run e2e
```

Expected: 4 prior + 2 new = 6 passing.

- [ ] **Step 3: Commit**

```bash
cd /e/Claude/makelila
git add app/tests/e2e/fulfillment.spec.ts
git commit -m "test(app): Playwright smoke — unauth redirect for fulfillment routes"
```

---

## Task 24: Final integration, deploy, release

- [ ] **Step 1: Fresh-install regression**

```bash
cd /e/Claude/makelila/app
rm -rf node_modules
export PATH="/c/Program Files/nodejs:$PATH"
npm ci
npm run test:run
npm run build
npm run e2e
```

Expected: 41 unit tests pass, build clean, 6 e2e tests pass.

- [ ] **Step 2: Manual walkthrough against the spec**

Against `docs/2026-04-19-make-lila-fulfillment-design.md` done-criteria:
- Approve a pending order in Order Review → verify queue row appears (Pending tab of Fulfillment sidebar).
- Walk an order through Steps 1 → 6 end-to-end. Verify email arrives at a test mailbox.
- At Step 2, flag a different order's unit for rework → verify order drops to Step 1, unit appears in Rework panel, slot flipped to red on Shelf.
- Mark the rework resolved → slot flips back to green; unit is reusable.
- Drag two slots on Shelf tab → slots swap; Confirm layout button flips green then Saved ✓.

- [ ] **Step 3: Push to origin** (via GitHub Desktop — CLI auth not set up).

- [ ] **Step 4: Apply remote migrations**

```powershell
cd E:\Claude\makelila
.\app\node_modules\.bin\supabase.cmd db push
```

(Enter DB password when prompted. Confirms the list of new migrations.)

- [ ] **Step 5: Deploy the edge function**

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<your sbp_ token>"
.\app\node_modules\.bin\supabase.cmd secrets set RESEND_API_KEY=<re_...>
.\app\node_modules\.bin\supabase.cmd functions deploy send-fulfillment-email --project-ref txeftbbzeflequvrmjjr
```

- [ ] **Step 6: Wait for GitHub Actions deploy to go green** (the UI changes auto-deploy on push).

- [ ] **Step 7: Production smoke test**

Visit https://lila.vip/fulfillment. Sign in. Walk through the flow with a small approved order. Confirm the email arrives.

- [ ] **Step 8: Tag the release**

Create at https://github.com/virgohomeio/makelila/releases/new:
- Tag: `v0.3.0-fulfillment-queue-shelf`
- Target: `main`
- Title: `v0.3.0-fulfillment-queue-shelf — Fulfillment Queue + Shelf`
- Description:
  ```
  Builds on v0.2.0-order-review. Ships the Fulfillment Queue + Shelf sub-tabs:

  - Auto-enqueue on Order Review approve (DB trigger)
  - 5-step state machine per order: Assign → Test → Label → Dock → Email → Fulfilled
  - 30-skid shelf (150 slots, 3 portrait top + 2 landscape bottom each)
  - Drag-and-drop shelf rearrangement with Confirm layout checkpoint
  - Rework flow: flag at Step 2 → unit → rework queue → resolve → back on shelf
  - Optional ship-label PDF upload to Supabase Storage
  - Customer shipment emails via Resend transactional API (support@lilacomposter.com)
  - Realtime cross-reviewer updates across all three new tables
  ```

- [ ] **Step 9: Fetch the tag locally**

```bash
cd /e/Claude/makelila && git fetch --tags origin
```

## Done criteria

All 6 from the design spec's Done Criteria section, plus:

1. 41 unit + 6 e2e tests passing.
2. Resend verified for `lilacomposter.com`; `send-fulfillment-email` deployed on `txeftbbzeflequvrmjjr`.
3. `v0.3.0-fulfillment-queue-shelf` tag published.

## Next plans (not in scope here)

Per the shared-infra plan's "Next plans":
- `<date>-make-lila-post-shipment-plan.md` — Post-Shipment module (geo dashboard + in-transit tracking, reads `fulfilled` queue rows).
- `<date>-make-lila-stock-module-plan.md` — Stock module (inventory lifecycle, Make Orders, batch arrivals; eventually replaces the hand-seeded P100 migration).
- `<date>-make-lila-fulfillment-history-replacements-returns-plan.md` — the three deferred sub-tabs of Fulfillment.
