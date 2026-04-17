# Make Lila — Internal Fulfillment App Design Spec

**Date:** 2026-04-16
**Scope:** Four completed modules + Activity Log, as prototyped in `order-review-v2.html`
**Audience:** Engineers building the production app from the mockup. The mockup is the visual source of truth — this spec captures structure, data shapes, flows, and cross-module contracts.
**Status:** Draft for review.

---

## 1. Overview

### Purpose

Make Lila is the internal operations app for VCycene's composter product line (Lila Pro). It supports the 7-person ops team through the full order lifecycle from incoming order review to post-shipment tracking, inventory management, and historical fulfillment data. The mockup consolidates previously scattered spreadsheet workflows (MRP, activity tracking, shipping records) into a single web app.

### Users

Seven named team members: Pedrum, Raymond, Aaron, Ashwini, Junaid, Huayi, George. All users see the same app — no role-based permissions in the current scope. Identity is selected at the top-right via a "I am" dropdown and persisted in `localStorage` under `makelila_user`.

### Product / Domain Constants

- **Unit prefix:** `LL01-` (displayed; not stored in serial field)
- **Serial format:** 11-digit zero-padded number (e.g., `00000000354`). P50 batch adds `-p` postfix to disambiguate from P150 overlap (`00000000001-p`).
- **Batches (5):** P50 (decommissioned, 50 units), P150 (150 units), P50N (40 units), P100 (100 units), P100X (100 units, in production)
- **Unit MSRP:** $1,299 CAD / $1,149 USD
- **Warehouse:** MicroArt Warehouse, Markham ON
- **Physical unit (Lila Pro):** 400mm W × 600mm L × 900mm H
- **Skid:** 48" × 48" (1219mm × 1219mm); 5 units arranged as back row 3 (400mm wide × 600mm deep) + front row 2 (600mm wide × 400mm deep); 1000mm total depth used
- **Ship origin:** MicroArt Warehouse, Markham ON

### Single-File Constraint (Current Mockup)

The prototype is a single HTML file (~3100 lines) with all modules, CSS, and JS inline. **Production app should decompose** into module-per-file structure (see §9). All state in the mockup is JS object literals; production requires persistent storage (see §8).

### Tech Stack — Recommendation for Production

- **Frontend:** React or Vue (state-per-module lends itself cleanly to components)
- **Backend:** Node.js + Postgres (referenced `schema.sql` + `seeds.sql` exist in project root — those are the starting points)
- **Auth:** Google OAuth (team is @virgohome.io on Google Workspace; matches Gmail compose integration)
- **Storage/Sync:** Supabase is referenced for OTA firmware version sync (see Stock module §6)
- **Hosting:** Github hosting

---

## 2. Global Shell

### Layout

- Fixed-width page (max 1200px, centered)
- Root element `#app-shell` — all content clipped to nav width; prevents horizontal overflow
- Global nav bar (height 40px, dark background `#111`): brand mark + 5 module links + user switcher
- Each module is a separate `<div id="module-<name>">`; only one visible at a time via `display:block|none`

### Modules (left-to-right in nav)

1. **Order Review** (`order-review`) — badge: pending-review count
2. **Fulfillment** (`fulfillment`) — badge: items in queue
3. **Post-Shipment** (`post-shipment`) — badge: in-transit count
4. **Stock** (`stock`) — badge: total unit count
5. **Activity Log** (`activity-log`) — no badge

Module switching: `switchModule(name)` — toggles `display` on `#module-<name>` panels and sets `.active` class on matching nav item.

### User Switcher

- Top-right of global nav: "I am" label + `<select id="current-user">`
- Options: 7 team members (Pedrum, Raymond, Aaron, Ashwini, Junaid, Huayi, George)
- `currentUser` global variable is the source of truth; `setCurrentUser(name)` updates both variable and localStorage
- All audit entries (`logAction`) stamp the current user

### Activity Log Plumbing (Cross-Module)

Every significant user action calls `logAction(type, entity, detail)`, which:

1. Prepends a new entry to the `activityLog` array with a monotonic `id`, current `Date()`, current user, and the provided type/entity/detail strings
2. If Activity Log module is currently visible, re-renders it live

