# Queued for Replacement as a Multi-Select Tag — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the "Queued for Replacement" marker off `service_tickets.status` and onto the existing multi-select `tags` column, so a ticket can carry it alongside any other label.

**Architecture:** `status` stays the single workflow state (drives SLA aging, `closed_at`, the state machine). `queued_for_replacement` becomes a tag, added automatically when a replacement order is created and removed when it ships or is cancelled. Tag mutations go through two idempotent SQL functions so concurrent operator edits can't be lost. A new multi-select Tags row in the ticket panel wires up `updateTicketTags()`, which has existed unused since migration `20260714000000`.

**Tech Stack:** React 18 + TypeScript, CSS Modules, Supabase (Postgres + PostgREST RPC), Vitest.

Spec: [docs/superpowers/specs/2026-08-10-replacement-tag-multi-select-design.md](../specs/2026-08-10-replacement-tag-multi-select-design.md)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/migrations/20260810120000_ticket_queued_replacement_to_tag.sql` | `add_ticket_tag` / `remove_ticket_tag` RPCs + 31-row backfill | Create |
| `app/src/lib/service.ts` | Add `WORKFLOW_STATUSES` (settable states) alongside `TICKET_STATUSES` (DB + tag vocabulary) | Modify |
| `app/src/lib/orders.ts` | Tag on replacement create; untag on ship/cancel | Modify |
| `app/src/lib/orders.test.ts` | Update the assertion that expects `status: 'queued_for_replacement'`; add tag/untag coverage | Modify |
| `app/src/modules/Service/TicketDetailPanel.tsx` | Status row drops one button; new multi-select Tags row | Modify |
| `app/src/modules/Service/__tests__/TicketDetailPanel.test.tsx` | Tags row toggles; Status row no longer offers Queued | Create or extend |
| `supabase/functions/_shared/classifier-llm.ts` | Stop emitting `queued_for_replacement` as a status | Modify |

Run all commands from `app/` unless the path says otherwise.

---

### Task 1: Migration — tag RPCs + backfill

**Files:**
- Create: `supabase/migrations/20260810120000_ticket_queued_replacement_to_tag.sql`

- [ ] **Step 1: Write the migration**

```sql
-- "Queued for Replacement" moves from service_tickets.status to tags[].
--
-- A ticket queued for a replacement needs to carry other labels at the same
-- time (on hold, call scheduled, ...). `status` is single-valued and drives SLA
-- aging / closed_at / the state machine, so the replacement marker moves to the
-- existing multi-select `tags` column (added in 20260714000000).
--
-- The two functions below are the ONLY way the app mutates a single tag. A
-- read-modify-write from TypeScript would be a TOCTOU race: an operator toggling
-- a tag in the panel while a replacement order is being created could lose one
-- of the two writes. Both are idempotent, so retries are safe.
--
-- security invoker (unlike decrement_part_on_hand, which is definer because it
-- writes the shared parts table) — ticket RLS must still apply to the caller.

create or replace function public.add_ticket_tag(p_ticket_id uuid, p_tag text)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.service_tickets
     set tags = array_append(tags, p_tag)
   where id = p_ticket_id
     and not (p_tag = any(tags));
$$;

create or replace function public.remove_ticket_tag(p_ticket_id uuid, p_tag text)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.service_tickets
     set tags = array_remove(tags, p_tag)
   where id = p_ticket_id;
$$;

revoke all on function public.add_ticket_tag(uuid, text) from anon, public;
revoke all on function public.remove_ticket_tag(uuid, text) from anon, public;
grant execute on function public.add_ticket_tag(uuid, text) to authenticated;
grant execute on function public.remove_ticket_tag(uuid, text) to authenticated;

-- Backfill: 31 rows as of 2026-08-10. These tickets are waiting on a
-- replacement to arrive, so 'waiting_on_customer' is the honest status — it
-- stops the SLA clock running against ops and keeps them out of Action Needed
-- (which would otherwise go 194 -> 225). Visually nothing changes in the
-- Support list: StatusPills renders the same "Queued for P100X Replacement"
-- text for the tag variant as it did for the status pill.
update public.service_tickets
   set tags   = array_append(tags, 'queued_for_replacement'),
       status = 'waiting_on_customer'
 where status = 'queued_for_replacement'
   and not ('queued_for_replacement' = any(tags));
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260810120000_ticket_queued_replacement_to_tag.sql
git commit -m "feat(service): add_ticket_tag/remove_ticket_tag RPCs + queued-replacement backfill"
```

Note: migrations are gated behind the manual workflow in this repo — pushing does not apply them.

---

### Task 2: `WORKFLOW_STATUSES` in the data layer

**Files:**
- Modify: `app/src/lib/service.ts:20-24`
- Test: `app/src/lib/service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/service.test.ts` (create the file with `import { describe, it, expect } from 'vitest';` and the import line below if it does not exist):

```ts
import { TICKET_STATUSES, WORKFLOW_STATUSES } from './service';

