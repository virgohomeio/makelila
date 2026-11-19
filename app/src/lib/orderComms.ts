// Data layer for the Sales-tab customer communication indicator.
//
// Reads public.order_comm_assessments — the verdict the
// assess-order-communication edge function writes after reading a customer's
// Quo and support-email history. Nothing here decides anything: the wording
// and the tone come from lib/commAssessment.ts (mirrored into the edge
// function, so the operator reads the same sentence the model produced), and
// this file only fetches, subscribes, and asks for a re-check.
//
// Spec: docs/superpowers/specs/2026-09-10-order-communication-indicator-design.md

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { functionErrorMessage } from './functionError';
import type {
  ChannelsScanned, CommConcern, CommEvidence, CommVerdict,
} from './commAssessment';

export type OrderCommAssessment = {
  order_id: string;
  verdict: CommVerdict;
  headline: string;
  concerns: CommConcern[];
  evidence: CommEvidence[];
  channels_scanned: ChannelsScanned | null;
  message_count: number;
  last_message_at: string | null;
  model: string | null;
  assessed_at: string;
  error: string | null;
};

const COLUMNS =
  'order_id, verdict, headline, concerns, evidence, channels_scanned, message_count, last_message_at, model, assessed_at, error';

/** The verdict for one order, live.
 *
 *  Fetch-then-subscribe, and re-fetch on every rejoin: the cron can finish
 *  seconds after an operator opens the detail panel, and a socket that drops
 *  in between would otherwise strand the card on "not yet assessed" for the
 *  rest of the session. */
export function useOrderCommAssessment(orderId: string | null | undefined): {
  assessment: OrderCommAssessment | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [assessment, setAssessment] = useState<OrderCommAssessment | null>(null);
  const [loading, setLoading] = useState(true);
  const liveRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!orderId) { setAssessment(null); return; }
    const { data, error } = await supabase
      .from('order_comm_assessments')
      .select(COLUMNS)
      .eq('order_id', orderId)
      .maybeSingle();
    if (!liveRef.current) return;
    if (error) {
      console.error('useOrderCommAssessment fetch:', error);
      return;
    }
    setAssessment((data ?? null) as OrderCommAssessment | null);
  }, [orderId]);

  useEffect(() => {
    liveRef.current = true;
    if (!orderId) { setAssessment(null); setLoading(false); return; }

    let channel: RealtimeChannel | null = null;
    let joined = false;
    setLoading(true);

    void (async () => {
      await refresh();
      if (!liveRef.current) return;
      setLoading(false);

      channel = supabase
        .channel(`order_comm_assessments:${orderId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'order_comm_assessments', filter: `order_id=eq.${orderId}` },
          (payload) => {
            if (payload.eventType === 'DELETE') { setAssessment(null); return; }
            if (payload.new) setAssessment(payload.new as OrderCommAssessment);
          },
        )
        .subscribe((status) => {
          if (status !== 'SUBSCRIBED') return;
          // First join is covered by the fetch above; every later one is a
          // reconnect and may have missed a write.
          if (!joined) { joined = true; return; }
          void refresh();
        });
    })();

    return () => {
      liveRef.current = false;
      // removeChannel, not unsubscribe — see the note on useRefundApprovals.
      if (channel) void supabase.removeChannel(channel);
    };
  }, [orderId, refresh]);

  return { assessment, loading, refresh };
}

/** Every verdict at once, keyed by order id, for the queue's row chips. One
 *  query for the whole list rather than one per row. */
export function useOrderCommAssessments(): {
  byOrderId: Record<string, OrderCommAssessment>;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [byOrderId, setByOrderId] = useState<Record<string, OrderCommAssessment>>({});
  const [loading, setLoading] = useState(true);
  const liveRef = useRef(true);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.from('order_comm_assessments').select(COLUMNS);
    if (!liveRef.current) return;
    if (error) {
      console.error('useOrderCommAssessments fetch:', error);
      return;
    }
    const next: Record<string, OrderCommAssessment> = {};
    for (const row of (data ?? []) as OrderCommAssessment[]) next[row.order_id] = row;
    setByOrderId(next);
  }, []);

  useEffect(() => {
    liveRef.current = true;
    let channel: RealtimeChannel | null = null;
    let joined = false;

    void (async () => {
      await refresh();
      if (!liveRef.current) return;
      setLoading(false);

      channel = supabase
        .channel('order_comm_assessments:all')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'order_comm_assessments' }, (payload) => {
          setByOrderId(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              const { [(payload.old as { order_id: string }).order_id]: _gone, ...rest } = prev;
              return rest;
            }
            if (payload.new) {
              const row = payload.new as OrderCommAssessment;
              return { ...prev, [row.order_id]: row };
            }
            return prev;
          });
        })
        .subscribe((status) => {
          if (status !== 'SUBSCRIBED') return;
          if (!joined) { joined = true; return; }
          void refresh();
        });
    })();

    return () => {
      liveRef.current = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [refresh]);

  return { byOrderId, loading, refresh };
}

/** Re-reads one order's communication now, bypassing the fingerprint cache.
 *  Backs the card's "Re-check" button — used when an operator has just spoken
 *  to the customer and does not want to wait for the 15-minute sweep. */
export async function requestCommAssessment(orderId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('assess-order-communication', {
    body: { order_id: orderId },
  });
  if (error) throw new Error(await functionErrorMessage(error));
}