**Action types currently logged** (this list must remain the complete inventory — new events should extend it, not silently add new types):

| Type | Source Module | Trigger |
|---|---|---|
| `order_approve` | Order Review | Confirm button |
| `order_flag` | Order Review | Flag button |
| `shelf_confirm` | Fulfillment · Shelf | Confirm layout button |
| `unit_test` | Fulfillment · Shelf | Mark unit tested |
| `fq_assign` | Fulfillment · Queue | Step 1: serial assigned |
| `fq_test_ok` | Fulfillment · Queue | Step 2: test report confirmed |
| `fq_flag` | Fulfillment · Queue | Flag to Junaid (rework) |
| `fq_label_upload` | Fulfillment · Queue | Step 3: label OCR parse |
| `fq_label_ok` | Fulfillment · Queue | Step 3: label confirmed |
| `fq_dock` | Fulfillment · Queue | Step 4: dock checklist complete |
| `fq_fulfilled` | Fulfillment · Queue | Step 5: email sent, handoff to Service |
| `replace_ship` | Fulfillment · Replacements | Part shipped |
| `return_process` | Fulfillment · Returns | Return in progress |
| `return_approve` | Fulfillment · Returns | Return / refund approved |
| `stock_status` | Stock · History | Status update saved |
| `stock_add` | Stock · Add to Inventory | Unit confirmed added |

---

## 3. Module: Order Review

### Purpose

Triage incoming orders before fulfillment. Team reviews customer info, flags risky addresses (condos, remote, high-freight regions), and either approves (→ Fulfillment) or flags (→ hold).

### Layout

- Left sidebar (320px, dark): filterable order list with status tags (CA/US flag chips, warn flags, ok checks)
- Right content area: selected order detail — customer summary, line items, address validation, freight estimate, approve/flag action buttons
- Top success banner (`.confirm-banner`): shown after approve via `.show` class

### Key Actions

- **Select order:** clicking a sidebar row swaps right-side detail view
- **Confirm order:** `confirmOrder()` → shows banner + `logAction('order_approve', ...)`
- **Flag order:** `logAction('order_flag', ...)` with reason

### Data

Order Review uses hardcoded mockup orders today. Production: feeds from Shopify / order intake system via polling or webhook.

---

## 4. Module: Fulfillment

Five sub-tabs, switched via `switchFTab(name)`. Tab list (`ftabs` array): `queue`, `shelf`, `history`, `replace`, `returns`. Each `fpanel-<name>` shows via `display:block` except `shelf` which uses `display:grid` (split-screen layout).

### 4.1 Sub-tab: Queue (`fpanel-queue`)

5-step sequential fulfillment workflow per order. Each order advances through steps 1→5, then enters fulfilled state (step 6).

**`fqOrders` data shape** (array of order objects):

```js
{
  id: 'FQ001',                 // internal queue ID
  customer: 'Keith Taitano',
  email: 'keith.taitano@gmail.com',
  order: '#3847',              // Shopify order ref
  country: 'US' | 'CA',
  city: 'Portland',
  state: 'OR',
  address: '2847 SW Corbett Ave, Portland OR 97201',
  carrier: 'UPS' | 'FedEx' | 'Purolator' | 'Canada Post',
  due: 'Apr 20',
  price: '$1,149 USD',
  hasStarter: true,            // US orders include soil starter kit
  step: 1..6,                  // current workflow step
  assignedSerial: '00000000354' | null,
  trackingNum: '1Z...' | null,
  starterTracking: string | null,  // US only
  labelParsed: boolean,
  labelCarrier: string,
  labelWeight: string,
  dockChecks: { printed, affixed, docked, notified },  // step 4
  fulfilledAt: 'Apr 16, 2026' | undefined,
  fulfilledBy: 'Huayi' | undefined
}
```

**5 steps + fulfilled state:**

