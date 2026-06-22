# LILA Shipping Damage Form → Fulfillment ▸ Claims — Design Spec

**Date:** 2026-06-22
**Author:** Huayi Gao (with Claude)
**Status:** Approved (proceed; iterate during build)

---

## 1. Goal
A public **LILA Shipping Damage Form** (`/shipping-damage`) where customers submit
name, tracking number, optional email/phone, a damage description, and photos.
Submissions land in a new **Fulfillment ▸ Claims** tab.

## 2. Decisions (locked in)
| Decision | Choice |
|----------|--------|
| Storage | Dedicated `shipping_damage_claims` + `shipping_damage_claim_photos` tables; not the returns table. |
| Contact | name + tracking + description + photos **required**; email + phone **optional**. |
| Photos | required (≥1), up to 8 images (jpeg/png/webp/heic/heif), 25 MB each, private bucket `claim-photos`. |
| Submit auth | anonymous direct insert (anon RLS), same as the return/service-request forms. |

## 3. Data model (migrations)
- **`shipping_damage_claims`**: `id uuid pk default gen_random_uuid(), claim_ref text, customer_name text not null, customer_email text, customer_phone text, tracking_number text not null, description text not null, status text not null default 'submitted', source text not null default 'customer_form', created_at timestamptz default now(), updated_at timestamptz default now()`.
  RLS (mirror `service_tickets`): select/insert/update `to authenticated using(true)`; `insert to anon with check (source='customer_form' and status='submitted')`.
- **`shipping_damage_claim_photos`**: `id uuid pk default gen_random_uuid(), claim_id uuid not null references shipping_damage_claims(id) on delete cascade, file_path text not null, file_name text, mime_type text, size_bytes int, created_at timestamptz default now()`. Index on `(claim_id)`.
  RLS: select/insert `to authenticated using(true)/with check(true)`; `insert to anon with check (true)`.
- **Storage bucket `claim-photos`** (private, images only, 25 MB): read/write authenticated; anon insert when `(storage.foldername(name))[1]` is a UUID — mirror the `ticket-attachments` bucket.

Statuses: `submitted → in_review → approved | denied | resolved`.

## 4. `app/src/lib/claims.ts`
```
export type ClaimStatus = 'submitted'|'in_review'|'approved'|'denied'|'resolved';
export const CLAIM_STATUS_META: Record<ClaimStatus,{label;color;bg}>;
export const CLAIM_STATUSES: ClaimStatus[];
export type ShippingDamageClaim = { id; claim_ref; customer_name; customer_email; customer_phone; tracking_number; description; status: ClaimStatus; source; created_at; updated_at; photo_count? };
export type ClaimPhoto = { id; claim_id; file_path; file_name; mime_type; size_bytes; created_at };
export function generateClaimRef(rand?: () => number): string;          // 'CLM-#####' (pure, testable)
export async function submitShippingDamageClaim(input, files: File[]): Promise<string>; // returns claim_ref
export function useShippingDamageClaims(): { claims; loading };          // realtime, like useReturns
export async function getClaimPhotos(claimId): Promise<ClaimPhoto[]>;
export async function signedPhotoUrl(filePath): Promise<string|null>;    // createSignedUrl, 1h
export async function updateClaimStatus(id, status): Promise<void>;      // + logAction
```

## 5. Public form — `app/src/modules/Forms/ShippingDamageForm.tsx`
Mirror `ServiceRequestForm` (uses `FormLayout` + `Forms.module.css`). Title
**"LILA Shipping Damage Form"**. Fields: Name*, Tracking number*, Email, Phone,
Damage description* (textarea), Photos* (multi, images, ≥1, ≤8, 25 MB). Submit
via `submitShippingDamageClaim`; success screen shows the `CLM-#####` reference.
Route `/shipping-damage` added to `App.tsx` (public).

## 6. Fulfillment ▸ Claims tab
- `Fulfillment/index.tsx`: add `'claims'` to `Tab` + `VALID_TABS`, a **Claims** tab
  button (`/fulfillment/claims`), and the panel `active==='claims' ? <ClaimsTab/>`.
- `app/src/modules/PostShipment/ClaimsTab.tsx`: `useShippingDamageClaims()` → table
  (`claim_ref · name · tracking# · status · date · 📷 N`); row click → detail panel
  with contact, tracking, description, **photos** (rendered via `signedPhotoUrl`),
  and a status `<select>` (`updateClaimStatus`).

## 7. Testing
- Vitest (pure): `generateClaimRef` format `^CLM-\d{5}$` (deterministic via injected rand); `CLAIM_STATUSES`/meta keys aligned.
- `npm run lint` (deploy gate) + `npm test` + `npm run build` green. Controller applies 3 migrations to prod + pushes.

## 8. Out of scope
- No auto-creation of a return/ticket from a claim. No email notification on submit (can add later). Customer link to share: `https://lila.vip/shipping-damage`.
