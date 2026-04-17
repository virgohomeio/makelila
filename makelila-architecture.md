# makelila — Web App Architecture

> Cloud-native replacement for the VirgoHome Operations Hub Excel file.
> Powered by Supabase (Postgres + Edge Functions + Realtime + Auth) on the backend, Next.js + React on the frontend.
> Feature scope derived from `katana-prd.md` and `architecture.md` gap analysis.

---

## 1. Design Principles

1. **Pick Katana's wins, keep Excel's wins.** Copy Katana's module decomposition, but preserve the HubSpot-ticket-to-serial cross-reference that the Excel sheet does better than Katana does.
2. **Operations-first, not finance-first.** Production flow, shipment traceability, and reorder alerts are the core loops. Revenue reporting is a side effect.
3. **Real-time by default.** Everywhere the Excel file needs a manual pull, Supabase Realtime streams updates to the browser.
4. **Single-tenant to start.** VirgoHome only. A tenant column can be added later if the product is productized.
5. **Optimize for the factory-produced, serial-tracked SMB.** Not for multi-plant manufacturers. The MVP ignores Shop Floor / MES entirely.

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Database | **Supabase Postgres** | Already provisioned. RLS, row-level realtime, full SQL. |
| Auth | **Supabase Auth** (email + Google SSO) | Built-in, matches VirgoHome team size. |
| API | **Supabase auto-generated REST + Edge Functions** | Free tier covers everything until ~1M requests/mo. |
| Background jobs | **Supabase Edge Functions + pg_cron** | Shopify poll, HubSpot sync, Freightcom tracking refresh. |
| Realtime | **Supabase Realtime** (`postgres_changes`) | Pushes inventory/SO changes to all connected clients. |
| Frontend | **Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui** | Modern React with SSR for list views. |
| State | **TanStack Query** for server state, **Zustand** for UI state | Avoids Redux complexity. |
| Deployment | **Vercel** (frontend) + Supabase (backend) | Git push to deploy. |
| File uploads | **Supabase Storage** | Photos for QA, damage claims, ticket attachments. |
| Webhooks | Shopify + HubSpot → **Supabase Edge Function** `/hooks/*` | Signed HMAC verification. |
| Email | **Resend** | Low-volume transactional (shipping notices already go via Shopify). |

---

## 3. Data Model (Supabase Postgres)

Mapping from Excel tabs → Supabase tables. Every table has `id uuid`, `created_at`, `updated_at`, and a soft-delete `deleted_at`. RLS enabled on all tables.

### Core tables

