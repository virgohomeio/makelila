import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ── Types ──────────────────────────────────────────────────────────────────

export type ShipmentStatus =
  | 'booked' | 'in_transit' | 'delivered'
  | 'exception' | 'missing' | 'cancelled';

export type Shipment = {
  id: string;
  order_id: string;
  freightcom_shipment_id: string;
  carrier: string;
  service: string;
  rate_cad: number | null;
  transit_days: number | null;
  label_url: string | null;
  primary_tracking_number: string | null;
  status: ShipmentStatus;
  booked_at: string;
  booked_by: string | null;
};

export type ClaimStatus = 'open' | 'submitted' | 'resolved' | 'denied';
export type ClaimReason = 'damage' | 'lost' | 'late' | 'other';

export type Claim = {
  id: string;
  order_id: string;
  shipment_id: string | null;
  reason: ClaimReason;
  amount_cad: number | null;
  status: ClaimStatus;
  notes: string | null;
  filed_at: string;
  filed_by: string | null;
  resolved_at: string | null;
};

// Row returned by useShippingOrders — combines order + fulfillment + shipment state
export type ShippingOrderRow = {
  order_id: string;
  order_ref: string;
  customer_name: string;
  city: string;
  region_state: string | null;
  country: string;
  fulfillment_step: number;
  shipment_status: ShipmentStatus | null; // null = not yet booked
  shipment_id: string | null;
};

export type TrackingEvent = {
  timestamp: string;
  location: string | null;
  description: string;
  [key: string]: unknown;
};

export type FreightcomInvoice = {
  id: string;
  type: string;
  number: string;
  date: string;
  due_date: string | null;
  amount: string;
  owing: string;
  [key: string]: unknown;
};

// ── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Returns all orders at fulfillment step >= 3, annotated with their
 * shipment status (null = not booked yet). Used by the left panel.
 */
export function useShippingOrders(): { orders: ShippingOrderRow[]; loading: boolean } {
  const [orders, setOrders] = useState<ShippingOrderRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [queueRes, shipmentRes] = await Promise.all([
        supabase
          .from('fulfillment_queue')
          .select('order_id, step, orders(id, order_ref, customer_name, city, region_state, country)')
          .gte('step', 3),
        supabase
          .from('shipments')
          .select('order_id, id, status'),
      ]);

      if (cancelled) return;

      const shipmentMap = new Map<string, { id: string; status: ShipmentStatus }>(
        ((shipmentRes.data ?? []) as Array<{ order_id: string; id: string; status: ShipmentStatus }>)
          .map(s => [s.order_id, { id: s.id, status: s.status }]),
      );

      const rows: ShippingOrderRow[] = (
        (queueRes.data ?? []) as Array<{
          order_id: string;
          step: number;
          orders: { id: string; order_ref: string; customer_name: string; city: string; region_state: string | null; country: string } | null;
        }>
      ).map(fq => {
        const o = fq.orders;
        const s = shipmentMap.get(fq.order_id) ?? null;
        return {
          order_id: fq.order_id,
          order_ref: o?.order_ref ?? '',
          customer_name: o?.customer_name ?? '',
          city: o?.city ?? '',
          region_state: o?.region_state ?? null,
          country: o?.country ?? 'CA',
          fulfillment_step: fq.step,
          shipment_status: s ? s.status : null,
          shipment_id: s ? s.id : null,
        };
      });

      setOrders(rows);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { orders, loading };
}

/** Returns the single shipment for an order (null if not booked). */
export function useShipment(orderId: string | null): { shipment: Shipment | null; loading: boolean } {
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderId) { setShipment(null); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('shipments')
        .select('*')
        .eq('order_id', orderId)
        .maybeSingle();
      if (!cancelled) {
        if (!error && data) setShipment(data as Shipment);
        else setShipment(null);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orderId]);

  return { shipment, loading };
}

/** Returns all claims for an order. */
export function useClaims(orderId: string | null): { claims: Claim[]; loading: boolean } {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderId) { setClaims([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('claims')
        .select('*')
        .eq('order_id', orderId)
        .order('filed_at', { ascending: false });
      if (!cancelled) {
        if (!error && data) setClaims(data as Claim[]);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orderId]);

  return { claims, loading };
}

// ── Mutations ──────────────────────────────────────────────────────────────

/** Books a shipment via the freightcom-book edge function. Returns the new Shipment row. */
export async function bookShipment(orderId: string, quoteId: string): Promise<Shipment> {
  const { data, error } = await supabase.functions.invoke('freightcom-book', {
    body: { order_id: orderId, quote_id: quoteId },
  });
  if (error) throw new Error(error.message);
  const shipment = (data as { shipment: Shipment }).shipment;
  await logAction(
    'shipment_booked',
    orderId,
    `freightcom_id=${shipment.freightcom_shipment_id} carrier=${shipment.carrier}`,
    { entityType: 'order', entityId: orderId },
  );
  return shipment;
}

/** Files a new internal claim. */
export async function fileClaim(
  orderId: string,
  shipmentId: string | null,
  reason: ClaimReason,
  amountCad: number | null,
  notes: string | null,
): Promise<Claim> {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('claims')
    .insert({
      order_id: orderId,
      shipment_id: shipmentId,
      reason,
      amount_cad: amountCad,
      notes,
      filed_by: user?.id ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  await logAction(
    'claim_filed',
    orderId,
    `reason=${reason} amount=${amountCad ?? 0}`,
    { entityType: 'order', entityId: orderId },
  );
  return data as Claim;
}

/** Updates the status of an existing claim. */
export async function updateClaimStatus(claimId: string, orderId: string, status: ClaimStatus): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === 'resolved' || status === 'denied') {
    patch.resolved_at = new Date().toISOString();
  }
  const { error } = await supabase
    .from('claims')
    .update(patch)
    .eq('id', claimId);
  if (error) throw new Error(error.message);
  await logAction(
    'claim_status_updated',
    orderId,
    `claim_id=${claimId} status=${status}`,
    { entityType: 'order', entityId: orderId },
  );
}

/** Fetches live tracking events from Freightcom. */
export async function fetchTrackingEvents(freightcomShipmentId: string): Promise<TrackingEvent[]> {
  const { data, error } = await supabase.functions.invoke('freightcom-tracking', {
    body: { freightcom_shipment_id: freightcomShipmentId },
  });
  if (error) throw new Error(error.message);
  return (data as { events: TrackingEvent[] }).events ?? [];
}

/** Fetches Freightcom invoices. Mode 'shipment' = for one shipment; 'date_range' = last N days. */
export async function fetchInvoices(
  mode: 'shipment' | 'date_range',
  opts: { freightcomShipmentId?: string; days?: number },
): Promise<FreightcomInvoice[]> {
  const { data, error } = await supabase.functions.invoke('freightcom-invoices', {
    body: { mode, ...opts },
  });
  if (error) throw new Error(error.message);
  return (data as { invoices: FreightcomInvoice[] }).invoices ?? [];
}
