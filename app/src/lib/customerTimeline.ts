import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';
import { updateCustomerProfile } from './customers';
import type { Customer } from './customers';
import type { Order } from './orders';
import type { Unit } from './stock';
import type { CustomerLifecycle, ServiceTicket } from './service';
import type { CustomerEvent } from './customerEvents';

// Customers > Timelines — when each thing happened to each customer, and how
// long each gap took.
//
// The Journey tab answers "which stage is this customer in". This answers "on
// what date", which is a different question and the reason Journey carries no
// dates. Six milestones, in order, plus the diagnosis-call log.
//
// Every milestone is DERIVED from data the app already has, and every milestone
// can be OVERRIDDEN by an operator typing a date. The override wins and never
// destroys the derivation — clear it and the derived value comes back.
//
// Spec: docs/superpowers/specs/2026-10-07-customer-timelines-tab-design.md

// ── Milestones ──────────────────────────────────────────────────────────────

export type MilestoneKey =
  | 'ordered' | 'shipped' | 'received' | 'onboarding_call' | 'onboarded' | 'first_use';

/** Where a manual date for this milestone is stored.
 *
 *  Three of the six already have an operator-writable column on `customers`
 *  that the rest of the app reads — `onboard_date` in particular is the anchor
 *  the FU1/FU2 follow-up calendar counts from. Those write to the column, so a
 *  date typed here moves the number every other screen shows. The remaining
 *  three have nowhere to live and use customer_timeline_milestones.
 *
 *  Callers never branch on this: setMilestoneOverride dispatches on it. */
type OverrideStore =
  | { kind: 'customer_column'; column: 'shipped_on' | 'received_on' | 'onboard_date' }
  | { kind: 'milestone_table' };

export type MilestoneDef = {
  key: MilestoneKey;
  /** Column header in the matrix. Kept short — six of these share a row. */
  short: string;
  /** Full name, used in the detail panel and the CSV. */
  label: string;
  /** What the derived value actually measures, shown as the column's title text. */
  description: string;
  store: OverrideStore;
};

export const MILESTONES: readonly MilestoneDef[] = [
  {
    key: 'ordered', short: 'Ordered', label: 'Order placed',
    description: 'Earliest sale order placed by this customer (orders.placed_at).',
    store: { kind: 'milestone_table' },
  },
  {
    key: 'shipped', short: 'Shipped', label: 'Machine shipped',
    description: 'First machine leaving the dock — units.shipped_at, else customer_lifecycle, else the order.',
    store: { kind: 'customer_column', column: 'shipped_on' },
  },
  {
    key: 'received', short: 'Received', label: 'Machine received',
    description: 'Carrier-confirmed delivery of the first machine (shipments.delivered_at), else the order’s own delivered_at.',
    store: { kind: 'customer_column', column: 'received_on' },
  },
  {
    key: 'onboarding_call', short: 'Onb. call', label: 'Onboarding call',
    description: 'The booked onboarding walkthrough. This is customers.onboard_date — the date the FU1/FU2 follow-up calendar counts from.',
    store: { kind: 'customer_column', column: 'onboard_date' },
  },
  {
    key: 'onboarded', short: 'Onboarded', label: 'Onboarding complete',
    description: 'Onboarding signed off — customer_lifecycle.onboarding_completed_at, else the Lovely app’s onboarding_done event.',
    store: { kind: 'milestone_table' },
  },
  {
    key: 'first_use', short: 'First use', label: 'Started using the machine',
    description: 'Earliest signal the customer actually used their LILA — their first Lovely app event.',
    store: { kind: 'milestone_table' },
  },
];

/** The three keys customer_timeline_milestones is allowed to hold. Mirrors the
 *  CHECK constraint in 20261007140000_customer_timeline_milestones.sql. */
export const TABLE_MILESTONE_KEYS: MilestoneKey[] =
  MILESTONES.filter(m => m.store.kind === 'milestone_table').map(m => m.key);

