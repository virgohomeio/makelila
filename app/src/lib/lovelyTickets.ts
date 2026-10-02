import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import {
  supabaseTelemetry,
  isTelemetryConfigured,
  TELEMETRY_URL,
  TELEMETRY_ANON_KEY,
} from './supabaseTelemetry';

// Lovely app "tickets" = rows in the Lovely project's `public.damage_reports`,
// filed by customers from the app's onboarding damage-report step (Lovely repo
// app/api/onboarding/damage-report/route.ts). Each report can carry up to 10
// photos: `public.images` rows with `damage_report_id` set, whose files live
// in the PRIVATE `damage-photos` storage bucket.
//
// damage_reports + images are anon-readable, so rows come straight off the
// telemetry client. Photo files need signed URLs, which only the
// `lovely-damage-photos` edge function (operator-gated) can mint.
export type LovelyTicket = {
  id: string;
  user_id: string | null;
  serial_number: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  photoPaths: string[];
};

type DamageReportRow = Omit<LovelyTicket, 'photoPaths'>;
type ImageRow = { damage_report_id: string; raw_object_path: string | null; created_at: string | null };

export function attachPhotos(reports: DamageReportRow[], images: ImageRow[]): LovelyTicket[] {
  const byReport = new Map<string, ImageRow[]>();
  for (const img of images) {
    if (!img.raw_object_path) continue;
    const list = byReport.get(img.damage_report_id) ?? [];
    list.push(img);
    byReport.set(img.damage_report_id, list);
  }
  return reports.map(r => ({
    ...r,
    photoPaths: (byReport.get(r.id) ?? [])
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
      .map(i => i.raw_object_path!),
  }));
}

export function useLovelyTickets() {
  const [tickets, setTickets] = useState<LovelyTicket[]>([]);
  const [loading, setLoading] = useState<boolean>(isTelemetryConfigured);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!supabaseTelemetry) return;
    setLoading(true);
    setError(null);
    try {
      const [reportsRes, imagesRes] = await Promise.all([
        supabaseTelemetry
          .from('damage_reports')
          .select('id, user_id, serial_number, notes, created_at, updated_at')
          .order('created_at', { ascending: false }),
        supabaseTelemetry
          .from('images')
          .select('damage_report_id, raw_object_path, created_at')
          .not('damage_report_id', 'is', null),
      ]);
      if (reportsRes.error) throw new Error(reportsRes.error.message);
      if (imagesRes.error) throw new Error(imagesRes.error.message);
      setTickets(attachPhotos(
        (reportsRes.data ?? []) as DamageReportRow[],
        (imagesRes.data ?? []) as ImageRow[],
      ));
    } catch (e) {
      setError((e as Error).message);
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { tickets, loading, error, refetch };
}

// Returns { [path]: signedUrl } for the given damage-photos object paths via
// the lovely-damage-photos edge function. Throws with the function's error body
// on a non-2xx (including 404 when the function isn't deployed yet).
export async function signDamagePhotos(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  if (!isTelemetryConfigured || !TELEMETRY_URL || !TELEMETRY_ANON_KEY) {
    throw new Error('Lovely telemetry not configured.');
  }
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not signed in.');
  const res = await fetch(`${TELEMETRY_URL}/functions/v1/lovely-damage-photos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: TELEMETRY_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ paths }),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch { /* keep raw */ }
    throw new Error(`Couldn't load photos (${res.status}): ${detail}`);
  }
  return ((JSON.parse(text) as { urls?: Record<string, string> }).urls) ?? {};
}
