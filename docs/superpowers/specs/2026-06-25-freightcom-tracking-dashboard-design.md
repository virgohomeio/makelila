# Freightcom Tracking Dashboard — Design

**Date:** 2026-06-25
**Module:** Shipping
**Status:** Approved (design), pending implementation plan

## Goal

Upgrade the existing **"All Shipments"** section inside the Shipping module's
**Shipping** tab into a tracking dashboard that pulls live status from
Freightcom and displays Freightcom's own status vocabulary (not makeLILA's
flattened internal enum).

## Context — what already exists

- Shipping module tabs: **Shipping / Invoices / Claims**
  ([app/src/modules/Shipping/index.tsx](../../../app/src/modules/Shipping/index.tsx)).
- The **Shipping** tab already renders an "All Shipments" section
  ([ShippingTab.tsx:186](../../../app/src/modules/Shipping/tabs/ShippingTab.tsx))
  backed by `useAllShipments()` in
  [lib/shipping.ts:222](../../../app/src/lib/shipping.ts). It displays the
  **internal** `shipments.status` enum (`booked, in_transit, delivered,
  exception, missing, cancelled`).
- Freightcom edge functions exist: `freightcom-quote`, `freightcom-book`,
  `freightcom-tracking`, `freightcom-invoices`. There is **no** bulk sync job.
- Freightcom's real status vocabulary is known from
  [freightcom-book STATUS_MAP](../../../supabase/functions/freightcom-book/index.ts):
  `waiting-for-transit, in-transit, delivered, exception, missing, cancelled`.
  Booking collapses `waiting-for-transit → booked`.
- Freightcom's authoritative current status is the `.state` field returned by
  `GET /shipment/{id}` (used at
  [freightcom-book/index.ts:180](../../../supabase/functions/freightcom-book/index.ts)).
  The `freightcom-tracking` endpoint returns an *event timeline*, not a state.

## Decisions (from brainstorming)

1. **Placement:** upgrade the existing "All Shipments" section in place (no new tab).
2. **Data source:** live refresh on demand — read the local `shipments` table,
   add a refresh action that pulls current status from Freightcom. No background
   cron/sync job in this scope.
3. **Status set:** the known 6 Freightcom statuses, plus an **"other"** catch-all
   that shows any unexpected value verbatim.
4. **Architecture:** dedicated `freightcom-status` edge function that fetches the
   live `.state` and **persists** it to the DB (Approach A), so refreshed status
   is shared across users and survives reload.

## Section 1 — Status vocabulary (shared contract)

In [lib/shipping.ts](../../../app/src/lib/shipping.ts):

```ts
export const FREIGHTCOM_STATUSES = [
  'waiting-for-transit', 'in-transit', 'delivered',
  'exception', 'missing', 'cancelled',
] as const;
export type FreightcomStatus = typeof FREIGHTCOM_STATUSES[number];
```

**Display status resolution** (`displayFreightcomStatus(row)`):
1. If `freightcom_status` (raw stored value) is set → use it.
2. Else reverse-map the internal `status`: `booked → waiting-for-transit`,
   `in_transit → in-transit`, all others 1:1.
3. Any value not in `FREIGHTCOM_STATUSES` is shown verbatim and grouped under
   the **"other"** filter chip — never silently dropped.

## Section 2 — Data model

Additive migration on `shipments` (nullable, no backfill):

```sql
alter table public.shipments
  add column if not exists freightcom_status text;        -- raw FC .state verbatim
alter table public.shipments
  add column if not exists status_synced_at  timestamptz; -- last live pull time
```

The internal `status` enum is unchanged — booking, claims, and the Shipping
queue still depend on it. The raw status is stored **alongside**, not replacing.

## Section 3 — Edge function `freightcom-status`

New function under `supabase/functions/freightcom-status/`, mirroring the
auth/CORS/error pattern of `freightcom-tracking`.

- **Input:** `{ shipments: [{ id, freightcom_shipment_id }] }` (batch).
- **Action:** for each entry, `GET /shipment/{freightcom_shipment_id}` and read
  `.state`. Throttle (~5 req/sec) to respect rate limits. A per-shipment failure
  records an error for that entry and continues the batch.
- **Write-back:** updates each `shipments` row's `freightcom_status` and
  `status_synced_at` using the service-role client (persists for all users).
- **Output:** `{ results: [{ id, freightcom_status, error? }] }`.
- **Auth:** internal-user gate (`profiles.is_internal`), identical to the other
  Freightcom functions.

## Section 4 — Data layer (lib/shipping.ts)

- Extend `AllShipmentRow` and the `useAllShipments` select to include
  `freightcom_status` and `status_synced_at`.
- Add `refreshFreightcomStatuses(rows)` — invokes the `freightcom-status`
  edge function, then re-fetches the affected rows; calls
  `logAction('shipment_status_refreshed', …)`.
- Add `displayFreightcomStatus(row)` implementing Section 1's resolution rule.

## Section 5 — UI (upgrade "All Shipments" section)

Within [ShippingTab.tsx](../../../app/src/modules/Shipping/tabs/ShippingTab.tsx)
"All Shipments" section:

- **Filter chips:** `All` + the 6 Freightcom statuses + `Other`, each with a count.
- **Status badge:** shows the Freightcom label (e.g. `in-transit`); badge colors
  reuse the existing CSS-module status classes, mapped from the internal equivalent.
- **Refresh:** a **"↻ Refresh from Freightcom"** button refreshes all visible
  rows; a per-row refresh icon refreshes one. Show a spinner during the call and
  an "as of {status_synced_at}" timestamp per row.
- **Columns:** Order · Customer · Carrier · Tracking # · Freightcom status ·
  Synced-at. Tracking # links to the existing per-order tracking timeline
  (`TrackingTab`).
- **Errors:** inline banner (reusing the tab's existing error styling). Partial
  batch failures show a per-row warning without blocking other rows.

## Section 6 — Testing

- `lib/shipping.test.ts`: unit-test `displayFreightcomStatus` — stored value
  wins; fallback reverse-mapping; unknown value → "other".
- Component test: filter chips filter correctly; refresh button calls the
  mutation; "as of" timestamp renders.
- Edge function: not unit-tested (consistent with the existing Freightcom
  functions); validated manually against a known shipment id.

## Out of scope

- Background cron/bulk sync of all Freightcom shipments (incl. historical P100
  shipments booked directly in Freightcom). Possible follow-up; explicitly not
  in this scope.
- Changing the internal `shipments.status` enum or how booking writes it.
- New top-level "All Shipments" tab (decided against — upgrade in place).
