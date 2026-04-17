# VirgoHome Operations Hub — Architecture

> Structural map of `Virgo_Operations_Hub_MRP.xlsx` (post–Katana-PRD iteration) plus a gap analysis against Katana MRP to surface the limitations of an Excel-based implementation.
>
> Last updated: April 2026 · Workbook: 11 tabs, 174 formulas, 0 errors

---

## 1. Workbook Overview

| # | Tab | Rows | Cols | Formulas | Role |
|---|-----|------|------|----------|------|
| 1 | Dashboard | 35 | 4 | 47 | KPI cockpit + demand forecast + module index |
| 2 | Sales Orders | 53 | 22 | 0 | Customer demand — 50 real Shopify orders |
| 3 | Inventory | 9 | 21 | 30 | Stock per SKU per location, reorder logic |
| 4 | Make Orders | 7 | 18 | 4 | Production runs (manufacturing orders) |
| 5 | Vendors & POs | 8 | 23 | 25 | Supplier records + purchase orders |
| 6 | BOMs | 15 | 19 | 24 | Multi-level bill of materials, cost rollup |
| 7 | Serial Tracker | 57 | 14 | 39 | Per-unit traceability (NEW) |
| 8 | Shipping & Tracking | 79 | 20 | 0 | 76 real fulfillment records, carrier + tracking |
| 9 | Products | 8 | 20 | 5 | Master SKU catalog + planning params |
| 10 | Customers | 53 | 15 | 0 | Contact master, synced from Shopify/HubSpot |
| 11 | Settings | 50 | 5 | 0 | Locations, integration config, QB mapping |

**Data volume:** 50 sales orders, 76 shipments, 39 tracked serials, 24 HubSpot ticket cross-refs, 6 inventory rows, 2 BOMs.

**Conventions:** Arial font throughout. Dark-blue header fill (`#1F4E79`) with white bold text. Row-level thin borders (`#B4C6E7`). Conditional formatting drives red/yellow/green status on Stock Status, Reorder Alert, Overdue POs, and HubSpot ticket rows.

---

## 2. Tab-by-Tab Structure

### 2.1 Dashboard (35 rows, 47 formulas)

Three-section KPI cockpit driven entirely by cross-sheet formulas:

**Section A — Operational KPIs (rows 4–24):** 20 metrics with live formulas.

| Metric | Formula | Source |
|---|---|---|
| Open Sales Orders | `COUNTIF('Sales Orders'!K4:K100,"Open")` | SO Status |
| Total SO Revenue (pending) | `SUMPRODUCT` on Open × Total | SO Status × Amount |
| Total SKUs in Inventory | `COUNTA(Inventory!A4:A500)` | Inventory |
| Low Stock Alerts | `COUNTIF(Inventory!J4:J500,"LOW")` | Inventory Status |
| Open Make Orders | `COUNTIF` In Progress + Planned | MO Status |
| Open Purchase Orders | `COUNTIF` Open + Partial | PO Status |
| Shipments In Transit | `COUNTIF('Shipping & Tracking'!J,"In Transit")` | Shipping |
| Active BOMs | `COUNTA(BOMs!A4:A500)` | BOMs |
| Total Customers | `COUNTA(Customers!A4:A500)` | Customers |
| Total Products | `COUNTA(Products!A4:A500)` | Products |
| Inventory Value | `SUMPRODUCT(Inventory!E × Inventory!K)` | On Hand × Unit Cost |
| Revenue (30 days) | `SUMPRODUCT` with DATEVALUE, Delivered filter | SO |
| Fulfilled (30 days) | `SUMPRODUCT` with DATEVALUE, Fulfilled filter | SO |
| Avg Order Value | `AVERAGE('Sales Orders'!I4:I100)` | SO Total |
| Low Stock Alert Count | `COUNTIF` REORDER + ORDER NOW | Inventory!U |
| Overdue Purchase Orders | `COUNTIF('Vendors & POs'!W,">"&0)` | PO Days Overdue |
| Predicted Days to Stockout | `MIN(Inventory!T4:T100)` | Days on Hand |
| Active Serials Tracked | `COUNTA` minus pending | Serial Tracker |
| Open HubSpot Tickets | `COUNTA('Serial Tracker'!M4:M57)` | Serial Tracker |
| Units Pending Shipment | `COUNTIF('Shipping & Tracking'!J,"Pending")` | Shipping Status |

**Section B — Demand Forecast (rows 27–35):** Rolling 30/60/90-day order counts, daily rate, projected monthly demand, months-of-inventory runway, revenue velocity ($/day). Uses `DATEVALUE` on text-formatted SO dates.