| Step | Name | Actions | Functions |
|---|---|---|---|
| 1 | Assign Unit | Pick serial from `shelfData` (available units); on confirm, slot status flips to `reserved` | `fqSelectUnit`, `fqConfirmAssignment` |
| 2 | Test Report | Confirm test passed, OR flag to Junaid with issue (pushes entry to `reworksData`) | `fqConfirmTestReport`, `fqFlagRework` |
| 3 | Ship Label | Upload label PDF/image → OCR simulation (1.8s `setTimeout`) fills `trackingNum` based on carrier pattern; confirm button advances to step 4 | `fqOcrUpload`, `fqConfirmLabel` |
| 4 | Dock Check | 4-item checklist: printed, affixed, docked, notified; all true to advance | `fqToggleDockCheck`, `fqConfirmDock` |
| 5 | Send Email | US orders enter starter-kit tracking; clicks Gmail compose link (opens `mail.google.com/mail/?view=cm&fs=1&to=...&su=...&body=...`); on click, advances to fulfilled state | `fqSetStarter`, `fqCompleteOrder` |
| 6 | Fulfilled | Locked detail view with success banner, order summary card, service-team handoff card showing `serviceQueue` entry | `fqRenderFulfilled` |

**`fqCompleteOrder(id)`** is the terminal transition. It:
1. Sets `step=6`, stamps `fulfilledAt` and `fulfilledBy=currentUser`
2. Generates handoff ref `<id>-<base36 timestamp>`
3. Pushes to `serviceQueue` (see §8)
4. Logs `fq_fulfilled`

**Side-panel:** `fqRenderSidebar()` — 5 orders with step badge, country flag, city, last 5 chars of serial. Fulfilled orders render in green.

### 4.2 Sub-tab: Shelf (`fpanel-shelf`)

Split-screen virtual skid layout with drag-and-drop rearrangement.

**Layout** (grid, not block — critical):
- Left 240px dark sidebar: totals (X of Y tested, untested count), legend, per-skid fill bars (X/5), next auto-assign serial, Confirm button
- Right: 2-column grid of skid cards; each card shows top-down physical layout (back row 3 + front row 2 = 5 slots)

**`shelfData` shape:**

```js
{
  A1: { zone: 'A', batch: 'P100', slots: [
    { serial: '00000000348', batch: 'P100', status: 'available' },
    // 5 slots; null = empty
  ]},
  // A1, A2, A3, B1, B2
}
```

Slot statuses: `available`, `reserved`, `not-tested`.

**Drag-and-drop:** HTML5 DnD API. Any slot on any skid can be swapped with any other slot. Functions: `sDragStart`, `sDragEnd`, `sDragOver`, `sDragLeave`, `sDragDrop`. After swap, `shelfModified = true`, full re-render via `renderShelf()`.

**Confirm button — 3 states:**
- Disabled (grey): no changes pending
- Active (green): `shelfModified && !shelfConfirmed`
- Saved (faded green + "Saved ✓"): after `confirmShelfLayout()`

**Auto-assign logic (front-row-first):** In each skid, slot indices 3, 4 (front row, aisle side) are preferred over 0, 1, 2 (back row). Iterates through all skids; skips serials already reserved in `fqOrders`.

**Cross-module interactions:**
- Fulfillment Queue step 1 marks slots `reserved`
- Stock Module's Ready units flow into the shelf

### 4.3 Sub-tabs: History / Replacements / Returns

All three are data tables with mini dashboards on top.

**Shared pattern:**
- Mini dashboard row (4-6 stat tiles, e.g., "83 shipped", "$9,840 freight")
- Optional filter chip bar
- Table with fixed grid-template-columns (in `fr` units — no px values in data grids to prevent overflow)
- Row styling: country background (CA / US), over-threshold values in red, in-transit rows with subtle blue bg

**Fulfillment History** (`fpanel-history`):
- 83 records, 44 CA / 33 US + 6 misc
- Grid: `1.5fr 1.0fr 0.5fr 0.65fr 0.65fr 0.65fr 1.6fr 0.7fr`
- In-transit rows background: `#f0f7ff`; over-limit freight text: `#e53e3e`

**Replacements** (`fpanel-replace`):
- 9 records (real data)
- Part types: Top Lid (5), Filter Cup (1), LILA Pad (1), Chamber+Tray (1)
- Grid: `1.2fr 1.0fr 0.55fr 0.7fr 0.7fr 0.6fr 0.5fr 1.4fr 0.7fr`

