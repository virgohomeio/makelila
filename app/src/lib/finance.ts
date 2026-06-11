import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ============================================================ Types

export type QboJournal = {
  id: string;
  date: string;
  currency: 'CAD' | 'USD';
  payment_channel: string;
  gross_sales: number;
  discounts: number;
  refunds: number;
  tax_collected: number;
  shipping: number;
  fees: number;
  net_deposit: number;
  qbo_journal_id: string | null;
  posted_at: string | null;
  error: string | null;
  created_at: string;
};

// ============================================================ Hooks

export function useQboJournals(from: string, to: string): {
  journals: QboJournal[];
  loading: boolean;
  error: string | null;
} {
  const [journals, setJournals] = useState<QboJournal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetch() {
    setLoading(true);
    const { data, error: err } = await supabase
      .from('qbo_daily_journals')
      .select('*')
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: false });
    if (err) {
      setError(err.message);
    } else {
      setJournals((data ?? []) as QboJournal[]);
      setError(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    fetch();

    let channel: RealtimeChannel | null = null;

    channel = supabase
      .channel('qbo_daily_journals')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'qbo_daily_journals' },
        () => { fetch(); },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'qbo_daily_journals' },
        () => { fetch(); },
      )
      .subscribe();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  return { journals, loading, error };
}

export function useQboOAuthStatus(): {
  refreshExpiresAt: string | null;
  accessExpiresAt: string | null;
  loading: boolean;
} {
  const [refreshExpiresAt, setRefreshExpiresAt] = useState<string | null>(null);
  const [accessExpiresAt, setAccessExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      const { data } = await supabase
        .from('qbo_oauth')
        .select('refresh_token_expires_at, access_token_expires_at')
        .limit(1)
        .maybeSingle();
      setRefreshExpiresAt(data?.refresh_token_expires_at ?? null);
      setAccessExpiresAt(data?.access_token_expires_at ?? null);
      setLoading(false);
    }
    fetch();
  }, []);

  return { refreshExpiresAt, accessExpiresAt, loading };
}

// ============================================================ Pure helpers

export const QBO_TOKEN_WARNING_DAYS = 14;

/**
 * Returns true if the given ISO date string is within 14 days of now
 * (or already past), so the UI can warn that a QBO OAuth token is expiring.
 * Returns false for null (token not yet fetched / no expiry recorded).
 */
export function isTokenExpiringSoon(expiresAt: string | null): boolean {
  if (expiresAt === null) return false;
  const expiresMs = Date.parse(expiresAt);
  if (isNaN(expiresMs)) return false;
  const nowMs = Date.now();
  const thresholdMs = QBO_TOKEN_WARNING_DAYS * 24 * 60 * 60 * 1000;
  return expiresMs - nowMs <= thresholdMs;
}

// ============================================================ Mutations

export async function repostJournal(id: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('qbo-post-journal', {
    body: { id },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error ?? 'Repost failed');
  await logAction('repost_journal', 'qbo_journal', id, { entityType: 'qbo_daily_journals', entityId: id });
}

// ============================================================ Production Projection

export type ProductionSnapshot = {
  id: string;
  as_of: string;
  batch_id: string;
  ready_count: number;
  reserved_count: number;
  weekly_velocity: number;
  projected_stockout_date: string | null;
  inbound_units: number;
  inbound_arrival_date: string | null;
  replacement_queue_size: number;
  risk_level: 'green' | 'amber' | 'red';
  created_at: string;
};

/** Per-batch projection computed live from units + orders data. */
export type BatchProjection = {
  batchId: string;
  batchLabel: string;       // e.g. "P100X" or manufacturer_short
  readyCount: number;
  reservedCount: number;
  weeklyVelocity: number;   // units shipped per week, 12-week trailing average
  projectedStockoutDate: string | null;   // ISO date or null if never runs out
  replacementQueueSize: number;
  inboundUnits: number;
  inboundArrivalDate: string | null;
  riskLevel: 'green' | 'amber' | 'red';
};

/**
 * Pure function. Given ready + velocity + replacementQueue + optional inbound,
 * returns the projected ISO date when stock hits zero (or null if it doesn't).
 * velocity is units/week. Uses 7-day weeks from today.
 */
export function projectStockout(params: {
  ready: number;
  velocity: number;
  replacementQueue: number;
  inboundUnits?: number;
  inboundArrivalDate?: string | null;
  today?: string;   // ISO date, defaults to new Date().toISOString().slice(0,10)
}): string | null {
  const { ready, velocity, replacementQueue, inboundUnits = 0, inboundArrivalDate = null } = params;
  const todayStr = params.today ?? new Date().toISOString().slice(0, 10);
  const todayMs = Date.parse(todayStr);

  if (velocity <= 0) return null;   // no demand → never runs out

  let stock = ready;
  const totalDemand = replacementQueue;   // near-term committed demand

  // If committed demand already exceeds ready stock, stockout is today
  if (totalDemand >= stock && inboundUnits === 0) {
    return todayStr;
  }

  // Simulate week-by-week
  const MAX_WEEKS = 104;  // 2 years
  for (let w = 0; w < MAX_WEEKS; w++) {
    const weekStartMs = todayMs + w * 7 * 24 * 3600_000;
    const weekEndMs = weekStartMs + 7 * 24 * 3600_000;

    // Add inbound batch if it arrives this week
    if (inboundUnits > 0 && inboundArrivalDate) {
      const arrivalMs = Date.parse(inboundArrivalDate);
      if (arrivalMs >= weekStartMs && arrivalMs < weekEndMs) {
        stock += inboundUnits;
      }
    }

    stock -= velocity;
    if (stock <= 0) {
      const stockoutMs = weekStartMs + ((stock + velocity) / velocity) * 7 * 24 * 3600_000;
      return new Date(stockoutMs).toISOString().slice(0, 10);
    }
  }
  return null;  // doesn't run out within 2 years
}

/**
 * Compute risk level from projected stockout date.
 * green = >90 days away (or never), amber = 30–90 days, red = <30 days.
 */
export function computeRiskLevel(
  projectedStockoutDate: string | null,
  today?: string,
): 'green' | 'amber' | 'red' {
  if (!projectedStockoutDate) return 'green';
  const todayMs = Date.parse(today ?? new Date().toISOString().slice(0, 10));
  const stockoutMs = Date.parse(projectedStockoutDate);
  const daysUntil = (stockoutMs - todayMs) / (24 * 3600_000);
  if (daysUntil < 30) return 'red';
  if (daysUntil < 90) return 'amber';
  return 'green';
}

/** Hook: loads production_projection_snapshots for a given batch, newest-first. */
export function useProductionSnapshots(batchId: string): {
  snapshots: ProductionSnapshot[];
  loading: boolean;
} {
  const [snapshots, setSnapshots] = useState<ProductionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!batchId) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('production_projection_snapshots')
        .select('*')
        .eq('batch_id', batchId)
        .order('as_of', { ascending: false })
        .limit(30);
      if (!cancelled) {
        if (error) console.error('useProductionSnapshots:', error.message);
        setSnapshots((data ?? []) as ProductionSnapshot[]);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [batchId]);

  return { snapshots, loading };
}