export function milestoneDef(key: MilestoneKey): MilestoneDef {
  const def = MILESTONES.find(m => m.key === key);
  if (!def) throw new Error(`Unknown timeline milestone: ${key}`);
  return def;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export type TimelineOverride = {
  id: string;
  customer_id: string;
  milestone: MilestoneKey;
  occurred_at: string;     // 'YYYY-MM-DD'
  note: string | null;
  set_by: string | null;
  created_at: string;
  updated_at: string;
};

export type DiagnosisCall = {
  id: string;
  customer_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  occurred_at: string;
  duration_minutes: number | null;
  /** false = the customer no-showed. A no-show is still a call that happened on
   *  the calendar and is still billed, so it stays in the timeline — labelled. */
  attended: boolean | null;
  title: string | null;
};

/** One customer's delivery confirmations, pulled off `shipments` rather than
 *  `AllShipmentRow`: that type is cost-shaped (invoices, surcharges, fuel) and
 *  carries no delivered_at at all. */
export type DeliveryRow = { order_id: string; delivered_at: string };

/** When a customer's Lovely app account was first seen. `customer_app_links` is
 *  the account link rather than the event stream, so it answers for a customer
 *  who paired an account before any event type we ingest fired. */
export type AppLinkRow = { customer_id: string; first_seen_at: string | null };

/** The slice of an order a timeline reads. Structurally satisfied by a full
 *  `Order`, so callers holding one can pass it straight through. */
export type TimelineOrder = Pick<
  Order, 'id' | 'customer_id' | 'kind' | 'placed_at' | 'shipped_at' | 'delivered_at'
>;

/** A resolved milestone. `date` is null when nothing — derived or manual —
 *  answered for this customer. */
export type MilestoneValue = {
  key: MilestoneKey;
  /** 'YYYY-MM-DD', or null when unknown. Normalised to a calendar day so a
   *  timestamped derivation and a typed date compare and diff the same way. */
  date: string | null;
  /** True when an operator typed this date. The matrix marks these. */
  manual: boolean;
  /** Which table answered, e.g. 'units.shipped_at'. Printed in the detail panel
   *  so a Freightcom-confirmed delivery is distinguishable from an inferred one.
   *  A fallback chain is not a silent equivalence. */
  source: string | null;
  /** Present only on a manual value. */
  setBy?: string | null;
  note?: string | null;
  /** The derivation a manual value is sitting on top of, when there was one.
   *  Lets the panel show "you typed Mar 4; the data says Mar 6". */
  derived?: string | null;
};

export type CustomerTimeline = {
  customer: Customer;
  milestones: Record<MilestoneKey, MilestoneValue>;
  /** Newest first. */
  diagnosisCalls: DiagnosisCall[];
  /** True when this customer has ever had a machine shipped to them. The
   *  matrix defaults to these: a lead who only ever placed an order has no
   *  timeline to speak of. */
  ownsMachine: boolean;
};

// ── Day normalisation ───────────────────────────────────────────────────────

/** An ISO timestamp or date → 'YYYY-MM-DD', or null.
 *
 *  Deliberately a string slice rather than `new Date(iso)`, which would shift a
 *  UTC-midnight timestamp back a day for every operator west of Greenwich — and
 *  this team is in Toronto and Vancouver. Postgres `date` columns already
 *  arrive as 'YYYY-MM-DD'. */
export function toDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : null;
}

/** Whole days between two 'YYYY-MM-DD' days, or null when either is missing.
 *
 *  Null rather than 0 for a missing end: a gap we cannot measure must never
 *  render as "same day", which is what made the first version of the Durations
 *  view look like every customer onboarded instantly. */