```
products                     (Excel: Products tab)
  id, sku (unique), name, category, description, selling_price, currency,
  unit_cost, weight_kg, dimensions, shopify_product_id, hubspot_product_id,
  active, reorder_point, reorder_qty, lead_time_days, min_order_qty,
  primary_supplier_id → suppliers.id

inventory_locations         (Excel: Settings.Warehouses)
  id, code (unique), name, address, location_type (primary/secondary/fulfillment)

inventory                    (Excel: Inventory tab)
  id, product_id → products.id, location_id → inventory_locations.id,
  on_hand_qty, committed_qty, expected_qty, safety_stock,
  batch_lot, expiry_date, last_count_at, notes
  -- available_qty, stock_status, days_on_hand, reorder_alert are VIEWS (computed)

customers                    (Excel: Customers tab)
  id, contact_name, company_name, email, phone, billing_address,
  shipping_address, shopify_customer_id, hubspot_contact_id,
  channel, payment_terms, notes
  -- total_orders, total_revenue, last_order_date via VIEW

sales_orders                 (Excel: Sales Orders tab — header only)
  id, so_number (unique), order_date, channel, channel_order_id,
  customer_id → customers.id, status, payment_status, fulfillment_status,
  warehouse_id → inventory_locations.id, ship_by_date, shipped_date,
  tracking_number, notes, return_status, rma_number, return_reason,
  total_amount, currency

sales_order_lines            (NEW — proper 1-to-many, fixes Excel packed-cell problem)
  id, sales_order_id → sales_orders.id, product_id → products.id,
  qty_ordered, qty_shipped, unit_price, line_total (generated),
  serial_number_id → serial_numbers.id (nullable — set at pick)

suppliers                    (Excel: Vendors & POs — vendor columns)
  id, name, contact_name, email, phone, lead_time_days, min_order_qty,
  currency, payment_terms, quality_rating, on_time_delivery_pct, notes

purchase_orders              (Excel: Vendors & POs tab — PO columns)
  id, po_number (unique), po_date, supplier_id → suppliers.id,
  status, expected_delivery, actual_delivery, payment_terms,
  freight_cost, invoice_number, notes

purchase_order_lines
  id, purchase_order_id, product_id, qty_ordered, qty_received,
  unit_cost, line_total (generated)

make_orders                  (Excel: Make Orders tab)
  id, mo_number (unique), product_id, bom_version, qty_to_make,
  qty_completed, qty_scrap, status, priority, created_date, due_date,
  start_date, end_date, assigned_to, qa_approved_by, qa_approved_at,
  linked_so_id → sales_orders.id, warehouse_id, notes

boms                         (Excel: BOMs tab — header rows)
  id, bom_id (unique), product_id, version, effective_date, status, notes

bom_components               (Excel: BOMs tab — component rows)
  id, bom_id → boms.id, parent_component_id (self-ref, nullable) -- multi-level!
  component_product_id → products.id, qty_per_unit, uom,
  wastage_pct, sequence, notes

shipments                    (Excel: Shipping & Tracking tab)
  id, shipment_id (unique), sales_order_id, ship_date, carrier, service_level,
  origin_location_id, destination_address, weight_kg, dimensions,
  status, tracking_number, freightcom_quote_id, quoted_rate, actual_cost,
  est_delivery_date, actual_delivery_date, recipient_name, recipient_phone,
  delivery_signature, notes

serial_numbers               (Excel: Serial Tracker tab — first-class table)
  id, serial_number (unique), product_id, batch_lot,
  manufacture_date, manufacture_mo_id → make_orders.id,
  current_status, current_location_id, current_customer_id,
  current_shipment_id, warranty_expiry (generated: ship_date + 2y)

support_tickets              (NEW — supplements HubSpot, not replaces)
  id, hubspot_ticket_id, subject, pipeline_stage,
  serial_number_id → serial_numbers.id, customer_id,
  content, hs_last_modified, notes

audit_log                    (NEW — closes Excel gap #8)
  id, actor_user_id, table_name, record_id, action (INSERT/UPDATE/DELETE),
  changed_at, old_values jsonb, new_values jsonb

attachments                  (Uses Supabase Storage)
  id, table_name, record_id, storage_path, mime_type, uploaded_by, caption
```

### Views (computed, no storage)

```sql
-- Inventory view: applies the formulas that live in the Excel sheet today
CREATE VIEW inventory_live AS
SELECT
  i.*,
  (i.on_hand_qty - i.committed_qty) AS available_qty,
  CASE
    WHEN (i.on_hand_qty - i.committed_qty) <= 0 THEN 'OUT'
    WHEN (i.on_hand_qty - i.committed_qty) <= p.reorder_point THEN 'LOW'
    ELSE 'OK'
  END AS stock_status,
  CASE
    WHEN (i.on_hand_qty - i.committed_qty) <= 0 THEN 'ORDER NOW'
    WHEN (i.on_hand_qty - i.committed_qty) <= p.reorder_point THEN 'REORDER'
    ELSE 'OK'
  END AS reorder_alert,
  p.lead_time_days, p.reorder_qty, p.reorder_point
FROM inventory i JOIN products p ON p.id = i.product_id;

-- Dashboard KPIs (materialized, refreshed every 5 min by pg_cron)
CREATE MATERIALIZED VIEW dashboard_kpis AS
SELECT
  (SELECT COUNT(*) FROM sales_orders WHERE status = 'Open') AS open_sales_orders,
  (SELECT SUM(total_amount) FROM sales_orders WHERE status = 'Open') AS pending_revenue,
  (SELECT COUNT(*) FROM inventory_live WHERE stock_status IN ('LOW','OUT')) AS low_stock_alerts,
  (SELECT COUNT(*) FROM purchase_orders WHERE expected_delivery < CURRENT_DATE AND status != 'Received') AS overdue_pos,
  (SELECT COUNT(*) FROM serial_numbers WHERE current_status = 'Shipped') AS serials_in_field,
  (SELECT COUNT(*) FROM support_tickets WHERE pipeline_stage != '4') AS open_tickets,
  (SELECT SUM(so.total_amount) FROM sales_orders so WHERE so.order_date >= CURRENT_DATE - 30) AS revenue_30d
  -- ... etc
;
```

