import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ── Types ──────────────────────────────────────────────────────────────────

export type ShipmentStatus =
  | 'booked' | 'in_transit' | 'delivered'
  | 'exception' | 'missing' | 'cancelled';

// ── Freightcom status vocabulary (dashboard source of truth) ────────────────

export const FREIGHTCOM_STATUSES = [
  'waiting-for-transit', 'in-transit', 'delivered',
  'exception', 'missing', 'cancelled',
] as const;
export type FreightcomStatus = typeof FREIGHTCOM_STATUSES[number];

/** True when a raw value is one of the 6 known statuses (else grouped as "other"). */
export function isKnownFreightcomStatus(v: string): v is FreightcomStatus {
  return (FREIGHTCOM_STATUSES as readonly string[]).includes(v);
}

// ── Shipment direction + counterparty name ─────────────────────────────────

export type ShipmentDirection = 'outbound' | 'return';

/** Provenance blob stored on imported shipments (subset we read). */
export type ShipmentRawPayload = {
  direction?: string;
  ship_to_name?: string;
  ship_from_name?: string;
} | null;

export type ShipmentParty = { direction: ShipmentDirection; counterparty_name: string };

/**
 * Derives the shipment's direction and the "other party" name to show as the
 * Customer. Outbound → the recipient (ship_to_name); return → the sender
 * (ship_from_name). Falls back to the linked order's customer name for
 * makelila-booked shipments that carry no raw_payload.
 */
export function deriveShipmentParty(args: {
  raw_payload: ShipmentRawPayload;
  order_customer_name: string | null;
}): ShipmentParty {
  const rp = args.raw_payload ?? {};
  const direction: ShipmentDirection = rp.direction === 'return' ? 'return' : 'outbound';
  const fromRaw = direction === 'return' ? rp.ship_from_name : rp.ship_to_name;
  const counterparty_name = (fromRaw || args.order_customer_name || '').trim();
  return { direction, counterparty_name };
}

/** Reverse-map the internal enum to Freightcom's vocabulary for never-synced rows. */
const INTERNAL_TO_FREIGHTCOM: Record<ShipmentStatus, string> = {
  booked:     'waiting-for-transit',
  in_transit: 'in-transit',
  delivered:  'delivered',
  exception:  'exception',
  missing:    'missing',
  cancelled:  'cancelled',
};

/**
 * Resolves the Freightcom-vocabulary status to show for a row:
 * stored raw value wins; otherwise reverse-map the internal status.
 */
export function displayFreightcomStatus(
  row: { status: ShipmentStatus; freightcom_status: string | null },
): string {
  if (row.freightcom_status) return row.freightcom_status;
  return INTERNAL_TO_FREIGHTCOM[row.status] ?? row.status;
}

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
export function useShippingOrders(): { orders: ShippingOrderRow[]; loading: boolean; error: string | null } {
  const [orders, setOrders] = useState<ShippingOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

      if (queueRes.error) {
        setError(queueRes.error.message);
        setLoading(false);
        return;
      }
      if (shipmentRes.error) {
        setError(shipmentRes.error.message);
        setLoading(false);
        return;
      }

      const shipmentMap = new Map<string, { id: string; status: ShipmentStatus }>(
        ((shipmentRes.data ?? []) as Array<{ order_id: string; id: string; status: ShipmentStatus }>)
          .map(s => [s.order_id, { id: s.id, status: s.status }]),
      );

      const rows: ShippingOrderRow[] = (
        (queueRes.data ?? []) as unknown as Array<{
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

  return { orders, loading, error };
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
        else {
          if (error) console.error('useShipment error:', error.message);
          setShipment(null);
        }
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
        else if (error) console.error('useClaims error:', error.message);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orderId]);

  return { claims, loading };
}

export type AllShipmentRow = {
  id: string;
  order_id: string;
  order_ref: string;
  customer_name: string;
  carrier: string;
  service: string;
  rate_cad: number | null;
  primary_tracking_number: string | null;
  status: ShipmentStatus;
  booked_at: string;
  label_url: string | null;
  freightcom_shipment_id: string;
  freightcom_status: string | null;
  status_synced_at: string | null;
  direction: ShipmentDirection;
  counterparty_name: string;
};

export type AllClaimRow = Claim & {
  order_ref: string;
  customer_name: string;
};

// Columns that exist regardless of whether the freightcom_status migration ran.
const SHIPMENT_BASE_COLS =
  'id, order_id, carrier, service, rate_cad, primary_tracking_number, status, booked_at, label_url, freightcom_shipment_id, raw_payload';

/** True for a Postgres "undefined column" error (42703) — the migration isn't applied. */
export function isMissingColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '42703' || /column .* does not exist/i.test(err.message ?? '');
}

