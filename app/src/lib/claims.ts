import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

const BUCKET = 'claim-photos';

export type ClaimStatus = 'submitted' | 'in_review' | 'approved' | 'denied' | 'resolved';

export const CLAIM_STATUSES: ClaimStatus[] = ['submitted', 'in_review', 'approved', 'denied', 'resolved'];

export const CLAIM_STATUS_META: Record<ClaimStatus, { label: string; color: string; bg: string }> = {
  submitted: { label: 'Submitted',  color: '#2b6cb0', bg: '#ebf8ff' },
  in_review: { label: 'In Review',  color: '#c05621', bg: '#fffaf0' },
  approved:  { label: 'Approved',   color: '#276749', bg: '#f0fff4' },
  denied:    { label: 'Denied',     color: '#9b2c2c', bg: '#fff5f5' },
  resolved:  { label: 'Resolved',   color: '#718096', bg: '#f7fafc' },
};

export type ShippingDamageClaim = {
  id: string;
  claim_ref: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  tracking_number: string;
  description: string;
  status: ClaimStatus;
  source: string;
  created_at: string;
  updated_at: string;
};

export type ClaimPhoto = {
  id: string;
  claim_id: string;
  file_path: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

/** Customer-facing reference, e.g. CLM-48217. Pure (inject rand for tests). */
export function generateClaimRef(rand: () => number = Math.random): string {
  return `CLM-${Math.floor(rand() * 100000).toString().padStart(5, '0')}`;
}

export type ClaimInput = {
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  tracking_number: string;
  description: string;
};

/** Insert a claim (anon), upload its photos, record photo rows. Returns the claim_ref. */
export async function submitShippingDamageClaim(input: ClaimInput, files: File[]): Promise<string> {
  const claim_ref = generateClaimRef();
  // Generate the id client-side instead of reading it back with .select().
  // Customers submit anonymously (anon role), which has an INSERT policy on
  // shipping_damage_claims but NO SELECT policy — so `.insert().select()` fails
  // for them even though the insert itself is allowed (the row can't be read
  // back). A client-side UUID avoids the read-back entirely, and also satisfies
  // the anon storage policy, which requires the upload path's first folder to
  // be a UUID.
  const claimId = crypto.randomUUID();
  const { error: insErr } = await supabase
    .from('shipping_damage_claims')
    .insert({
      id: claimId,
      claim_ref,
      customer_name: input.customer_name.trim(),
      customer_email: input.customer_email?.trim().toLowerCase() || null,
      customer_phone: input.customer_phone?.trim() || null,
      tracking_number: input.tracking_number.trim(),
      description: input.description.trim(),
      status: 'submitted',
      source: 'customer_form',
    });
  if (insErr) throw new Error(insErr.message ?? 'Failed to submit claim');

  for (const f of files) {
    const path = `${claimId}/${crypto.randomUUID()}-${f.name}`;
    const { error: upErr } = await supabase.storage.from(BUCKET)
      .upload(path, f, { contentType: f.type, upsert: false });
    if (upErr) throw new Error(`Upload failed (${f.name}): ${upErr.message}`);
    const { error: phErr } = await supabase.from('shipping_damage_claim_photos').insert({
      claim_id: claimId, file_path: path, file_name: f.name, mime_type: f.type, size_bytes: f.size,
    });
    if (phErr) throw new Error(`Photo record failed (${f.name}): ${phErr.message}`);
  }
  return claim_ref;
}

/** All claims, newest first, with realtime updates + photo counts. */
export function useShippingDamageClaims(): { claims: (ShippingDamageClaim & { photo_count: number })[]; loading: boolean } {
  const [claims, setClaims] = useState<(ShippingDamageClaim & { photo_count: number })[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('shipping_damage_claims')
        .select('*, shipping_damage_claim_photos(count)')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) {
        setClaims((data as Array<ShippingDamageClaim & { shipping_damage_claim_photos: { count: number }[] }>).map(r => ({
          ...r,
          photo_count: r.shipping_damage_claim_photos?.[0]?.count ?? 0,
        })));
      }
      setLoading(false);
      channel = supabase
        .channel('shipping_damage_claims:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shipping_damage_claims' }, () => {
          void (async () => {
            const { data: fresh } = await supabase
              .from('shipping_damage_claims')
              .select('*, shipping_damage_claim_photos(count)')
              .order('created_at', { ascending: false });
            if (fresh) setClaims((fresh as Array<ShippingDamageClaim & { shipping_damage_claim_photos: { count: number }[] }>).map(r => ({
              ...r, photo_count: r.shipping_damage_claim_photos?.[0]?.count ?? 0,
            })));
          })();
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { claims, loading };
}

export async function getClaimPhotos(claimId: string): Promise<ClaimPhoto[]> {
  const { data } = await supabase.from('shipping_damage_claim_photos')
    .select('*').eq('claim_id', claimId).order('created_at', { ascending: true });
  return (data ?? []) as ClaimPhoto[];
}

/** Signed URL for a private claim photo (1 hour). Null on failure. */
export async function signedPhotoUrl(filePath: string): Promise<string | null> {
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 3600);
  return data?.signedUrl ?? null;
}

export async function updateClaimStatus(id: string, status: ClaimStatus): Promise<void> {
  const { error } = await supabase.from('shipping_damage_claims')
    .update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  await logAction('claim_status_updated', id, status);
}
