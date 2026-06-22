# Shipping Damage Claims — Implementation Plan

> Execute task-by-task. Each task ends green (`npm run lint` exit 0 — deploy gate). Controller applies migrations + pushes. Spec: `docs/superpowers/specs/2026-06-22-shipping-damage-claims-design.md`.

**Goal:** Public LILA Shipping Damage form (`/shipping-damage`) → new Fulfillment ▸ Claims tab, with photo uploads to a private bucket.

---

### Task 1 — Migrations + bucket
- Create `supabase/migrations/20260622120000_shipping_damage_claims.sql` (claims + photos tables, RLS per spec §3).
- Create `supabase/migrations/20260622120100_claim_photos_bucket.sql` (bucket `claim-photos`, images only, RLS mirroring `ticket-attachments` §3).
- Controller applies both to prod. Commit.

### Task 2 — `app/src/lib/claims.ts` + `claims.test.ts` (TDD on pure bits)
- Types, `CLAIM_STATUSES`/`CLAIM_STATUS_META`, `generateClaimRef`, `submitShippingDamageClaim`, `useShippingDamageClaims`, `getClaimPhotos`, `signedPhotoUrl`, `updateClaimStatus` (spec §4).
- Tests: `generateClaimRef` matches `^CLM-\d{5}$` (inject rand); status meta keys == CLAIM_STATUSES.
- Verify tsc/lint/tests. Commit.

### Task 3 — `ShippingDamageForm.tsx` + route
- Mirror `ServiceRequestForm` (FormLayout + Forms.module.css). Title "LILA Shipping Damage Form". Fields per spec §5; ≥1 photo required, ≤8, images only. Submit via `submitShippingDamageClaim`; success shows `CLM-#####`.
- App.tsx: import + `<Route path="/shipping-damage" element={<ShippingDamageForm />} />`.
- tsc/lint/build. Commit.

### Task 4 — Fulfillment Claims tab + `ClaimsTab.tsx`
- `Fulfillment/index.tsx`: add `'claims'` to Tab + VALID_TABS + tab button + panel.
- `PostShipment/ClaimsTab.tsx`: list (useShippingDamageClaims) + detail with photos (signedPhotoUrl) + status select (updateClaimStatus).
- tsc/lint/build. Commit.

### Task 5 — Verify + ship
- `npm test`, `npm run lint`, `npm run build` green. Controller pushes `main`; confirm migrations applied.