### Functions / Triggers

- `trg_commit_inventory_on_so()` — when SO line is confirmed, increment `inventory.committed_qty`.
- `trg_release_inventory_on_so_cancel()` — reverse of above.
- `trg_decrement_inventory_on_shipment()` — when shipment status → Delivered.
- `trg_increment_inventory_on_po_receipt()` — when PO line `qty_received` updated.
- `trg_audit()` — generic audit trigger on all mutating tables.
- `fn_explode_bom(product_id, qty)` — recursive CTE returning total raw-material requirements. Closes Excel gap #7.
- `fn_reorder_suggestions()` — returns rows needing reorder with suggested PO drafts.

### Row-Level Security

Single-tenant for now, but RLS makes adding tenancy trivial later.

```sql
-- Every user can read everything (small team)
-- Only staff role can write
CREATE POLICY "staff_all" ON sales_orders FOR ALL
  TO authenticated USING (auth.jwt() ->> 'role' = 'staff');
```

---

## 3b. Ashwini's Feedback — Team Coverage (2026-04-12)

Ashwini audited the MRP against what each team member actually does day-to-day. Four people were not covered at all; three more had workflows fragmented across ad-hoc files. The schema now absorbs all of it.

| # | Gap | Owner | Fix in schema |
|---|---|---|---|
| 1 | Fulfillment split across CA/US/Personal/Hold/Returns tabs | Raymond & Aaron | `sales_orders.region` + `fulfillment_queue` view |
| 2 | Replacements buried in notes | Raymond & Aaron | `sales_orders.replacement_batch`, `replacement_serial_id`, `replacement_reason` |
| 3 | Customer follow-up calendar separate | Ash | New `customer_followups` table |
| 4 | Team task escalation in free-text cells | Ash | New `team_tasks` table with structured status |
| 5 | Marketing campaigns in per-campaign files | Pedrum | New `campaigns` table |
| 6 | Repair jobs via text message | Junaid | New `repair_tickets` table linked to `serial_numbers` |
| 7 | No SO → campaign attribution | Pedrum | `sales_orders.campaign_id` FK |
| 8 | Serial Tracker missing software version | Ash | `serial_numbers.software_version`, `on_dashboard` |
| 9 | Shipping weight/dims frequently blank | Raymond & Aaron | New KPI `shipments_missing_weight` + UI required-field guard |

### Module summary

```
customer_followups   (Ash's follow-up calendar consolidated)
  customer_id → customers.id, serial_number_id → serial_numbers.id,
  ship_date, onboarding_date,
  followup_1_date, followup_1_notes, followup_2_date, followup_2_notes,
  compost_made, review_submitted (Yes/No/Pending), review_platform,
  software_version, on_dashboard,
  action_item, action_due_date

team_tasks           (replaces "To Ask Team Members" tab)
  task_number, date_raised, raised_by → auth.users, raised_by_name,
  assigned_to → auth.users, assigned_to_name,
  customer_id → customers.id, sales_order_id → sales_orders.id,
  description, status (Open/In Progress/Resolved/Irrelevant), reply_date, notes

campaigns            (Pedrum's per-campaign files unified)
  campaign_code, name, start_date, end_date, channel,
  creative_version, discount_code, target_regions text[],
  buyers, revenue, country_split jsonb, avg_order_value,
  plan_breakdown jsonb (Outright/12mo/36mo/Sezzle)

repair_tickets       (replaces Junaid's text messages)
  ticket_number, date_opened, raised_by_name,
  serial_number_id → serial_numbers.id, customer_id → customers.id,
  problem_description, batch, repair_type (Hardware/Software/Firmware),
  parts_needed, status (Open/In Progress/Resolved/Scrapped),
  date_resolved, resolution_notes, signed_off_by
```

### Column additions

```
sales_orders   + region (CA/US/Personal/Hold/International)
               + replacement_batch, replacement_serial_id, replacement_reason
               + campaign_id → campaigns.id

serial_numbers + software_version (V15/V16/V17…)
               + on_dashboard (boolean)
```

### New view

```sql
fulfillment_queue   -- unified CA/US/Personal/Hold/Returns for Raymond & Aaron
  all SOs where status in ('Open','In Progress','Shipped')
  OR return_status is not null OR region = 'Hold'
```

### New dashboard KPIs

`open_team_tasks`, `open_repair_tickets`, `followups_due_week`, `active_campaigns`, `shipments_missing_weight`.

