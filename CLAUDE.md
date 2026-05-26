# CLAUDE.md — makeLILA

Internal fulfillment management app for VCycene / LILA Composter.

## Tech Stack

- **Frontend:** React 18 + TypeScript, Vite, React Router DOM
- **Backend:** Supabase (Postgres + Auth + Realtime)
- **Styling:** CSS Modules (no Tailwind)
- **Testing:** Vitest (unit), Playwright (e2e)
- **Hosting:** GitHub Pages (virgohomeio/makelila)
- **Auth:** Supabase Google OAuth (VCycene org emails)

## Project Structure

```
app/
  src/
    components/    # AppShell, GlobalNav, UserBadge
    lib/           # Data layer (Supabase hooks, types, helpers)
      supabase.ts        # Client init
      auth.tsx           # AuthProvider, ProtectedRoute
      orders.ts          # Order Review data
      fulfillment.ts     # Fulfillment queue/shelf
      postShipment.ts    # Returns, Refunds, Replacements, Cancellations
      build.ts           # Build pipeline (manufacturing)
      service.ts         # Service tickets, onboarding, repair
      stock.ts           # Inventory / serial tracking
      customers.ts       # Customer master
      templates.ts       # Email/SMS templates
      activityLog.ts     # Audit trail
      classifier.ts      # Order classification
      quo-parsers.ts     # Quo (OpenPhone) message parsing
      parts.ts           # Parts inventory
    modules/       # Route-level page components
      OrderReview/       # Order intake, review, address/freight cards
      Fulfillment/       # Queue (assign→test→dock→label→email→fulfilled) + Shelf (skids)
      Build/             # Manufacturing pipeline board + table view
      PostShipment/      # Returns, Refunds, Replacements, Cancellations, History tabs
      Service/           # Support tickets, Onboarding, Repair tabs
      Stock/             # Units + Parts + Batch inventory
      Customers/         # Customer directory
      Templates/         # Email/SMS template editor
      Forms/             # Public customer-facing forms (ReturnForm, CancelOrderForm, ServiceRequestForm)
      Login.tsx
      ActivityLog.tsx
    App.tsx         # Router config
    main.tsx        # Entry point
  tests/e2e/       # Playwright specs
docs/              # Design docs, setup guides, feature backlog
```

## Key Patterns

- **Data layer:** Each `lib/*.ts` exports typed row interfaces, Supabase hooks (`useReturns`, `useOrders`, etc.), and mutation functions. Realtime subscriptions via Supabase channels.
- **Modules:** Each module is a route-level component with sub-tabs and detail panels. Modules import from `lib/` only — no cross-module imports.
- **Activity log:** All mutations call `logAction()` for audit trail.
- **Public forms:** `/return`, `/cancel-order`, `/service-request` — no auth required, used by customers.

## Environment

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

## Commands

```bash
cd app
npm install
npm run dev          # local dev server
npm run build        # production build
npm test             # vitest
npx playwright test  # e2e
```

---

## Feature Backlog (Alpha Feedback — May 2026)

Full specs: `docs/feature-backlog-alpha-feedback.md`

### P1 — Build Next

1. **Google Maps Address Verification** (OrderReview module)
   - Auto-validate customer addresses on order sync via Google Maps API
   - Detect postal/ZIP mismatches → trigger email to customer with both versions
   - Touch: `lib/orders.ts`, `OrderReview/detail/AddressCard.tsx`, new `lib/addressValidation.ts`
   - Needs: Google Maps Geocoding API key in env

2. **Returns & Refunds Overhaul** (PostShipment module)
   - Add "Reason for Return" dropdown (Product Defect, Software Issue, Shipping Damage, Customer Service Issue, Financing Issue, Other)
   - Return & Refund Dashboard: Responsible Team, Returns by Channel, Unit Conditions, Monthly Trend chart
   - Finance Review workflow: refund amount correction (partial refund handling), refund method selection (Shopify/Sezzle/QuickBooks CC/bank e-transfer), correction notes
   - Approval layer (George/Julie must approve before refund)
   - Business rules: no refund before unit received; customer shipping non-refundable
   - Touch: `lib/postShipment.ts` (add `reason` enum, `finance_review` fields, `refund_method`), `PostShipment/ReturnsTab.tsx`, `PostShipment/RefundsTab.tsx`, new `PostShipment/ReturnDashboard.tsx`, new `PostShipment/FinanceReview.tsx`
   - DB: add columns to `returns` table, new `refund_reviews` table

3. **Email/SMS Templates for Common Scenarios** (Templates module)
   - Built-in editable templates: missing phone/email, address verification, return label, replacement shipped, status update
   - Email + SMS channels
   - Touch: `lib/templates.ts`, `Templates/index.tsx`, integrate with PostShipment and OrderReview modules

4. **Shopify Order/Payment Summary Sync** (OrderReview module)
   - Sync full financial breakdown: subtotal, tax, shipping, discounts, total, payment method
   - Touch: `lib/orders.ts` (extend order type), `OrderReview/detail/LineItemsCard.tsx` or new `PaymentCard.tsx`
   - DB: add financial columns to `orders` table
   - Needs: Shopify API scope expansion

### P2 — After P1

5. **Machine-Level QC Tracking** (Build module + Stock module)
   - Per-machine fields: firmware version, last technician, defect notes, Electrical/Mechanical Pass/Fail/Incomplete
   - Touch: `lib/build.ts`, `Build/panels/UnitDetail.tsx`, `lib/stock.ts`, `Stock/UnitTable.tsx`
   - DB: add columns to `units` or `serial_tracker` table

6. **Shopify Two-Way Sync** — bidirectional address/contact sync after initial order import

7. **Freightcom/ClickShip Dedup** — investigate if ClickShip Shopify sync eliminates manual Freightcom entry

### P3 — Strategic

8. **HubSpot Role Clarification** — define system-of-record per data type
9. **Klaviyo Integration** — power email templates through Klaviyo infrastructure

---

## Conventions

- Match existing code style. CSS Modules, not inline styles (except minor overrides).
- All Supabase queries go through `lib/` — components never import `supabase` directly.
- New features need: types in lib, hook/mutation functions, UI component, activity log calls.
- Test files live next to source (`__tests__/`) or in `lib/` (`.test.ts`).