**Returns & Refunds** (`fpanel-returns`):
- 30 records
- Dashboard: 30 total, 4 pending (amber bg), 26 completed, 8 defects, 4 tariff, $18,294 refunded, 19 CA / 11 US
- Reason filter bar (All / Defect / Tariff / Cancelled / etc.)
- Grid: `0.65fr 1.35fr 0.5fr 0.7fr 0.7fr 0.85fr 0.65fr 0.65fr 1.4fr`

---

## 5. Module: Post-Shipment

### Purpose

Track shipments after they leave the dock. Geographic dashboard with per-country (CA / US) KPIs. Source records are units in transit or recently delivered.

### Layout

Split-screen:
- Left (dark, scrollable list): status-color header chip row with counts per status; all shipments row-rendered with flag, status chip, city/prov/distance, freight, cost/km, duration
- Right (dashboard): 4 top-row stat tiles (Total Revenue, Customers, CA Orders, US Orders); CA vs US side-by-side KPI cards (Avg Freight, Avg Duration, Avg Distance, Cost/km); best-3 / worst-3 freight efficiency lists; SVG map with Markham ON origin and dashed lines to each destination

### Data: `psShipments` (array)

```js
{
  name: 'Sarah Mitchell',
  city: 'Vancouver', prov: 'BC', country: 'CA' | 'US',
  serial: '00000000085',
  price: 1299, freight: 89.50,
  carrier: 'Purolator' | 'FedEx' | 'UPS',
  shipped: '2026-04-09', delivered: '2026-04-15' | null,
  status: 'delivered' | 'in-transit' | 'picked-up' | 'exception' | 'onboarding',
  tracking: 'CP8274618310',
  distKm: 3430
}
```

### Status Catalog

| Status | Label | BG | Color |
|---|---|---|---|
| `in-transit` | In Transit | `#bee3f8` | `#2b6cb0` |
| `picked-up` | Picked Up | `#fef3c7` | `#744210` |
| `delivered` | ✓ Delivered | `#c6f6d5` | `#276749` |
| `exception` | ! Exception | `#fed7d7` | `#9b2c2c` |
| `onboarding` | Onboarding | `#e9d8fd` | `#553c9a` |

### SVG Map

- City → coords lookup: `PS_CITY_XY` (lat/lng mapped to SVG viewBox coords at module level)
- Origin: `PS_ORIGIN_X`, `PS_ORIGIN_Y` (Markham ON)
- Renders: dashed line from origin + filled circle + city label per shipment
- Colors by country: CA `#8B1A1A`, US `#3C3B6E`

---

## 6. Module: Stock

### Purpose

Single-source-of-truth for every unit ever built. Status-per-unit drives lifecycle visibility (production → warehouse → customer). Replaces the Warehouse MRP spreadsheet.

### Layout

- Header bar (top): "STOCK" label, total unit badge
- Tab bar (3 tabs): History, Inventory, + Add to Inventory
- Body: tab-specific content (`renderStockHistory`, `renderStockInventory`, `renderStockAdd`)

### Data: `stockData` (array)

Built by `buildStockData()` on `DOMContentLoaded`; cross-references `psShipments` and `reworksData`:

```js
{
  batch: 'P100' | 'P150' | 'P50N' | 'P50' | 'P100X',
  serialNum: 348,               // integer, for sorting
  serial: '00000000348',        // 11-digit string; P50 gets '-p' suffix
  status: <STOCK_STATUS key>,
  pendingStatus: null | <key>,  // for Update button pattern
  tested: boolean,
  customer: string | null,      // populated for shipped units from psShipments
  location: 'Vancouver, BC' | null,
  tracking: string | null,
  notes: string
}
```

**Unit breakdown on initial load:**
- P50: 50 units, all `unknown`, serial postfix `-p`, note "decommissioned"
- P150: 150 units, cross-ref `psShipments` — sets status to `visible` / `in-transit` / `unknown-sh` based on shipment state; unshipped default `unknown`
- P50N: 40 units (201–240), all `unknown`
- P100: 100 units (251–350), all `ca-test`; if serial in `reworksData`, notes include rework issue + status
- P100X: 100 units (351–450), all `ordered`, note "in production (China)"

### Status System — `STOCK_STATUS`

15 statuses grouped into 6 categories. Each status has: `label`, `cat` (category), `color`, `bg`.