/** Returns all shipments across all orders, joined with order_ref + customer_name. */
export function useAllShipments(): { shipments: AllShipmentRow[]; loading: boolean; error: string | null } {
  const [shipments, setShipments] = useState<AllShipmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Try the full select (with the Freightcom-status columns). If the
      // migration that adds them hasn't been applied yet, Postgres returns
      // 42703 "column does not exist" — fall back to the base columns so the
      // dashboard still renders (statuses come from the reverse-mapping).
      let { data, error: err } = await supabase
        .from('shipments')
        .select(`${SHIPMENT_BASE_COLS}, freightcom_status, status_synced_at, orders(order_ref, customer_name)`)
        .order('booked_at', { ascending: false });

      if (!cancelled && err && isMissingColumnError(err)) {
        ({ data, error: err } = await supabase
          .from('shipments')
          .select(`${SHIPMENT_BASE_COLS}, orders(order_ref, customer_name)`)
          .order('booked_at', { ascending: false }));
      }

      if (cancelled) return;
      if (err) { setError(err.message); setLoading(false); return; }
      const rows: AllShipmentRow[] = ((data ?? []) as unknown as Array<{
        id: string; order_id: string; carrier: string; service: string;
        rate_cad: number | null; primary_tracking_number: string | null;
        status: string; booked_at: string; label_url: string | null;
        freightcom_shipment_id: string;
        freightcom_status?: string | null; status_synced_at?: string | null;
        raw_payload?: ShipmentRawPayload;
        orders: { order_ref: string; customer_name: string } | null;
      }>).map(s => {
        const party = deriveShipmentParty({
          raw_payload: s.raw_payload ?? null,
          order_customer_name: s.orders?.customer_name ?? null,
        });
        return {
          id: s.id,
          order_id: s.order_id,
          order_ref: s.orders?.order_ref ?? '',
          customer_name: s.orders?.customer_name ?? '',
          carrier: s.carrier,
          service: s.service,
          rate_cad: s.rate_cad,
          primary_tracking_number: s.primary_tracking_number,
          status: s.status as ShipmentStatus,
          booked_at: s.booked_at,
          label_url: s.label_url,
          freightcom_shipment_id: s.freightcom_shipment_id,
          freightcom_status: s.freightcom_status ?? null,
          status_synced_at: s.status_synced_at ?? null,
          direction: party.direction,
          counterparty_name: party.counterparty_name,
        };
      });
      setShipments(rows);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { shipments, loading, error };
}

/** Returns all claims across all orders, joined with order_ref + customer_name. */
export function useAllClaims(): { claims: AllClaimRow[]; loading: boolean; error: string | null } {
  const [claims, setClaims] = useState<AllClaimRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('claims')
        .select('*, orders(order_ref, customer_name)')
        .order('filed_at', { ascending: false });
      if (cancelled) return;
      if (err) { setError(err.message); setLoading(false); return; }
      const rows: AllClaimRow[] = ((data ?? []) as unknown as Array<Claim & {
        orders: { order_ref: string; customer_name: string } | null;
      }>).map(c => ({
        ...c,
        order_ref: c.orders?.order_ref ?? '',
        customer_name: c.orders?.customer_name ?? '',
      }));
      setClaims(rows);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { claims, loading, error };
}

// ── Mutations ──────────────────────────────────────────────────────────────

/** Books a shipment via the freightcom-book edge function. Returns the new Shipment row. */
export async function bookShipment(orderId: string, quoteId: string): Promise<Shipment> {
  const { data, error } = await supabase.functions.invoke('freightcom-book', {
    body: { order_id: orderId, quote_id: quoteId },
  });
  if (error) throw new Error(error.message);
  const shipment = (data as { shipment?: Shipment }).shipment;
  if (!shipment) throw new Error('freightcom-book: unexpected response shape');
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
  if (!user) throw new Error('Not authenticated');
  const { data, error } = await supabase
    .from('claims')
    .insert({
      order_id: orderId,
      shipment_id: shipmentId,
      reason,
      amount_cad: amountCad,
      notes,
      filed_by: user.id,
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

/**
 * Pulls live Freightcom status for the given shipments and persists it.
 * Returns the per-shipment results from the edge function.
 */
export async function refreshFreightcomStatuses(
  rows: Array<{ id: string; freightcom_shipment_id: string }>,
): Promise<Array<{ id: string; freightcom_status: string | null; error?: string }>> {
  const payload = rows
    .filter(r => r.freightcom_shipment_id)
    .map(r => ({ id: r.id, freightcom_shipment_id: r.freightcom_shipment_id }));
  if (payload.length === 0) return [];
  const { data, error } = await supabase.functions.invoke('freightcom-status', {
    body: { shipments: payload },
  });
  if (error) throw new Error(error.message);
  const results = (data as { results?: Array<{ id: string; freightcom_status: string | null; error?: string }> }).results ?? [];
  await logAction('shipment_status_refreshed', 'shipments', `count=${payload.length}`);
  return results;
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