---

## 4. API Layer

### Auto-generated REST (PostgREST)
Covers 90% of CRUD — frontend queries tables/views directly via Supabase JS client with RLS enforcement.

### Edge Functions (custom logic)

```
supabase/functions/
  hooks-shopify/          POST /functions/v1/hooks-shopify
    HMAC-verified Shopify webhook. Upserts sales_orders + sales_order_lines.

  hooks-hubspot/          POST /functions/v1/hooks-hubspot
    HubSpot ticket.created / ticket.updated → support_tickets table.

  jobs-shopify-poll/      GET  (scheduled every 15 min by pg_cron)
    Safety-net backfill — pulls Shopify orders updated in last 30 min.

  jobs-hubspot-poll/      GET  (scheduled every 15 min)
    Pulls open HS tickets, matches to serial_numbers.

  jobs-freightcom-track/  GET  (scheduled hourly)
    For every shipment with status ≠ Delivered, refreshes carrier status.

  action-create-po/       POST (authenticated)
    Accepts an array of reorder-suggestion IDs, drafts POs.

  action-push-fulfillment/ POST (authenticated)
    When shipment marked Shipped: pushes tracking to Shopify + sends email.

  bom-explode/            GET  /functions/v1/bom-explode?product=VH-100&qty=10
    Returns the flattened component list across all BOM levels.
```

### Realtime Channels
- `postgres_changes` on `inventory`, `sales_orders`, `shipments`, `serial_numbers` → browser subscribes, KPI dashboard updates instantly.

---

## 5. Frontend (Next.js App Router)

```
app/
  layout.tsx                  (shell with sidebar + topbar)
  page.tsx                    → /dashboard (KPI cockpit + recent activity)

  sales-orders/
    page.tsx                  (list + filters)
    [id]/page.tsx             (SO detail — lines, fulfillment, tracking, returns)
    new/page.tsx              (manual order entry — B2B/phone)

  inventory/
    page.tsx                  (by location + reorder alerts)
    [sku]/page.tsx            (SKU detail — on-hand by location, trend, BOM usage)
    movements/page.tsx        (stock movement log)

  make-orders/
    page.tsx                  (kanban: Planned/In Progress/Done)
    [id]/page.tsx             (MO detail — BOM explosion, materials, serials)

  purchase-orders/
    page.tsx                  (active POs + reorder suggestions)
    [id]/page.tsx             (PO detail — receipt flow, 3-way match)

  products/
    page.tsx                  (catalog)
    [sku]/page.tsx            (product + BOM tree editor)

  shipments/
    page.tsx                  (Freightcom — quotes, labels, tracking)
    [id]/page.tsx             (shipment detail + serial assignment)

  serial-tracker/
    page.tsx                  (searchable — by serial, customer, batch)
    [serial]/page.tsx         (full lifecycle: MO → location → customer → tickets)

  customers/
    page.tsx                  (list)
    [id]/page.tsx             (detail — orders, serials owned, tickets)

  settings/
    locations/page.tsx
    integrations/page.tsx     (Shopify, HubSpot, Freightcom, QuickBooks status)
    users/page.tsx
    audit-log/page.tsx

components/
  ui/                         (shadcn/ui primitives)
  charts/                     (Recharts wrappers)
  tables/                     (TanStack Table wrappers with CSV export)
  KPI-card.tsx
  StatusPill.tsx              (OK / LOW / OUT / OVERDUE styling)
  BarcodeInput.tsx            (accepts USB scanner + mobile camera)
  ShopifyBadge.tsx            (shows sync freshness)

lib/
  supabase/
    server.ts                 (server component client)
    client.ts                 (browser client)
    types.ts                  (generated from DB schema)
  api/
    bom.ts                    (explode, cost roll-up)
    serials.ts                (assign, reassign, trace)
```

---

## 6. Integration Architecture