| Key | Label | Category | Color | BG |
|---|---|---|---|---|
| `visible` | Visible | working | `#276749` | `#f0fff4` |
| `hidden` | Hidden | working | `#2b6cb0` | `#ebf8ff` |
| `team-test` | Team Test | working | `#744210` | `#fffbeb` |
| `servicing` | Servicing | returned | `#744210` | `#fffbeb` |
| `scrap` | Scrap | returned | `#9b2c2c` | `#fff5f5` |
| `in-transit` | In Transit | shipping | `#2b6cb0` | `#ebf8ff` |
| `lost` | Lost | shipping | `#c53030` | `#fff5f5` |
| `ready` | Ready | warehouse | `#276749` | `#f0fff4` |
| `unknown-wh` | Unknown (Wh) | warehouse | `#718096` | `#f7fafc` |
| `ordered` | Ordered | production | `#553c9a` | `#faf5ff` |
| `boat` | On Boat | production | `#2b6cb0` | `#ebf8ff` |
| `ca-test` | CA Test | production | `#744210` | `#fffbeb` |
| `rework` | Rework | production | `#9b2c2c` | `#fff5f5` |
| `unknown-sh` | Unknown (Shipped) | other | `#718096` | `#f7fafc` |
| `unknown` | Unknown | other | `#a0aec0` | `#f7fafc` |

**Category semantics:**
- **working:** unit is in an active-use or internal-test state
- **returned:** unit came back (serviced or scrapped)
- **shipping:** unit is en route or lost in transit
- **warehouse:** unit is in physical warehouse
- **production:** unit is being manufactured, imported, or tested pre-warehouse
- **other:** indeterminate

### 6.1 Tab: History

Full table of all `stockData` records. Columns: Serial, Batch, Status (editable dropdown), Tested, Customer/Location, Tracking, Notes. Filter chips: by batch, by category, by status. Search by serial / customer.

**Update Button Pattern** (critical UX):
- Each row's status is a `<select>` populated with all 15 statuses (grouped by category in `<optgroup>`)
- On change: `stockPreviewChange(serial, batch, sel)` — does **NOT** re-render; directly mutates the select's CSS (matching status color theme) and toggles a hidden sibling "Update" button to `display:inline-block` if `sel.value !== currentStatus`
- User clicks Update → `stockUpdateStatus(serial, batch)` commits: sets `u.status = u.pendingStatus`, clears `pendingStatus`, logs `stock_status`, full re-render

This pattern prevents mid-edit re-renders from losing user interaction state on nearby selects.

### 6.2 Tab: Inventory

Filtered view: only units with `status === 'ready'`. Columns: Serial, Batch, Location, OTA Version, Notes, Actions. No inline editing — for edits, switch to History tab.

### 6.3 Tab: Add to Inventory

3-step form to move a unit from `ca-test` → `ready`. State held in `stockAddState`:

```js
{
  serial: '', batch: '',
  parsed: false, result: null, parsing: false,   // step 2
  otaVersion: '', otaSyncing: false, otaSynced: false,
  otaApplying: false, otaDone: false              // step 3
}
```

Factory: `STOCK_ADD_RESET()` returns fresh state. Called on tab entry, on serial change, and after successful confirm.

**Step 1 — Select Unit:**
- Dropdown populated from `stockData.filter(u => u.status === 'ca-test')`
- On select: `stockAddSelectUnit('serial|batch')` — resets all downstream state (test log + OTA) and sets `serial` + `batch`
- If no `ca-test` units: show "No units in CA Test status. Update via History tab first."

**Step 2 — Upload Test Log:**
- `<input type="file">` triggers `stockOcrAdd(input)` — 1.8s `setTimeout` simulation
- Generates mock test result: randomly assigned tester (Aaron/Huayi/Junaid), all checks Pass, software firmware `v2.1.4`
- On parse: right panel shows test log card (Pass/Fail with mechanical/electronic/software sub-results)
- If result is Fail: shows "Unit failed — cannot add to inventory. Flag to Junaid." — confirm blocked

