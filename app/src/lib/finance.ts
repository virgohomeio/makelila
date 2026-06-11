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

// ============================================================ Mutations

export async function repostJournal(id: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('qbo-post-journal', {
    body: { id },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error ?? 'Repost failed');
  // entityType 'qbo_daily_journals' is not yet in the EntityType union;
  // pass entityId only so the row is still queryable by id.
  await logAction('repost_journal', 'qbo_journal', id, { entityId: id });
}