```
                          ┌──────────────┐
                          │   Shopify    │
                          └──┬─────────▲─┘
        webhook orders/create │         │ fulfillments.json
                              ▼         │
                    ┌─────────────────────────┐
                    │ Edge Fn hooks-shopify   │
                    │ (HMAC verify, upsert)   │
                    └──────────────┬──────────┘
                                   │
                          ┌────────▼────────┐
                          │  Supabase DB    │◄────────┐
                          │  (source of     │         │
                          │   truth)        │         │
                          └─────────────────┘         │
                                   ▲                  │
                           postgres_changes           │
                                   │                  │
       ┌───────────────────┐   ┌───▼─────┐   ┌────────┴────────────┐
       │  HubSpot          │   │ Browser │   │  Freightcom         │
       │  (tickets)        │   │ Realtime│   │  (rates, labels)    │
       └─┬──────────────▲──┘   └─────────┘   └─┬────────────────▲──┘
         │ ticket hook  │                      │ fetch on demand │
         │              │                      │ + hourly poll   │
         ▼              │                      ▼                 │
  ┌─────────────────────┴───┐            ┌─────────────────────┴───┐
  │ Edge Fn hooks-hubspot   │            │ Edge Fn freightcom-track│
  └─────────────────────────┘            └─────────────────────────┘
```

HubSpot tickets sync into `support_tickets` **and** link to `serial_numbers` via the `serial_number_id` FK — preserving the Excel sheet's unique cross-reference that plain Katana doesn't offer.

---

## 7. Auth & Roles

| Role | Scope |
|---|---|
| `admin` | All tables read/write, settings, user management |
| `staff` | All ops tables read/write; no settings, no user management |
| `warehouse` | Inventory + shipments write; SO/PO read |
| `finance` | SO/PO read, reporting views read; no operational writes |
| `viewer` | Read-only across all ops (useful for investors, factory partners) |

Role stored in `auth.users.app_metadata.role`. Enforced via RLS policies on every table.

---

## 8. Deployment & Environments

| Env | Supabase project | Vercel deployment | Data |
|---|---|---|---|
| `dev` | project `txeftbbzeflequvrmjjr` (current) | Vercel preview (per-PR) | Seeded snapshot |
| `staging` | New Supabase free-tier project | Vercel staging branch | Weekly restore from prod |
| `prod` | New Supabase paid project ($25/mo Pro) | Vercel production (main) | Real data |

CI/CD: GitHub Actions → `supabase db push` for migrations, Vercel auto-deploys on push.

---

## 9. MVP Phasing

| Phase | Weeks | Scope | Criteria to ship |
|---|---|---|---|
| **P0 — Read-only cockpit** | 1–2 | Dashboard + Sales Orders list + Inventory list + Serial Tracker + Shipments, seeded with Excel import | Team replaces "open the sheet" with "open makelila" for daily review |
| **P1 — Write paths** | 3–4 | Create/edit SO, PO, MO, shipments, serials. Audit log. Auth. | Team stops editing the Excel file |
| **P2 — Integrations** | 5–6 | Shopify webhook + push-back, HubSpot ticket sync, Freightcom API | Manual Shopify chrome pulls retired |
| **P3 — Planning & BOM** | 7–8 | BOM editor with multi-level tree, explode on MO create, reorder suggestions auto-draft POs | Reorder decisions no longer require a spreadsheet |
| **P4 — Polish** | 9–10 | Barcode input (USB + camera), mobile shipment-pick view, CSV export, QB export | Warehouse staff use on a tablet |

Excel file retained as monthly read-only export throughout — no hard cutover required.

---

## 10. What This Architecture Solves (vs. Excel limits)

| Excel limit (architecture.md §5.1) | How makelila fixes it |
|---|---|
| #1 No real-time sync | Edge Function webhook + Realtime channels |
| #2 No referential integrity | Postgres FKs on every relationship |
| #3 No multi-user concurrency | Postgres MVCC, RLS, optimistic UI |
| #4 No event-driven triggers | DB triggers + pg_cron + Edge Function schedulers |
| #5 No mobile / offline | Responsive PWA, offline cache via TanStack Query |
| #6 No barcode input | `BarcodeInput` component using `BarcodeDetector` API + USB HID |
| #7 No BOM auto-explosion | `fn_explode_bom()` recursive CTE |
| #8 No audit trail | `audit_log` table + generic trigger |
| #9 No API | PostgREST + Edge Functions |
| #10 No RBAC | Supabase Auth + RLS by role |

What remains genuinely hard: **barcode scanning hardware parity with Katana's Warehouse app** (we get 80% with WebUSB + camera, not 100%). **Shop Floor MES** — intentionally out of scope (VirgoHome doesn't run its own factory).

---

*Sources: `katana-prd.md`, `architecture.md`, `Virgo_Operations_Hub_MRP.xlsx` schema.*
*Supabase project: `txeftbbzeflequvrmjjr`.*