**Step 3 — OTA Software Update:**
- Shows only if step 2 result is Pass
- Displays current firmware from test log
- Two options for target version:
  - **Auto:** "🔄 Sync from Supabase" button → `stockOtaSync()` (1.2s simulation) → returns V17 as latest
  - **Manual:** `<select>` with V14 / V16 / V17 → `stockOtaSetManual(v)`
- "📡 Apply OTA Update" button (disabled until version selected) → `stockOtaApply()` (1.5s simulation) → sets `otaDone = true`
- Shows green "✅ OTA Complete — VXX applied" banner when done

**Confirm:**
- "✓ Confirm & Add to Inventory" button only renders if `pass && otaDone`
- `stockConfirmAdd()`:
  1. Locates unit in `stockData` by (serial, batch), or creates new if not found
  2. Sets `status='ready'`, `tested=true`, appends `OTA VXX` to notes
  3. Logs `stock_add` with tester + OTA version
  4. Resets `stockAddState`, switches to Inventory tab

### Stock → Activity Log count

Activity Log KPI tile "Stock Added" = `activityLog.filter(e => e.type === 'stock_add').length`.

---

## 7. Module: Activity Log

### Purpose

Team audit trail + weekly performance KPIs + team contribution summary. Read-only aggregate of all `logAction` calls.

### Layout

Split-screen:
- **Left (dark feed):** grouped by session (same user, entries ≤90min apart). Session header: user initial avatar, name, time range, action count. Rows: timestamp + entity + detail. Sticky "TEAM ACTIVITY" header at top with total entry count.
- **Right (light dashboard):** 5-tile top KPI row + 3-card "KPI Overview — Fulfillment" row + 3-card second KPI row + 2-column team contribution cards.

### Data: `activityLog` (array)

```js
{
  id: 1,                        // monotonic, actLogIdCounter
  user: 'Pedrum',
  ts: Date,
  type: <action type from §2 table>,
  entity: 'Dale Bober · CA',    // short human label
  detail: '#ORD-0083 · $1,299'  // optional sub-text
}
```

Seed data: 29 entries spanning Apr 14 – Apr 16, 2026, across all 7 users. New entries (via `logAction`) prepend to the array.

### KPI Tiles — Top Row (5 wide)

| Tile | Calculation |
|---|---|
| Actions Today | count of entries with today's date |
| Orders This Week | count where `type === 'order_approve'` |
| Returns Resolved | count where `type IN (return_approve, return_process)` |
| Stock Added | count where `type === 'stock_add'` |
| Untested Units | count of `shelfData` slots with `status === 'not-tested'` |

### KPI Cards — Row 2: "Fulfillment" (3 wide)

- **Orders · Shipping Speed:** on-time% based on `shipSpeed` object (fast ≤3d, onTime ≤5d, late ≤7d, veryLate >7d). Green border if ≥90%, amber otherwise.
- **Replacements · Shipping Speed:** same buckets, from `replSpeed`
- **Queue Health:** % of orders fulfilled (no cancellation). Green if ≥90%, red otherwise. Current: 86% (14 cancelled of 97).

### KPI Cards — Row 3 (3 wide)

- **Warehouse Inventory:** effective% = available slots / total slots. Stacked bar showing available/reserved/untested/empty breakdown.
- **Reworks:** total + resolved/in-progress split, from `reworksData`. Lists each in-progress rework with serial + issue + responsible user.
- **Shipping Risk:** placeholder card (grey, `opacity:.65`) — "Address validator not yet connected"

### Team Contributions (2-column card grid)

Per-user tally from `activityLog`, bucketed:
- `order_approve | order_flag` → orders
- `return_process | return_approve` → returns
- `shelf_confirm | unit_test` → shelf/test
- `replace_ship` → replacements

Each card: user avatar (initial + USER_COLORS), total count, horizontal fill bar (relative to top contributor), category chips.

---

## 8. Shared Data Models

Central tables the production app needs. Names follow the mockup's JS variables.

### `activityLog`
See §7. All modules write via `logAction()`.

### `fqOrders`
See §4.1. Fulfillment Queue source. Production: entries originate from approved orders in Order Review.

### `shelfData`
See §4.2. Warehouse-authoritative unit layout. Writes from Stock (Ready state), Fulfillment Queue (Reserved), Shelf drag-and-drop.

