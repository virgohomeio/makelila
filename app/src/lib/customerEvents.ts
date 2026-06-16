import { useEffect, useState } from 'react';
import { supabase } from './supabase';

// Source-of-truth event stream for customer-side signals coming from the
// lilalovely app (and eventually shopify, klaviyo, system). Backed by
// public.customer_events + public.customer_engagement_summary view.
// Migration: supabase/migrations/20260608010000_customer_events_lovely_integration.sql
// Spec: docs/integration-lilalovely-2026-06-07.md

export type EventSource = 'lovely' | 'makelila' | 'shopify' | 'klaviyo' | 'system';

export type CustomerEvent = {
  id: string;
  customer_id: string | null;
  lovely_user_id: string | null;
  event_type: string;
  event_payload: Record<string, unknown>;
  source: EventSource;
  occurred_at: string;
  ingested_at: string;
};

export type EngagementSummary = {
  customer_id: string;
  email: string | null;
  full_name: string | null;
  lovely_user_id: string | null;
  app_first_seen_at: string | null;
  app_last_seen_at: string | null;
  last_dashboard_open_at: string | null;
  last_batch_seen_at: string | null;
  last_event_at: string | null;
  events_30d: number;
  events_7d: number;
  dormancy_days: number | null;
};

// Friendly per-event-type label + dot color for the timeline. Keeps the
// UI compact while still legible at a glance. Unknown types fall back to
// the raw event_type string + neutral color.
const EVENT_META: Record<string, { label: string; color: string }> = {
  'lovely.signup':              { label: 'Signed up',               color: '#2f855a' },
  'lovely.serial_paired':       { label: 'Paired their LILA',       color: '#2f855a' },
  'lovely.onboarding_step':     { label: 'Onboarding step',         color: '#2b6cb0' },
  'lovely.onboarding_done':     { label: 'Onboarding complete',     color: '#276749' },
  'lovely.dashboard_open':      { label: 'Opened dashboard',        color: '#5C564E' },
  'lovely.batch_complete_seen': { label: 'Saw batch complete',      color: '#276749' },
  'lovely.ota_accepted':        { label: 'Accepted firmware',       color: '#2b6cb0' },
  'lovely.damage_report':       { label: 'Reported damage',         color: '#c53030' },
  'lovely.push_opt_in':         { label: 'Push notifications on',   color: '#2f855a' },
  'lovely.push_opt_out':        { label: 'Push notifications off',  color: '#c05621' },
  'lovely.dormancy_30d':        { label: 'No login for 30 days',    color: '#c05621' },
  'lovely.dormancy_60d':        { label: 'No login for 60 days',    color: '#c53030' },
  'lovely.churn_signal':        { label: 'Churn signal',            color: '#c53030' },
};

export function eventMeta(eventType: string): { label: string; color: string } {
  return EVENT_META[eventType] ?? { label: eventType, color: '#5C564E' };
}

// Newest-first timeline of events for a single customer. Realtime: appends
// new rows as they ingest so the operator sees lovely behavior live.
export function useCustomerEvents(customerId: string | null | undefined) {
  const [events, setEvents] = useState<CustomerEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!customerId) {
      setEvents([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void supabase
      .from('customer_events')
      .select('id, customer_id, lovely_user_id, event_type, event_payload, source, occurred_at, ingested_at')
      .eq('customer_id', customerId)
      .order('occurred_at', { ascending: false })
      .limit(100)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('useCustomerEvents fetch:', error);
          setEvents([]);
        } else {
          setEvents((data ?? []) as CustomerEvent[]);
        }
        setLoading(false);
      });

    // Realtime: append as new events arrive.
    const channel = supabase
      .channel(`customer_events:${customerId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'customer_events', filter: `customer_id=eq.${customerId}` },
        (payload) => {
          const row = payload.new as CustomerEvent;
          setEvents((prev) => [row, ...prev].slice(0, 100));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [customerId]);

  return { events, loading };
}

// One-shot engagement summary read (used by JourneyTab badges + per-customer
// detail). Not realtime — refreshes on customerId change only.
export function useCustomerEngagement(customerId: string | null | undefined) {
  const [summary, setSummary] = useState<EngagementSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!customerId) {
      setSummary(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void supabase
      .from('customer_engagement_summary')
      .select('*')
      .eq('customer_id', customerId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('useCustomerEngagement fetch:', error);
          setSummary(null);
        } else {
          setSummary((data ?? null) as EngagementSummary | null);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [customerId]);

  return { summary, loading };
}

// Batch engagement read for the JourneyTab grid. Returns a Map keyed by
// customer_id so callers can do O(1) badge lookups in their render loop.
export function useCustomerEngagementMap(customerIds: string[] | undefined) {
  const [map, setMap] = useState<Map<string, EngagementSummary>>(new Map());

  // Stable key so we don't re-fetch on every render when the parent passes
  // a new array reference but the same IDs.
  const key = (customerIds ?? []).join(',');

  useEffect(() => {
    if (!customerIds || customerIds.length === 0) {
      setMap(new Map());
      return;
    }
    let cancelled = false;
    void supabase
      .from('customer_engagement_summary')
      .select('*')
      .in('customer_id', customerIds)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('useCustomerEngagementMap fetch:', error);
          setMap(new Map());
          return;
        }
        const m = new Map<string, EngagementSummary>();
        for (const row of (data ?? []) as EngagementSummary[]) {
          m.set(row.customer_id, row);
        }
        setMap(m);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return map;
}

// Dormancy → human label + warn/alert tone for badge rendering.
export function dormancyBadge(days: number | null | undefined):
  | { label: string; tone: 'good' | 'warn' | 'alert' }
  | null {
  if (days == null) return null;
  if (days <= 7)  return { label: 'active', tone: 'good' };
  if (days <= 30) return { label: `${days}d quiet`, tone: 'warn' };
  return { label: `${days}d dormant`, tone: 'alert' };
}