describe('WORKFLOW_STATUSES', () => {
  it('is every ticket status except queued_for_replacement', () => {
    expect(WORKFLOW_STATUSES).toEqual(
      TICKET_STATUSES.filter(s => s !== 'queued_for_replacement'),
    );
  });

  it('keeps queued_for_replacement in the full vocabulary (DB values + tags)', () => {
    expect(TICKET_STATUSES).toContain('queued_for_replacement');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- service.test.ts`
Expected: FAIL — `WORKFLOW_STATUSES` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `app/src/lib/service.ts`, directly after the `TicketStatus` type alias (~line 24):

```ts
/** The workflow states an operator can set as a ticket's `status`.
 *  Excludes 'queued_for_replacement': that is a TAG now, set automatically when
 *  a replacement order is created, so it can coexist with any status. It stays
 *  in TICKET_STATUSES because that is both the DB CHECK vocabulary (legacy rows)
 *  and the tag vocabulary. */
export const WORKFLOW_STATUSES = TICKET_STATUSES.filter(
  (s): s is TicketStatus => s !== 'queued_for_replacement',
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/service.ts app/src/lib/service.test.ts
git commit -m "feat(service): add WORKFLOW_STATUSES (settable statuses, minus queued_for_replacement)"
```

---

### Task 3: Tag on replacement create

**Files:**
- Modify: `app/src/lib/orders.ts` (~L930 `createReplacementOrder`, ~L1020 `createPendingReplacement`)
- Test: `app/src/lib/orders.test.ts:235-238`

- [ ] **Step 1: Update the existing failing assertion + add one**

In `app/src/lib/orders.test.ts`, replace the block at ~L235:

```ts
    // Ticket gets queued_for_replacement.
    expect(ticketUpdateFn).toHaveBeenCalledWith(expect.objectContaining({
      replacement_order_id: 'o9', status: 'queued_for_replacement',
    }));
```

with:

```ts
    // Ticket is back-linked but its status is NOT touched — the operator's
    // workflow state must survive a replacement being queued.
    expect(ticketUpdateFn).toHaveBeenCalledWith({ replacement_order_id: 'o9' });
    // The queued marker is a TAG, applied atomically via RPC.
    expect(rpcMock).toHaveBeenCalledWith('add_ticket_tag', {
      p_ticket_id: 't1', p_tag: 'queued_for_replacement',
    });
```

Read the surrounding `describe` to confirm the ticket id the fixture passes as
`input.ticket_id`; use that literal in place of `'t1'` if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orders.test.ts`
Expected: FAIL — the update still carries `status`, and `add_ticket_tag` was never called.

- [ ] **Step 3: Write minimal implementation**

In `createReplacementOrder` (~L930), change the comment and update, then add the RPC:

```ts
  // 2. Back-link the ticket and TAG it queued_for_replacement. The tag (not the
  //    status) carries the marker, so whatever workflow state the operator set
  //    survives — and they can layer other tags on top.
  const { error: tErr } = await supabase
    .from('service_tickets')
    .update({ replacement_order_id: row.id })
    .eq('id', input.ticket_id);
  if (tErr) throw new Error(`Link ticket: ${tErr.message}`);

  const { error: tagErr } = await supabase.rpc('add_ticket_tag', {
    p_ticket_id: input.ticket_id, p_tag: 'queued_for_replacement',
  });
  if (tagErr) throw new Error(`Tag ticket: ${tagErr.message}`);
```

Apply the identical change in `createPendingReplacement` (~L1020), keeping its
existing "No stock decrement / unit reservation" comment intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orders.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orders.ts app/src/lib/orders.test.ts
git commit -m "feat(orders): tag ticket queued_for_replacement instead of overwriting status"
```

---

### Task 4: Untag on cancel

**Files:**
- Modify: `app/src/lib/orders.ts` (~L684, inside `releaseAndDeleteReplacement`)
- Test: `app/src/lib/orders.test.ts`

`releaseAndDeleteReplacement` is the single choke point for both cancel paths:
`cancelReplacementOrder` (manual) and `cancelPendingReplacementsForTicket` (auto,
on ticket close). Tagging there covers both.

- [ ] **Step 1: Write the failing test**

Add to `app/src/lib/orders.test.ts`:

```ts
  it('clears the queued_for_replacement tag when a replacement is cancelled', async () => {
    // Ticket must be closed for the cancel gate to pass.
    await cancelReplacementOrder('order-x');
    expect(rpcMock).toHaveBeenCalledWith('remove_ticket_tag', {
      p_ticket_id: 'ticket-x', p_tag: 'queued_for_replacement',
    });
  });
```

Mirror the mock setup of the nearest existing `cancelReplacementOrder` test in
the file (the order fixture needs `kind: 'replacement'`, `linked_ticket_id:
'ticket-x'`, null `shipped_at`/`delivered_at`, and the linked ticket must read
back `status: 'closed'`). If no such test exists, build the fixture from the
`select` list at `orders.ts:706`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orders.test.ts`
Expected: FAIL — `remove_ticket_tag` was never called.

- [ ] **Step 3: Write minimal implementation**

In `releaseAndDeleteReplacement`, extend the existing back-link block:

```ts
  // Drop the ticket back-link so nothing dangles once the order is gone, and
  // clear the queued marker — the customer is no longer waiting on this
  // replacement. Best-effort: the order is being deleted either way, so a tag
  // failure must not strand it (same precedent as the auto-cancel on close).
  if (order.linked_ticket_id) {
    await supabase.from('service_tickets')
      .update({ replacement_order_id: null })
      .eq('id', order.linked_ticket_id);
    const { error: tagErr } = await supabase.rpc('remove_ticket_tag', {
      p_ticket_id: order.linked_ticket_id, p_tag: 'queued_for_replacement',
    });
    if (tagErr) console.warn('Clearing queued_for_replacement tag failed (non-fatal):', tagErr.message);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orders.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orders.ts app/src/lib/orders.test.ts
git commit -m "feat(orders): clear queued_for_replacement tag when a replacement is cancelled"
```

---

### Task 5: Untag on ship

**Files:**
- Modify: `app/src/lib/orders.ts` (~L1093-1112, `markOrderShipped`)
- Test: `app/src/lib/orders.test.ts`

`markOrderShipped` currently does not touch the ticket at all, and its `select`
only reads `order_ref, customer_email` — it must be widened.

- [ ] **Step 1: Write the failing tests**

```ts
  it('clears the queued_for_replacement tag when a replacement ships', async () => {
    // order fixture: kind 'replacement', linked_ticket_id 'ticket-s'
    await markOrderShipped('order-s', 42.5, 'CAD');
    expect(rpcMock).toHaveBeenCalledWith('remove_ticket_tag', {
      p_ticket_id: 'ticket-s', p_tag: 'queued_for_replacement',
    });
  });

  it('does not touch tickets when a non-replacement order ships', async () => {
    // order fixture: kind 'standard', linked_ticket_id null
    await markOrderShipped('order-n', 42.5, 'CAD');
    expect(rpcMock).not.toHaveBeenCalledWith('remove_ticket_tag', expect.anything());
  });
```

Match the argument order of the real `markOrderShipped` signature at
`orders.ts:1080` — read it before writing the calls above.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orders.test.ts`
Expected: FAIL on the first test — `remove_ticket_tag` was never called.

- [ ] **Step 3: Write minimal implementation**

Widen the select:

```ts
    .select('order_ref, customer_email, kind, linked_ticket_id')
```

and after the existing `logAction('order_shipped', ...)` call, append:

```ts
  // A shipped replacement is no longer "queued" — drop the tag so the Support
  // list doesn't show a stale chip. Best-effort: the shipment is already
  // recorded and must not be failed by a tag write.
  if (row.kind === 'replacement' && row.linked_ticket_id) {
    const { error: tagErr } = await supabase.rpc('remove_ticket_tag', {
      p_ticket_id: row.linked_ticket_id, p_tag: 'queued_for_replacement',
    });
    if (tagErr) console.warn('Clearing queued_for_replacement tag failed (non-fatal):', tagErr.message);
  }
```

`markOrderDelivered` needs no change — it already closes the linked ticket, and
delivery always follows shipping, so the tag is gone by then.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orders.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orders.ts app/src/lib/orders.test.ts
git commit -m "feat(orders): clear queued_for_replacement tag when a replacement ships"
```

---

### Task 6: Ticket panel — Status row drops the button, new Tags row

**Files:**
- Modify: `app/src/modules/Service/TicketDetailPanel.tsx:7` (import), `:771` (Status row), `:801` (insert Tags row)
- Test: `app/src/modules/Service/__tests__/TicketDetailPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Mirror the mock setup in `app/src/modules/Service/__tests__/SupportTab.test.tsx` (same
module, same Supabase-mocking approach). Read it first, then:

```ts
  it('does not offer Queued for Replacement as a settable status', () => {
    render(<TicketDetailPanel ticket={mkTicket({ status: 'in_progress' })} onClose={() => {}} />);
    const statusSection = screen.getByText('Status').parentElement!;
    expect(within(statusSection).queryByRole('button', { name: /Queued for Replacement/ })).toBeNull();
  });

  it('toggles a tag on and calls updateTicketTags with the union', async () => {
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'in_progress', tags: ['queued_for_replacement'] })}
      onClose={() => {}}
    />);
    const tagsSection = screen.getByText('Tags').parentElement!;
    await userEvent.click(within(tagsSection).getByRole('button', { name: /On Hold/ }));
    expect(updateTicketTagsMock).toHaveBeenCalledWith(
      't1', ['queued_for_replacement', 'on_hold'],
    );
  });

  it('toggles a tag off', async () => {
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'in_progress', tags: ['queued_for_replacement', 'on_hold'] })}
      onClose={() => {}}
    />);
    const tagsSection = screen.getByText('Tags').parentElement!;
    await userEvent.click(within(tagsSection).getByRole('button', { name: /On Hold/ }));
    expect(updateTicketTagsMock).toHaveBeenCalledWith('t1', ['queued_for_replacement']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- TicketDetailPanel`
Expected: FAIL — there is no "Tags" section, and the Status row still renders a Queued button.

- [ ] **Step 3: Write minimal implementation**

Import `WORKFLOW_STATUSES` and `updateTicketTags` alongside the existing
`TICKET_STATUSES` import at line 7-16.

Change the Status row iterator at line 771 from `TICKET_STATUSES.map` to
`WORKFLOW_STATUSES.map`. Nothing else in that block changes.

Insert a new section immediately after the Status `</div>` at line 801:

```tsx
        <div className={styles.detailSection}>
          <div
            className={styles.detailSectionLabel}
            title="Multi-select labels, independent of the workflow status. 'Queued for Replacement' is applied automatically when a replacement order is created and cleared when it ships or is cancelled."
          >Tags</div>
          <div className={styles.actionsRow}>
            {TICKET_STATUSES.map(tag => {
              const active = (ticket.tags ?? []).includes(tag);
              const m = STATUS_META[tag];
              return (
                <button
                  key={tag}
                  className={active ? styles.btnPrimary : styles.btnSecondary}
                  disabled={busy}
                  style={active ? { background: m.color, borderColor: m.color } : { color: m.color }}
                  onClick={() => {
                    // Toggle, preserving TICKET_STATUSES order so the stored
                    // array is stable regardless of click order.
                    const current = new Set(ticket.tags ?? []);
                    if (active) current.delete(tag); else current.add(tag);
                    const next = TICKET_STATUSES.filter(s => current.has(s));
                    void run(updateTicketTags(ticket.id, next));
                  }}
                >{active ? '✓ ' : ''}🏷 {m.label}</button>
              );
            })}
          </div>
        </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- TicketDetailPanel`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/Service/TicketDetailPanel.tsx app/src/modules/Service/__tests__/TicketDetailPanel.test.tsx
git commit -m "feat(service): multi-select Tags row on the ticket panel"
```

---

### Task 7: Support list still shows the queued chip from a tag

**Files:**
- Test only: `app/src/modules/Service/__tests__/SupportTab.test.tsx`

This is a regression guard, not new behaviour — `StatusPills` and the tag chip
rendering already handle it. It must be proven before the migration flips 31
live rows onto the tag path.

- [ ] **Step 1: Write the test**

```ts
  it('renders the replacement kind from a TAG, not just a status', () => {
    ticketsToReturn = [mkTicket({
      id: 't7', customer_id: 'c7', status: 'in_progress',
      tags: ['queued_for_replacement'], replacement_order_id: 'o7',
    })];
    // Mirror the replacement-order fixture the neighbouring "Queued for P100X"
    // test uses so the kind resolves.
    expect(tableText()).toContain('Queued for P100X Replacement');
  });
```

Read the existing test at `SupportTab.test.tsx:151-200` and copy its order
fixture exactly — it already asserts this text for the status path.

- [ ] **Step 2: Run it**

Run: `npm test -- SupportTab`
Expected: PASS immediately (read path already built). If it FAILS, the tag chip
path is broken and must be fixed before Task 1's backfill is applied.

- [ ] **Step 3: Commit**

```bash
git add app/src/modules/Service/__tests__/SupportTab.test.tsx
git commit -m "test(service): guard the tag-driven Queued for Replacement chip"
```

---

### Task 8: Classifier stops emitting the status

**Files:**
- Modify: `supabase/functions/_shared/classifier-llm.ts:27`, `:89`, `:101`

The LLM classifier can set `status = 'queued_for_replacement'` from message text.
Left alone it reintroduces the clobbering from a second direction — the
replacement-order workflow is authoritative for this marker.

- [ ] **Step 1: Make the change**

Line 27 — remove `'queued_for_replacement',` from the allowed-status array.

Line 89 — remove `"queued_for_replacement",` from the prompt's status enum.

Line 101 — delete the line:
`- queued_for_replacement: confirmed hardware defect, unit replacement arranged or pending`

and add above the remaining status list:

```
(A confirmed defect with a replacement arranged is 'in_progress' — the
'queued_for_replacement' marker is a TAG set by the replacement-order workflow,
never inferred from message text.)
```

- [ ] **Step 2: Verify no other reference remains**

Run (from repo root): `grep -rn "queued_for_replacement" supabase/functions/`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/classifier-llm.ts
git commit -m "fix(classifier): stop inferring queued_for_replacement as a ticket status"
```

---

### Task 9: Full verification

- [ ] **Step 1: Whole suite**

Run: `npm test`
Expected: all pass. Pay attention to `followupStatus.test.ts` and
`ticketGrouping.test.ts` — both reference `queued_for_replacement` and should be
unaffected, since `followupStatus.ts:123` and `replacementQueue.ts:15` already
read status **or** tag.

- [ ] **Step 2: Typecheck + build**

Run: `npm run build`
Expected: clean. This catches any remaining `TICKET_STATUSES` / `WORKFLOW_STATUSES`
mismatch.

- [ ] **Step 3: Lint**

Run: `npm run lint` (skip if the script does not exist)
Expected: clean.

- [ ] **Step 4: Report actual output**

Paste the real test/build output. Do not claim success without it.

---

### Task 10: Apply the migration and verify against prod

- [ ] **Step 1: Apply**

Apply `20260810120000_ticket_queued_replacement_to_tag.sql` via the repo's manual
migration workflow (migrations are not applied by pushing).

- [ ] **Step 2: Verify the backfill moved exactly the expected rows**

```sql
select status, count(*) from service_tickets group by status order by 2 desc;
-- expect: NO 'queued_for_replacement' row; waiting_on_customer 22 -> 53

select count(*) from service_tickets where 'queued_for_replacement' = any(tags);
-- expect: 31
```

- [ ] **Step 3: Verify the reported ticket**

```sql
select id, status, tags from service_tickets
 where id = '83a467cb-4caa-4c52-8a72-12a0da7bdd57';
-- expect: status 'waiting_on_customer', tags ['queued_for_replacement']
```

- [ ] **Step 4: Manual UI pass**

1. Open Manjeet Kaur's ticket. Reads `Awaiting Customer Response` +
   🏷 Queued for PARTS Replacement.
2. Click 🏷 On Hold in the Tags row. Both chips persist.
3. Change status to In Progress. The replacement tag survives — **this is the
   reported bug; it must pass.**
4. Create a replacement from another ticket sitting at Action Needed. Status
   stays Action Needed; the tag appears.
5. Ship that replacement from Order Review. The tag clears; status untouched.
6. Cancel a different queued replacement. The tag clears.

---

## Self-Review

**Spec coverage:** §1 no-op (Task 1 confirms no schema change beyond RPCs) · §2 → Task 2 · §3 → Task 6 · §4 → Task 6 · §5 → Task 3 · §6 → Tasks 4+5 · §7 → Task 8 · §8 → Tasks 1+10 · Testing → Tasks 2-7, 9-10. No gaps.

**Placeholder scan:** No TBD/TODO. Three tasks say "mirror the existing fixture" (Tasks 4, 6, 7) rather than reproducing mock setup verbatim — the named file and line range make that mechanical, and duplicating ~40 lines of Supabase mock boilerplate into the plan would go stale against the real harness.

**Type consistency:** `add_ticket_tag` / `remove_ticket_tag` with params `p_ticket_id`, `p_tag` — identical across Tasks 1, 3, 4, 5. `WORKFLOW_STATUSES` defined in Task 2, consumed in Task 6. `updateTicketTags(id, tags)` matches the existing signature at `service.ts:992`.