### `psShipments`
See §5. Post-ship tracking. Writes from Fulfillment Queue step 5 completion. Ingests carrier status via tracking API (production).

### `stockData`
See §6. The ground-truth unit registry. Every physical unit ever built. All modules read from this.

### `serviceQueue`
Passed between Fulfillment (writes) and the future Service Team module (reads).

```js
{
  orderId: 'FQ005',
  ref: 'FQ005-K3X9HZ01',        // handoff reference
  customer, email, serial,
  tracking, starterTracking,
  country,
  onboardingStatus: 'pending',
  fulfilledAt, fulfilledBy
}
```

Currently no UI reads from `serviceQueue` — it's an outbound contract only.

### `reworksData`
Array of units flagged for rework.

```js
{
  serial: '00000000354' | '—',
  user: 'Junaid',
  date: 'Apr 16',
  issue: 'Motor fault',
  status: 'in-progress' | 'resolved'
}
```

Writes: Fulfillment Queue step 2 flag, Stock History manual status change to `rework`. Read by Activity Log dashboard.

### Cross-module write contracts

| Source action | Target(s) |
|---|---|
| Order Review approve | Creates row in `fqOrders` (production; hardcoded in mockup) |
| FQ step 1 confirm | `shelfData[skid].slots[i].status = 'reserved'` |
| FQ step 2 flag | `reworksData.unshift(...)` |
| FQ step 5 send email | `serviceQueue.push(...)`; `fqOrders[i].step = 6` |
| FQ post-fulfilled | (Future) `psShipments.push(...)` on actual carrier pickup |
| Stock Add to Inventory confirm | `stockData` upsert with `status='ready'` |
| Stock History status edit | `stockData[i].status` update; if new status is `rework`, could push to `reworksData` |

---

## 9. Design System

### Color Palette

- **Brand crimson:** `#8B1A1A` (CA flag, primary brand, primary buttons)
- **US navy:** `#3C3B6E` (US flag, accent)
- **Success green:** `#276749`, lighter `#68d391`, bg `#f0fff4`, border `#9ae6b4`
- **Warning amber:** `#d69e2e`, `#744210`, bg `#fffbeb`, border `#f6ad55` / `#fbd38d`
- **Error red:** `#e53e3e`, `#c53030`, bg `#fff5f5`, border `#fc8181`/`#feb2b2`
- **Info blue:** `#2b6cb0`, bg `#ebf8ff`, border `#bee3f8`/`#63b3ed`
- **Purple (production):** `#553c9a`, bg `#faf5ff`/`#e9d8fd`
- **Neutral grays:** `#1a202c` (text), `#4a5568`, `#718096`, `#a0aec0`, `#cbd5e0`, `#e2e8f0`, `#f7fafc`
- **Dark UI (sidebars):** `#111`, `#1c1c1c`, `#232323`, `#252525`, `#2a2a2a`

### Typography

- Font stack: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', sans-serif` (applied `!important` globally)
- Monospace (serials, tracking): default browser monospace
- Size scale: 7px–8px (micro labels), 9px–10px (meta), 11px–12px (body), 14px–16px (titles), 18px–22px (KPIs)
- Weights: 400, 600, 700, 800

### Grid Conventions

- **Data tables use `fr` units exclusively** — no `px` widths in table grids (causes overflow inside `#app-shell`)
- All `display:grid` children must have `min-width: 0` (enforced by global CSS: `[style*="display:grid"] > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`)
- `#app-shell` wrapper clips all content to nav width

### Country Tags

- CA: `background:#8B1A1A; color:#fff` + 🍁
- US: `background:#3C3B6E; color:#fff` + 🦅

### Status-Banner Patterns

- Success: `#f0fff4` bg, `#9ae6b4` border, `#276749` text, ✓ icon
- Warning: `#fffbeb` bg, `#f6ad55` border, `#744210` text
- Error: `#fff5f5` bg, `#fc8181` border, `#c53030` text
- Info (blue): `#ebf8ff` bg, `#bee3f8` border, `#2b6cb0` text

### Simulation Delays (to preserve in production for same "thinking" feel)

- Label OCR parse: 1800ms
- Stock test log OCR: 1800ms
- Supabase OTA version sync: 1200ms
- OTA apply: 1500ms

