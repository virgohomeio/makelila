import { useCallback, useEffect, useState } from 'react';
import { supabaseTelemetry, isTelemetryConfigured } from './supabaseTelemetry';

// Lovely app compost check-ins = rows in the Lovely project's
// `public.compost_feedback` (anon-readable), written by the app's compost
// feedback card (Lovely repo app/api/compost-feedback/route.ts). Each row
// carries a `readings_snapshot` of the unit's last 7 days of BME readings per
// chamber, captured at submit time. The raw snapshot is large, so it's reduced
// to per-chamber averages here and never kept in state.
export type CompostRating =
  | 'healthy' | 'too_wet' | 'too_dry' | 'stinky' | 'mold' | 'not_breaking_down' | 'other';

// Labels + order mirrored from the Lovely app (components/compost-feedback-card.tsx).
export const COMPOST_RATINGS: { value: CompostRating; label: string }[] = [
  { value: 'healthy', label: 'Healthy' },
  { value: 'too_wet', label: 'Too wet' },
  { value: 'too_dry', label: 'Too dry' },
  { value: 'stinky', label: 'Stinky' },
  { value: 'mold', label: 'Moldy' },
  { value: 'not_breaking_down', label: 'Not breaking down' },
  { value: 'other', label: 'Other' },
];

export function ratingLabel(rating: string | null): string {
  return COMPOST_RATINGS.find(r => r.value === rating)?.label ?? rating ?? '—';
}

type Reading = { humidity: number | null; temperature: number | null };
type Snapshot = { left?: Reading[]; right?: Reading[]; window_days?: number } | null;

export type ChamberAverages = { humidity: number | null; temperature: number | null; samples: number };

export type CompostFeedback = {
  id: string;
  user_id: string | null;
  user_name: string | null;
  serial_number: string | null;
  rating: string | null;
  note: string | null;
  created_at: string | null;
  left: ChamberAverages;
  right: ChamberAverages;
};

function mean(xs: number[]): number | null {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
}

export function averageReadings(readings: Reading[] | undefined): ChamberAverages {
  const rows = readings ?? [];
  const hum = rows.map(r => r.humidity).filter((v): v is number => typeof v === 'number');
  const temp = rows.map(r => r.temperature).filter((v): v is number => typeof v === 'number');
  return { humidity: mean(hum), temperature: mean(temp), samples: rows.length };
}

type Row = Omit<CompostFeedback, 'left' | 'right'> & { readings_snapshot: Snapshot };

export function toFeedback(row: Row): CompostFeedback {
  const { readings_snapshot: snap, ...rest } = row;
  return { ...rest, left: averageReadings(snap?.left), right: averageReadings(snap?.right) };
}

export function useLovelyCompostFeedback() {
  const [feedback, setFeedback] = useState<CompostFeedback[]>([]);
  const [loading, setLoading] = useState<boolean>(isTelemetryConfigured);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!supabaseTelemetry) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: dbErr } = await supabaseTelemetry
        .from('compost_feedback')
        .select('id, user_id, user_name, serial_number, rating, note, readings_snapshot, created_at')
        .order('created_at', { ascending: false });
      if (dbErr) throw new Error(dbErr.message);
      setFeedback(((data ?? []) as Row[]).map(toFeedback));
    } catch (e) {
      setError((e as Error).message);
      setFeedback([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { feedback, loading, error, refetch };
}