export function gapDays(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** How a gap between two milestones should read.
 *
 *  'backwards' is not a cosmetic case: 3 of the 101 customers with both a ship
 *  and a delivery date have the delivery EARLIER than the ship stamp, by up to
 *  31 days — a mis-linked unit or a replacement's delivery dated against the
 *  original. Rendering that as "-31d" in the same colour as a 3-day delivery
 *  would hide a data error inside a performance number, so it gets its own
 *  treatment. The thresholds above it are business judgement: a week from dock
 *  to door is normal freight, a month is worth a phone call. */
export type GapSeverity = 'unknown' | 'normal' | 'slow' | 'stalled' | 'backwards';

export function gapSeverity(days: number | null): GapSeverity {
  if (days == null) return 'unknown';
  if (days < 0) return 'backwards';
  if (days >= 30) return 'stalled';
  if (days >= 14) return 'slow';
  return 'normal';
}

/** The earliest of a set of candidate days. */
function earliest(...days: (string | null)[]): string | null {
  const present = days.filter((d): d is string => !!d).sort();
  return present[0] ?? null;
}

// ── Derivation ──────────────────────────────────────────────────────────────

export type TimelineInputs = {
  customers: Customer[];
  orders: TimelineOrder[];
  units: Unit[];
  lifecycle: CustomerLifecycle[];
  tickets: ServiceTicket[];
  events: CustomerEvent[];
  appLinks: AppLinkRow[];
  deliveries: DeliveryRow[];
  diagnosisCalls: DiagnosisCall[];
  overrides: TimelineOverride[];
};

/** A derived candidate: the day plus which table produced it. */
type Derived = { date: string | null; source: string | null };

function firstOf(...candidates: Derived[]): Derived {
  for (const c of candidates) if (c.date) return c;
  return { date: null, source: null };
}

/** Build every customer's timeline from already-loaded rows.
 *
 *  Pure on purpose: the fallback chains and the override precedence are the part
 *  that can silently be wrong, and they are worth unit-testing without a
 *  Supabase client in the way. */
export function buildTimelines(inputs: TimelineInputs): CustomerTimeline[] {
  const {
    customers, orders, units, lifecycle, tickets, events,
    appLinks, deliveries, diagnosisCalls, overrides,
  } = inputs;

  // ── Indexes, built once rather than per customer. At 404 customers × 283
  //    orders × 203 units a nested scan is ~2.3M comparisons on every keystroke
  //    in the search box.
  const deliveredByOrder = new Map<string, string>();
  for (const d of deliveries) {
    const day = toDay(d.delivered_at);
    if (!day) continue;
    const prev = deliveredByOrder.get(d.order_id);
    if (!prev || day < prev) deliveredByOrder.set(d.order_id, day);
  }

  const ordersByCustomer = new Map<string, TimelineOrder[]>();
  for (const o of orders) {
    if (!o.customer_id) continue;
    const list = ordersByCustomer.get(o.customer_id);
    if (list) list.push(o); else ordersByCustomer.set(o.customer_id, [o]);
  }

  // units.customer_id, not customers.serials: that array is a denormalised cache
  // last synced 2026-06-05 and 53 of 146 rows had drifted from the units table.
  const unitsByCustomer = new Map<string, Unit[]>();
  for (const u of units) {
    if (!u.customer_id) continue;
    const list = unitsByCustomer.get(u.customer_id);
    if (list) list.push(u); else unitsByCustomer.set(u.customer_id, [u]);
  }

  const lifecycleByCustomer = new Map<string, CustomerLifecycle[]>();
  for (const l of lifecycle) {
    if (!l.customer_id) continue;
    const list = lifecycleByCustomer.get(l.customer_id);
    if (list) list.push(l); else lifecycleByCustomer.set(l.customer_id, [l]);
  }

  const onboardingTicketsByCustomer = new Map<string, ServiceTicket[]>();
  for (const t of tickets) {
    if (!t.customer_id || t.category !== 'onboarding') continue;
    const list = onboardingTicketsByCustomer.get(t.customer_id);
    if (list) list.push(t); else onboardingTicketsByCustomer.set(t.customer_id, [t]);
  }

  const lovelyEventsByCustomer = new Map<string, CustomerEvent[]>();
  for (const e of events) {
    if (!e.customer_id || e.source !== 'lovely') continue;
    const list = lovelyEventsByCustomer.get(e.customer_id);
    if (list) list.push(e); else lovelyEventsByCustomer.set(e.customer_id, [e]);
  }

  const appFirstSeenByCustomer = new Map<string, string>();
  for (const a of appLinks) {
    const day = toDay(a.first_seen_at);
    if (!day) continue;
    const prev = appFirstSeenByCustomer.get(a.customer_id);
    if (!prev || day < prev) appFirstSeenByCustomer.set(a.customer_id, day);
  }

  const callsByCustomer = new Map<string, DiagnosisCall[]>();
  for (const c of diagnosisCalls) {
    if (!c.customer_id) continue;
    const list = callsByCustomer.get(c.customer_id);
    if (list) list.push(c); else callsByCustomer.set(c.customer_id, [c]);
  }

  const overrideByCustomer = new Map<string, Map<MilestoneKey, TimelineOverride>>();
  for (const o of overrides) {
    let m = overrideByCustomer.get(o.customer_id);
    if (!m) { m = new Map(); overrideByCustomer.set(o.customer_id, m); }
    m.set(o.milestone, o);
  }

  return customers.map(c => {
    const cOrders   = ordersByCustomer.get(c.id) ?? [];
    const sales     = cOrders.filter(o => o.kind === 'sale');
    const cUnits    = unitsByCustomer.get(c.id) ?? [];
    const cLife     = lifecycleByCustomer.get(c.id) ?? [];
    const cOnb      = onboardingTicketsByCustomer.get(c.id) ?? [];
    const cEvents   = lovelyEventsByCustomer.get(c.id) ?? [];
    const cCalls    = (callsByCustomer.get(c.id) ?? [])
      .slice()
      .sort((a, b) => (b.occurred_at ?? '').localeCompare(a.occurred_at ?? ''));
    const cOverride = overrideByCustomer.get(c.id);

    // ── Derived candidates, each with its fallback chain in best-first order.

    const ordered = firstOf(
      { date: earliest(...sales.map(o => toDay(o.placed_at))), source: 'orders.placed_at' },
    );

    // A shipped unit means a machine actually left; customer_lifecycle is the
    // follow-up pipeline's copy and orders.shipped_at is only 64 rows.
    const shipped = firstOf(
      { date: earliest(...cUnits.filter(u => u.status === 'shipped').map(u => toDay(u.shipped_at))), source: 'units.shipped_at' },
      { date: earliest(...cLife.map(l => toDay(l.shipped_at))),                                      source: 'customer_lifecycle.shipped_at' },
      { date: earliest(...sales.map(o => toDay(o.shipped_at))),                                      source: 'orders.shipped_at' },
    );

    // Freightcom's delivery confirmation first (156 of 158 shipments carry one);
    // orders.delivered_at is hand-set at the Fulfilled step and only 18 rows.
    const received = firstOf(
      { date: earliest(...sales.map(o => deliveredByOrder.get(o.id) ?? null)), source: 'shipments.delivered_at' },
      { date: earliest(...sales.map(o => toDay(o.delivered_at))),              source: 'orders.delivered_at' },
    );

    // onboard_date IS the operator-facing value here and is set from the
    // onboarding ticket automatically, so it leads; the ticket's own Calendly
    // start is the fallback for customers whose onboard_date was never written.
    const onboardingCall = firstOf(
      { date: toDay(c.onboard_date),                                              source: 'customers.onboard_date' },
      { date: earliest(...cOnb.map(t => toDay(t.calendly_event_start))),          source: 'service_tickets.calendly_event_start' },
    );

    const onboarded = firstOf(
      { date: earliest(...cLife.map(l => toDay(l.onboarding_completed_at))), source: 'customer_lifecycle.onboarding_completed_at' },
      {
        date: earliest(...cEvents.filter(e => e.event_type === 'lovely.onboarding_done').map(e => toDay(e.occurred_at))),
        source: 'customer_events lovely.onboarding_done',
      },
    );

    // The app-account link leads: it answers for a customer who paired before
    // any event type we ingest fired. Behind it, any Lovely app event at all.
    // Narrowing further — to a pairing or a first compost batch — would be more
    // precise and would resolve for almost nobody: only 18 serials have ever
    // started a batch, and compost_batches is not anon-readable from this
    // client anyway.
    const firstUse = firstOf(
      { date: appFirstSeenByCustomer.get(c.id) ?? null,            source: 'customer_app_links.first_seen_at' },
      { date: earliest(...cEvents.map(e => toDay(e.occurred_at))), source: 'customer_events (Lovely app)' },
    );

    const derivedByKey: Record<MilestoneKey, Derived> = {
      ordered, shipped, received, onboarding_call: onboardingCall, onboarded, first_use: firstUse,
    };

    const milestones = {} as Record<MilestoneKey, MilestoneValue>;
    for (const def of MILESTONES) {
      const d = derivedByKey[def.key];
      const manualDate = def.store.kind === 'customer_column'
        // The column IS the override store. When the derivation also reads that
        // column (onboard_date does), a value there is the operator's and is
        // reported as such; shipped_on / received_on are read nowhere else, so
        // anything in them was typed.
        ? toDay(c[def.store.column])
        : toDay(cOverride?.get(def.key)?.occurred_at);

      // onboard_date is both the override store and the first link of the
      // derivation chain, so a value there is not an "override" sitting on a
      // separate derived value — it is the value. Reporting it as manual with
      // itself as the derived underneath would print "you typed Mar 4; the data
      // says Mar 4" on 122 customers.
      const columnIsAlsoDerivation =
        def.store.kind === 'customer_column' && d.source === `customers.${def.store.column}`;

      if (manualDate && !columnIsAlsoDerivation) {
        const row = def.store.kind === 'milestone_table' ? cOverride?.get(def.key) : undefined;
        milestones[def.key] = {
          key: def.key,
          date: manualDate,
          manual: true,
          source: def.store.kind === 'customer_column'
            ? `customers.${def.store.column}`
            : 'customer_timeline_milestones',
          setBy: row?.set_by ?? null,
          note: row?.note ?? null,
          derived: d.date,
        };
      } else {
        milestones[def.key] = {
          key: def.key,
          date: manualDate ?? d.date,
          // Only reachable with a manualDate when the column IS the derivation,
          // and that is not an operator override — see columnIsAlsoDerivation.
          manual: false,
          source: d.source,
          derived: d.date,
        };
      }
    }

    return {
      customer: c,
      milestones,
      diagnosisCalls: cCalls,
      ownsMachine: !!(shipped.date || received.date || cUnits.length > 0),
    };
  });
}

/** The consecutive gaps the Durations view shows: each milestone against the
 *  previous one that actually has a date. Skipping blanks is the point — a
 *  customer with no Received date should still show how long shipped→onboarded
 *  took rather than two dashes. */
export function consecutiveGaps(t: CustomerTimeline): Record<MilestoneKey, number | null> {
  const out = {} as Record<MilestoneKey, number | null>;
  let prev: string | null = null;
  for (const def of MILESTONES) {
    const day = t.milestones[def.key].date;
    out[def.key] = day && prev ? gapDays(prev, day) : null;
    if (day) prev = day;
  }
  return out;
}

/** How many customers have a value for each milestone. Shown as the coverage
 *  strip so the holes in the integrations stay visible instead of reading as
 *  "these customers did not do this". */
export function coverage(rows: CustomerTimeline[]): Record<MilestoneKey, number> {
  const out = {} as Record<MilestoneKey, number>;
  for (const def of MILESTONES) {
    out[def.key] = rows.reduce((n, r) => n + (r.milestones[def.key].date ? 1 : 0), 0);
  }
  return out;
}

// ── Hooks ───────────────────────────────────────────────────────────────────

/** Carrier-confirmed deliveries, keyed by order. Only the two columns the
 *  timeline needs. */
export function useCustomerDeliveries(): { deliveries: DeliveryRow[]; loading: boolean } {
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase
        .from('shipments')
        .select('order_id, delivered_at')
        .not('delivered_at', 'is', null)
        .not('order_id', 'is', null);
      if (!live) return;
      setDeliveries((data ?? []) as DeliveryRow[]);
      setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  return { deliveries, loading };
}

/** Every sale order's dates.
 *
 *  NOT useOrders(): that returns the Sales queue's buckets, which start after
 *  SALES_QUEUE_START and deliberately exclude fulfilled and cancelled orders.
 *  A timeline needs the whole history — a customer who received their machine in
 *  March is exactly the one the Sales queue has dropped. */
export function useTimelineOrders(): { orders: TimelineOrder[]; loading: boolean } {
  const [orders, setOrders] = useState<TimelineOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase
        .from('orders')
        .select('id, customer_id, kind, placed_at, shipped_at, delivered_at')
        .not('customer_id', 'is', null);
      if (!live) return;
      setOrders((data ?? []) as TimelineOrder[]);
      setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  return { orders, loading };
}

/** Lovely app account links — the two columns the first-use derivation needs. */
export function useCustomerAppLinks(): { appLinks: AppLinkRow[]; loading: boolean } {
  const [appLinks, setAppLinks] = useState<AppLinkRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase
        .from('customer_app_links')
        .select('customer_id, first_seen_at')
        .not('customer_id', 'is', null);
      if (!live) return;
      setAppLinks((data ?? []) as AppLinkRow[]);
      setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  return { appLinks, loading };
}

/** Every Lovely-sourced customer event.
 *
 *  Filtered to source='lovely' in the query, not in the client: the table also
 *  holds ~2,500 Klaviyo marketing events that this screen must never read as
 *  machine use, and there is no reason to ship them to the browser. */
export function useLovelyEvents(): { events: CustomerEvent[]; loading: boolean } {
  const [events, setEvents] = useState<CustomerEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase
        .from('customer_events')
        .select('id, customer_id, lovely_user_id, event_type, source, occurred_at')
        .eq('source', 'lovely')
        .not('customer_id', 'is', null);
      if (!live) return;
      setEvents((data ?? []) as CustomerEvent[]);
      setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  return { events, loading };
}

export function useDiagnosisCalls(): { calls: DiagnosisCall[]; loading: boolean } {
  const [calls, setCalls] = useState<DiagnosisCall[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase
        .from('diagnosis_calls')
        .select('id, customer_id, customer_email, customer_name, occurred_at, duration_minutes, attended, title')
        .order('occurred_at', { ascending: false });
      if (!live) return;
      setCalls((data ?? []) as DiagnosisCall[]);
      setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  return { calls, loading };
}

/** The manual-date rows, with realtime AND an explicit refresh.
 *
 *  Realtime alone is not enough: a dropped socket leaves the hook holding its
 *  first fetch forever with no way to notice, which is how the Refunds tab and
 *  the fulfillment queue both ended up stranding operators on stale rows. The
 *  mutations below call refresh() so a write is visible even with the socket
 *  down. */
export function useTimelineOverrides(): {
  overrides: TimelineOverride[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [overrides, setOverrides] = useState<TimelineOverride[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('customer_timeline_milestones')
      .select('*');
    setOverrides((data ?? []) as TimelineOverride[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const ch = supabase
      .channel('customer_timeline_milestones:realtime')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'customer_timeline_milestones' },
        () => { void refresh(); })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [refresh]);

  return { overrides, loading, refresh };
}

// ── Mutations ───────────────────────────────────────────────────────────────

/** Set an operator date for one milestone.
 *
 *  `day` is 'YYYY-MM-DD'. Dispatches on the milestone's store so the caller
 *  never has to know that three of the six live on `customers` — and so a date
 *  typed against the onboarding call lands in onboard_date, where the FU1/FU2
 *  calendar reads it. */
export async function setMilestoneOverride(
  customerId: string,
  milestone: MilestoneKey,
  day: string,
  opts?: { note?: string; setBy?: string | null },
): Promise<void> {
  const def = milestoneDef(milestone);

  if (def.store.kind === 'customer_column') {
    // updateCustomerProfile already logs, and writing through it keeps the
    // single write path for these columns.
    await updateCustomerProfile(customerId, { [def.store.column]: day });
    return;
  }

  const { error } = await supabase
    .from('customer_timeline_milestones')
    .upsert(
      {
        customer_id: customerId,
        milestone,
        occurred_at: day,
        note: opts?.note?.trim() || null,
        set_by: opts?.setBy ?? null,
      },
      { onConflict: 'customer_id,milestone' },
    );
  if (error) throw error;

  await logAction('timeline_milestone_set', customerId, `${def.label} → ${day}`,
    { entityType: 'customer', entityId: customerId });
}

/** Clear the operator date, restoring whatever the derivation says. */
export async function clearMilestoneOverride(
  customerId: string,
  milestone: MilestoneKey,
): Promise<void> {
  const def = milestoneDef(milestone);

  if (def.store.kind === 'customer_column') {
    // updateCustomerProfile maps '' → null, which is the clear.
    await updateCustomerProfile(customerId, { [def.store.column]: '' });
    return;
  }

  const { error } = await supabase
    .from('customer_timeline_milestones')
    .delete()
    .eq('customer_id', customerId)
    .eq('milestone', milestone);
  if (error) throw error;

  await logAction('timeline_milestone_cleared', customerId, def.label,
    { entityType: 'customer', entityId: customerId });
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The matrix as rendered, for the export button. */
export function timelinesCsv(rows: CustomerTimeline[]): string {
  const header = [
    'customer', 'email',
    ...MILESTONES.map(m => m.label),
    ...MILESTONES.map(m => `${m.label} (source)`),
    'diagnosis_calls', 'first_diagnosis_call', 'diagnosis_no_shows',
  ];
  const lines = rows.map(r => [
    csvCell(r.customer.full_name),
    csvCell(r.customer.email),
    ...MILESTONES.map(m => csvCell(r.milestones[m.key].date)),
    ...MILESTONES.map(m => csvCell(
      r.milestones[m.key].date
        ? (r.milestones[m.key].manual ? 'operator' : r.milestones[m.key].source)
        : '',
    )),
    csvCell(r.diagnosisCalls.length),
    csvCell(toDay(r.diagnosisCalls[r.diagnosisCalls.length - 1]?.occurred_at)),
    csvCell(r.diagnosisCalls.filter(c => c.attended === false).length),
  ].join(','));
  return [header.join(','), ...lines].join('\n');
}