---

## 10. Decomposition Recommendations for Production

The mockup is a single 3100-line HTML file. The production app should be split into clearly-bounded units:

### Frontend file layout (suggested React structure)

```
src/
  App.tsx                          // global shell, nav, module switcher
  lib/
    activityLog.ts                 // logAction + activityLog state (central)
    currentUser.ts                 // user identity + localStorage
    statusCatalogs.ts              // STOCK_STATUS, psShipmentStatus, etc.
    designSystem.ts                // color tokens, country tag components
  modules/
    orderReview/
      OrderReview.tsx
      OrderList.tsx
      OrderDetail.tsx
    fulfillment/
      Fulfillment.tsx              // tab container
      queue/
        FQueue.tsx
        FQueueSidebar.tsx
        Step1Assign.tsx ... Step5Email.tsx
        Fulfilled.tsx
      shelf/
        Shelf.tsx
        SkidCard.tsx
        ShelfSidebar.tsx
      history/FulfillmentHistory.tsx
      replacements/Replacements.tsx
      returns/Returns.tsx
    postShipment/
      PostShipment.tsx
      ShipmentList.tsx
      GeoDashboard.tsx             // SVG map + KPI cards
    stock/
      Stock.tsx                    // tab container
      StockHistory.tsx
      StockInventory.tsx
      StockAdd.tsx
      OtaPanel.tsx
    activityLog/
      ActivityLog.tsx
      ActivityFeed.tsx
      KpiDashboard.tsx
      TeamContributions.tsx
```

### Backend contracts (Postgres tables — starter list)

Map roughly 1:1 with the shared data models in §8:

- `orders` (from Shopify + flags) — Order Review source
- `fulfillment_queue` — `fqOrders`
- `shelf_layout` (serial, skid_id, slot_index, status) — `shelfData`
- `units` — `stockData` (primary registry)
- `shipments` — `psShipments`
- `service_queue` — `serviceQueue`
- `reworks` — `reworksData`
- `activity_log` — `activityLog`
- `unit_status_history` (unit_id, from_status, to_status, user, ts) — inferred new table for traceability
- `ota_versions` (version, released_at) — Supabase table or mirrored

### Plan decomposition

This spec is too large for one implementation plan. Recommended sub-plans:

1. **Shared infra** — auth, DB schema, activity log, user switcher, module shell
2. **Stock module** — largest data model, other modules depend on it
3. **Fulfillment queue** — depends on stock + shelf
4. **Fulfillment shelf + remaining sub-tabs** — depends on stock
5. **Post-shipment** — depends on fulfillment
6. **Order review** — can be built in parallel with any above
7. **Activity log** — should be last (aggregates from all above)

Each sub-plan gets its own `docs/superpowers/plans/YYYY-MM-DD-<name>.md` and can ship independently.

---

## 11. Out of Scope (This Spec)

- **Service Team module** — only the outbound `serviceQueue` contract is defined. The module that reads it is a separate spec.
- **Order intake from Shopify** — hardcoded orders in mockup; production wiring is separate.
- **Carrier tracking API integration** — mockup uses randomized tracking numbers.
- **Real Supabase OTA sync** — mockup returns V17 from `setTimeout`.
- **Authentication / role permissions** — mockup uses localStorage dropdown; production needs Google OAuth.
- **Pixel-exact styling reproduction** — the mockup HTML is the visual source of truth. This spec documents structure and intent; exact CSS values should be read from the mockup file directly.

---

## 12. Open Questions for Engineering

1. **Real-time sync across team members?** Mockup is single-user in-memory. Production likely needs WebSocket / Supabase realtime for shelf updates and activity log.
2. **Unit status transitions — enforced as a state machine?** E.g., should `scrap` → `ready` be blocked? Mockup allows any transition via dropdown.
3. **Activity log retention?** Mockup is unbounded in memory. Production needs archival rules.
4. **Mobile support?** Mockup is desktop-only (1200px max-width, fixed layouts). Warehouse floor staff may need tablet UI for Shelf + Fulfillment Queue.
5. **Import from existing MRP spreadsheets?** `Virgo_Operations_Hub_MRP.xlsx` exists in project root — is that the authoritative current state for unit seed data?