**Section C — Module Reference (rows 28+):** Nine-row index listing each module with integration + description.

### 2.2 Sales Orders (53 rows, 22 cols, 0 formulas)

Pure data tab. 50 real Shopify orders (#1062–#1111).

Columns: SO Number, Order Date, Channel, Channel Order ID, Customer Name, Customer Email, Products (SKUs), Qty, Total Amount, Currency, Status, Payment Status, Fulfillment Status, Assigned Warehouse, Make Order Ref, Ship By Date, Shipped Date, Tracking Number, Notes, **Return Status, RMA Number, Return Reason** (new).

Cross-references: Customer Name → Customers, Make Order Ref → Make Orders, Tracking Number → Shipping & Tracking. Notes field also embeds HubSpot ticket IDs (`HS-00XX`).

### 2.3 Inventory (9 rows, 21 cols, 30 formulas)

Formula-heavy core of the planning logic.

Columns 1–16 (existing): SKU, Product Name, Category, Location, On Hand Qty, Committed Qty, **Available Qty** (`=E-F`), Expected Qty, Reorder Point, **Stock Status** (`IF(G<=0,"OUT",IF(G<=I,"LOW","OK"))`), Unit Cost, **Total Value** (`=E*K`), Batch/Lot, Expiry Date, Last Updated, Notes.

Columns 17–21 (Katana-PRD additions): Lead Time (days), Reorder Qty, Safety Stock, **Days on Hand** (`=E/(F/7)`), **Reorder Alert** (`ORDER NOW` / `REORDER` / `OK`).

Conditional formatting: Stock Status and Reorder Alert cells auto-colour red/yellow/green.

### 2.4 Make Orders (7 rows, 18 cols, 4 formulas)

Production order tracking. Single formula: `% Complete = Qty Completed / Qty to Make`.

Columns: MO Number, Created Date, Product SKU, Product Name, BOM Version, Qty to Make, Qty Completed, % Complete, Start Date, Status, Due Date, Assigned To, Materials Status, Labor Hours Est, Labor Hours Actual, Production Notes, Linked SO, Warehouse.

Status values: Planned, In Progress, Completed.

### 2.5 Vendors & POs (8 rows, 23 cols, 25 formulas)

Purchase order ledger with supplier detail inline.

Core PO cols: PO Number, PO Date, Vendor Name/Contact/Email, Item SKU/Description, Qty Ordered, Unit Cost, Currency, **Total Cost** (`=H*I`), PO Status, Expected/Actual Delivery, **Lead Time** (`=N-B`), Payment Terms, Freight Cost, **Landed Cost/Unit** (`=(K+Q)/H`), Quality Rating, Notes.

Katana-PRD additions: Qty Received, **Receipt Variance** (`=U-H`), **Days Overdue** (conditional formula — 0 if Received, else `TODAY()-M` when past due).

Red conditional highlight on Days Overdue > 0.

### 2.6 BOMs (15 rows, 19 cols, 24 formulas)

Multi-level bill of materials for VH-100 (Smart Hub, 6 components) and VH-300 (Security Cam, 4 components).

Row structure: Level-0 row = Finished Good header; Level-1 rows = component list. Rollup: finished-good **Extended Cost** = `SUM` of component K range.

Key cols: BOM ID, Product SKU, Product Name, Version, Level, Component SKU, Component Name, Qty Per Unit, UoM, Component Cost, **Extended Cost** (`=H*J`), Supplier, Lead Time, Wastage %, Effective Date, Status, Notes, **Parent Assembly** (new), **Adjusted Qty w/ Waste** (new: `=H/(1-N/100)`).

### 2.7 Serial Tracker (57 rows, 14 cols, 39 formulas) — NEW

Per-unit traceability tab introduced from the Katana PRD.

Columns: Serial Number, SKU, Batch/Lot (P50N/P100/P150 inferred from serial range), Manufacture Date, Ship Date, Customer Name, Customer Phone, Destination, Carrier, Tracking Number, Shipment ID, Status, HubSpot Ticket, **Warranty Expiry** (`=E+730` — 2-year default).

39 real serials + 15 pending rows (tickets open but no serial assigned yet). Yellow-highlight rule on HubSpot Ticket column.

### 2.8 Shipping & Tracking (79 rows, 20 cols, 0 formulas)

76 real Freightcom shipments. Notes column encodes serial number and HubSpot ticket references with `|` separators.

Columns: Shipment ID, SO Number, Ship Date, Carrier, Service Level, Origin, Destination, Weight, Dimensions, Status, Tracking Number, Freightcom Quote ID, Quoted Rate, Actual Cost, Est/Actual Delivery, Recipient Name/Phone, Delivery Signature, Notes.

Carriers represented: UPS, Canpar, Purolator, FedEx. Status values: Delivered, In Transit, Pending.

### 2.9 Products (8 rows, 20 cols, 5 formulas)

Master SKU catalog. 5 products (VH-100 through VH-500).

Core cols: SKU, Product Name, Category, Description, Selling Price, Currency, Unit Cost (BOM), **Margin %** (`=(E-G)/E`), Shopify Product ID, HubSpot Product ID, Weight, Dimensions, Active, Created/Modified Dates.

Katana-PRD additions: Reorder Point, Reorder Qty, Lead Time, Min Order Qty, Primary Supplier.

### 2.10 Customers (53 rows, 15 cols, 0 formulas)

50 customer records imported from Shopify + HubSpot.

Columns: Customer ID, Company Name, Contact Name, Email, Phone, Billing Address, Shipping Address, Shopify Customer ID, HubSpot Contact ID, Channel, Total Orders, Total Revenue, Last Order Date, Payment Terms, Notes.

### 2.11 Settings (50 rows, 5 cols, 0 formulas)

Configuration registry with five sub-sections:

1. **Warehouse Locations** (Toronto-01, Vancouver-01, Calgary-01)
2. **Integration Configuration** (Shopify, HubSpot, Freightcom endpoints)
3. **Freightcom Configuration** (API key, default origin, carrier prefs, tracking poll, label format)
4. **Shopify Sync Rules** (import, fulfillment sync, inventory sync, new product/customer sync)
5. **HubSpot Sync Rules** (deal→SO trigger, pipeline, contact sync, status back-propagation)
6. **QuickBooks Account Mapping** (7 event→account mappings with GL codes)

---

## 3. Data Flow & Cross-Tab Dependencies

```
                 ┌──────────────┐
                 │   Shopify    │ (external)
                 └──────┬───────┘
                        │ webhook
                        ▼
┌────────────┐   ┌──────────────┐   ┌──────────────┐
│  Products  │◄──┤ Sales Orders ├──►│  Customers   │
│   (SKU)    │   │   (SO.Cust)  │   │  (lookup)    │
└─────┬──────┘   └──────┬───────┘   └──────────────┘
      │                 │
      │ SKU             │ SO.Qty triggers
      ▼                 ▼
┌────────────┐   ┌──────────────┐   ┌──────────────┐
│    BOMs    │◄──┤  Inventory   ├──►│ Make Orders  │
│ (multi-lvl)│   │ (committed)  │   │   (MO.SKU)   │
└─────┬──────┘   └──────┬───────┘   └──────┬───────┘
      │                 │                   │
      │ shortage        │ reorder pt        │ BOM consumption
      ▼                 ▼                   │
┌────────────┐   ┌──────────────┐           │
│ Vendors &  │──►│  PO receipt  │           │
│    POs     │   │  increments  │           │
└────────────┘   └──────────────┘           │
                        ▲                   │
                        │                   │
                 ┌──────┴───────┐           │
                 │  Shipping &  │◄──────────┘
                 │   Tracking   │   SO fulfillment
                 └──────┬───────┘
                        │ Serial + HS Ticket
                        ▼
                 ┌──────────────┐
                 │   Serial     │──► HubSpot (manual cross-ref)
                 │   Tracker    │
                 └──────────────┘
                        ▲
                        │ all KPIs feed up
                 ┌──────┴───────┐
                 │  Dashboard   │
                 └──────────────┘
```

**Primary keys:** SKU (Products), SO Number (Sales Orders), MO Number (Make Orders), PO Number (POs), BOM ID (BOMs), Serial Number (Serial Tracker), Shipment ID (Shipping), Customer ID (Customers).

**Implicit joins (no referential integrity):** Sales Orders.Customer Name → Customers.Contact Name (string match, not ID), Serial Tracker.Shipment ID → Shipping & Tracking.Shipment ID, Shipping & Tracking.Notes → Serial Tracker.Serial Number (regex extraction), BOMs.Component SKU → Inventory.SKU (string match).

---

## 4. Katana-PRD Alignment Matrix

Map of what the Excel file now covers vs. the Katana PRD module spec.

| Katana Module | PRD Section | Covered By | Alignment |
|---|---|---|---|
| Sales Orders | PRD §1 | Sales Orders tab | ✅ Full — incl. returns |
| Inventory Management | PRD §2 | Inventory tab | ✅ Strong — reserved, available, days-on-hand, reorder alerts |
| Bill of Materials | PRD §3 | BOMs tab | 🟡 Partial — multi-level flagged but not auto-exploded |
| Make Orders | PRD §4 | Make Orders tab | 🟡 Basic — no BOM auto-populate, no serial assignment |
| Purchase Orders & Vendors | PRD §5 | Vendors & POs tab | ✅ Strong — receipt variance, overdue flag |
| Shopify Integration | PRD §6 | Settings + SO tab | 🟡 Documented, not automated |
| QuickBooks Integration | PRD §7 | Settings (QB mapping) | 🟡 Mapping defined, no sync |
| Barcode Scanning | PRD §8 | — | ❌ Not applicable in Excel |
| Serial Number Tracking | PRD §9 | Serial Tracker tab | ✅ Strong — lifecycle + warranty + tickets |
| Warehouse Management | PRD §10 | Shipping & Tracking + Inventory.Location | 🟡 Single hierarchy only (no bin) |
| Shop Floor / MES | PRD §11 | — | ❌ Not applicable (factory-produced) |
| Planning & Forecasting | PRD §12 | Dashboard forecast section | 🟡 Basic rolling avg; no per-SKU stockout prediction |

**Score:** 5 strong (✅), 6 partial (🟡), 2 not applicable (❌). The sheet now covers ~70% of the Katana surface area conceptually, but coverage ≠ parity.

---

## 5. Excel Limitations — Where the Spreadsheet Hits a Ceiling

This section answers the user's core question: **what can't Excel do that Katana does natively?** Organised by severity.

### 5.1 Hard Architectural Limitations (Excel can never match)

| # | Limitation | Impact on VirgoHome | Katana Equivalent |
|---|---|---|---|
| 1 | **No real-time sync / webhooks** | Shopify orders require manual pull; stock never auto-decrements when a Shopify sale happens. Risk of overselling during high-demand periods. | Native webhooks push new orders, deduct stock, and fire fulfillment notifications in < 1 second. |
| 2 | **No referential integrity** | Customer Name on SO is a free-text string — "ron russell" ≠ "Ron Russell" ≠ "Russell, Ron". Breaks joins, dedup, and roll-up reporting. | Foreign keys with customer IDs enforced at DB level. |
| 3 | **No multi-user concurrency** | Two users editing the same file corrupts state; Excel 365 co-auth partially helps but formulas break under heavy concurrent writes. | Multi-user SaaS with row-level locking and audit log. |
| 4 | **No event-driven triggers** | "Low stock → auto-create PO" cannot run unattended. Reorder Alert surfaces the signal but nothing acts on it. | MO shortage triggers PO draft automatically. |
| 5 | **No mobile / offline** | Warehouse staff cannot pick-pack from a phone on the floor. | Warehouse app + Shop Floor app with barcode scanning. |
| 6 | **No barcode input** | Serial numbers are typed into Notes as free text (`Serial: LL01-00000000145`). Error-prone and slow. | Native scanner support in 3 apps. |
| 7 | **No BOM auto-explosion** | Multi-level BOMs show Parent Assembly as a label, but a Make Order for a finished good does not automatically compute raw material requirements across levels. | Katana recursively explodes BOM tree and nets against current stock. |
| 8 | **No audit trail** | Who changed the SO Status from Open → Delivered? When? No record. | Per-field change history with user + timestamp. |
| 9 | **No API** | Freightcom, QuickBooks, HubSpot tracking URLs cannot be followed programmatically from Excel without VBA + scraping. | REST API exposes every object bi-directionally. |
| 10 | **No role-based permissions** | Everyone with file access sees everything — including vendor costs and customer PII. | Per-role views: operator sees only their MOs; finance sees GL. |

### 5.2 Scaling Limitations (works today, breaks at volume)

| # | Limitation | Breaks When |
|---|---|---|
| 11 | **Row-count performance** | `SUMPRODUCT` and `COUNTIF` ranges hardcoded to `A4:A500` or `B4:B100`. Performance degrades past ~10K rows. VirgoHome is at ~50 SO today, fine; 5,000/month would lag. |
| 12 | **Fixed range references** | Formulas use `Inventory!U4:U100`. Adding 101st row silently drops it from KPIs. |
| 13 | **Text-dates in Sales Orders** | SO dates are stored as text (`'2026-04-10'`), requiring `DATEVALUE` every time. Slower + fragile across locales. |
| 14 | **Notes-field overload** | Shipping & Tracking Notes holds serial + ticket + carrier memo + damage notes in one cell. Parsing requires regex and breaks when users deviate from the `|` convention. |
| 15 | **No first-class many-to-many** | One SO with 3 line items = 3 rows or a packed cell. Current sheet has 1 SKU per order (works for LILA today); SKU-per-line requires schema redesign. |
| 16 | **No cascading deletes** | Deleting a customer row orphans their SO rows. No warning, no cascade. |

### 5.3 Usability & Workflow Gaps

| # | Limitation | Katana Handles This Via |
|---|---|---|
| 17 | **No pick list generation** | Shop Floor app auto-groups SO picks by bin location. |
| 18 | **No partial fulfillment UX** | SO has one Fulfillment Status; Katana supports per-line-item partial ships. |
| 19 | **No QA sign-off workflow** | MO has no QA checkbox with user + timestamp. Katana has a formal QA gate. |
| 20 | **No automatic cost rollup across multi-level BOM** | Sub-assembly cost has to be manually re-entered into the parent's component cost cell. |
| 21 | **No demand-based reorder qty calc** | Reorder Qty is a hardcoded number. Katana's PAF add-on runs EOQ and adjusts per SKU based on recent demand. |
| 22 | **No return-to-stock workflow** | Return Status column exists, but there's no automated "return received → inventory increment" step. |
| 23 | **No attachments / photos** | Operators can't attach a QA photo to an MO or a damage photo to a shipment. |
| 24 | **No saved views per user** | Every user sees the full sheet. Katana has per-role dashboards. |

### 5.4 What Excel *Does* Well Here

Not every gap is bad — Excel has genuine strengths for VirgoHome's current scale:

- **Free** ($0 vs $299+/mo + $2K onboarding).
- **Formula transparency** — every KPI is visibly derived from a cell range. In Katana, the same number is opaque inside a DB query.
- **Speed of iteration** — adding a column takes 30 seconds; adding a custom field in Katana requires config and potential plan changes.
- **HubSpot ticket cross-reference** (24 tickets linked to serials) is *easier* here than in Katana, which has no native ticketing.
- **Offline review** — the file opens anywhere, no login required.
- **Full data portability** — everything ships in a single .xlsx; no vendor lock-in.

---

## 6. Recommended Migration Path

If VirgoHome outgrows the sheet (plausible trigger: >500 SO/month, or >2 warehouses, or >5 concurrent users):

| Priority | Action | Why |
|---|---|---|
| P0 | Keep Serial Tracker + HubSpot ticket linkage | Genuine Excel strength; no native Katana equivalent. |
| P1 | Migrate Inventory + BOMs to Katana first | Biggest automation wins (real-time stock, auto-explode BOM). |
| P2 | Enable Shopify + Katana integration | Kills the manual Chrome MCP import loop. |
| P3 | Add QuickBooks connector | Auto-generates invoices + bills from SO/PO events. |
| P4 | Move Shipping & Tracking last | Freightcom is already pluggable; Shipping tab is one of the better-built areas of the sheet. |

**Hybrid option:** keep Excel as a read-only reporting layer (Dashboard + Serial Tracker) with Katana as the system-of-record for transactional data. Power Query could pull from Katana's API back into the sheet for analytics that benefit from Excel's ad-hoc flexibility.

---

## 7. Summary

| Dimension | Excel Sheet | Katana | Verdict |
|---|---|---|---|
| Feature coverage | ~70% of Katana surface | 100% | Katana deeper |
| Cost | $0 | $299+/mo + $2K | Excel wins at current scale |
| Real-time ops | None | Native | Katana wins |
| Formula visibility | Excellent | Opaque | Excel wins |
| Multi-user | Poor | Excellent | Katana wins |
| Mobile / barcode | None | Native | Katana wins |
| Audit & compliance | None | Built-in | Katana wins |
| Customization speed | Fast | Slower | Excel wins |
| HubSpot support link | Custom-built, works well | Not native | Excel wins |
| Scale ceiling | ~500 SO/month | Effectively unlimited | Katana wins at scale |

**Bottom line:** the current Excel workbook is a solid operational cockpit for VirgoHome at today's LILA volume, and several modules (Serial Tracker, HubSpot cross-ref, Shipping detail) are arguably better than off-the-shelf Katana for this specific use case. The hard ceilings are real-time sync, multi-user concurrency, barcode/mobile workflows, and event-driven automation — none of which can be added to Excel without effectively rebuilding it as a web app. The trigger to migrate is operational, not technical: when the manual Shopify pull and the string-match customer joins start costing more staff time than $299/month + onboarding, it's time.

---

*Sources: `Virgo_Operations_Hub_MRP.xlsx` (direct inspection), `katana-prd.md` (Katana feature reference).*
