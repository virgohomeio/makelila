import { describe, it, expect } from 'vitest';
import {
  buildTimelines, consecutiveGaps, coverage, gapDays, toDay,
  timelinesCsv, gapSeverity, MILESTONES, TABLE_MILESTONE_KEYS,
  type TimelineInputs, type DiagnosisCall, type TimelineOverride,
} from './customerTimeline';
import type { Customer } from './customers';
import type { Order } from './orders';
import type { Unit } from './stock';
import type { CustomerLifecycle, ServiceTicket } from './service';
import type { CustomerEvent } from './customerEvents';

// ── Fixtures ────────────────────────────────────────────────────────────────

function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: 'c1', hubspot_id: null, email: 'a@b.com',
    first_name: 'Ann', last_name: 'Wu', full_name: 'Ann Wu',
    phone: null, address_line: null, city: null, region: null,
    postal_code: null, country: 'CA', notes: null,
    onboard_date: null, color: null, shipped_on: null, received_on: null,
    diagnosis_on: null, dashboard: null, software: null, timezone: null,
    fu1_status: null, fu2_status: null, fu_notes: null, review_status: null,
    manual_status_tags: null, last_synced_at: null,
    serials: null, serials_synced_at: null, name_request_sent_at: null,
    journey_stage_override: null, journey_stage_override_at: null,
    ...over,
  } as Customer;
}

function order(over: Partial<Order> = {}): Order {
  return {
    id: 'o1', order_ref: '#1001', customer_id: 'c1', kind: 'sale',
    placed_at: '2026-03-02T15:00:00Z', shipped_at: null, delivered_at: null,
    ...over,
  } as unknown as Order;
}

function unit(over: Partial<Unit> = {}): Unit {
  return {
    serial: 'P100-001', customer_id: 'c1', status: 'shipped',
    shipped_at: '2026-03-18T12:00:00Z',
    ...over,
  } as unknown as Unit;
}

function lifecycleRow(over: Partial<CustomerLifecycle> = {}): CustomerLifecycle {
  return {
    id: 'l1', customer_id: 'c1', unit_serial: 'P100-001',
    shipped_at: '2026-03-18T12:00:00Z',
    onboarding_status: 'pending', onboarding_completed_at: null,
    followup_email_sent_at: null, warranty_months: 12,
    warranty_expires_at: '2027-03-18', notes: null,
    created_at: '2026-03-18T12:00:00Z', updated_at: '2026-03-18T12:00:00Z',
    ...over,
  } as CustomerLifecycle;
}

function ticket(over: Partial<ServiceTicket> = {}): ServiceTicket {
  return {
    id: 't1', customer_id: 'c1', category: 'onboarding',
    calendly_event_start: '2026-03-26T17:00:00Z',
    ...over,
  } as unknown as ServiceTicket;
}

function event(over: Partial<CustomerEvent> = {}): CustomerEvent {
  return {
    id: 'e1', customer_id: 'c1', lovely_user_id: null,
    event_type: 'lovely.signup', event_payload: {}, source: 'lovely',
    occurred_at: '2026-04-03T09:00:00Z', ingested_at: '2026-04-03T09:00:00Z',
    ...over,
  } as CustomerEvent;
}

function call(over: Partial<DiagnosisCall> = {}): DiagnosisCall {
  return {
    id: 'd1', customer_id: 'c1', customer_email: 'a@b.com', customer_name: 'Ann Wu',
    occurred_at: '2026-05-10T18:00:00Z', duration_minutes: 32, attended: true,
    title: 'LILA diagnosis — Ann Wu',
    ...over,
  };
}

function inputs(over: Partial<TimelineInputs> = {}): TimelineInputs {
  return {
    customers: [customer()], orders: [], units: [], lifecycle: [],
    tickets: [], events: [], appLinks: [], deliveries: [],
    diagnosisCalls: [], overrides: [],
    ...over,
  };
}

const only = (i: TimelineInputs) => buildTimelines(i)[0];

// ── Day normalisation ───────────────────────────────────────────────────────

describe('toDay', () => {
  it('slices a timestamp to its UTC calendar day', () => {
    expect(toDay('2026-03-18T12:00:00Z')).toBe('2026-03-18');
  });

  it('passes a bare date through', () => {
    expect(toDay('2026-03-18')).toBe('2026-03-18');
  });

  it('is null for null, undefined and junk', () => {
    expect(toDay(null)).toBeNull();
    expect(toDay(undefined)).toBeNull();
    expect(toDay('')).toBeNull();
    expect(toDay('not a date')).toBeNull();
  });

  // The reason this is a string slice and not new Date(): a UTC-midnight
  // timestamp parsed into a local Date in Toronto is 7pm the PREVIOUS day.
  it('does not shift a UTC-midnight timestamp into the previous day', () => {
    expect(toDay('2026-03-18T00:00:00Z')).toBe('2026-03-18');
  });
});

describe('gapDays', () => {
  it('counts whole days forward', () => {
    expect(gapDays('2026-03-18', '2026-03-24')).toBe(6);
  });

  it('is 0 for the same day', () => {
    expect(gapDays('2026-03-18', '2026-03-18')).toBe(0);
  });

  it('spans a month boundary', () => {
    expect(gapDays('2026-03-30', '2026-04-02')).toBe(3);
  });

  // A gap we cannot measure must not read as "same day" — the whole point of
  // null here.
  it('is null, not 0, when either end is missing', () => {
    expect(gapDays(null, '2026-03-18')).toBeNull();
    expect(gapDays('2026-03-18', null)).toBeNull();
    expect(gapDays(null, null)).toBeNull();
  });

  it('is negative when the dates are out of order rather than silently abs()', () => {
    expect(gapDays('2026-03-24', '2026-03-18')).toBe(-6);
  });
});

describe('gapSeverity', () => {
  it('is unknown for an unmeasurable gap', () => {
    expect(gapSeverity(null)).toBe('unknown');
  });

  it('grades forward gaps by length', () => {
    expect(gapSeverity(0)).toBe('normal');
    expect(gapSeverity(13)).toBe('normal');
    expect(gapSeverity(14)).toBe('slow');
    expect(gapSeverity(29)).toBe('slow');
    expect(gapSeverity(30)).toBe('stalled');
  });

  // 3 of the 101 customers with both a ship and a delivery date have the
  // delivery EARLIER than the ship stamp, by up to 31 days. That is a data
  // error and must not share a colour with a 1-day delivery.
  it('calls a negative gap backwards rather than fast', () => {
    expect(gapSeverity(-1)).toBe('backwards');
    expect(gapSeverity(-31)).toBe('backwards');
  });
});

// ── Derivation ──────────────────────────────────────────────────────────────

describe('buildTimelines — derived values', () => {
  it('derives ordered from the earliest SALE order, ignoring replacements', () => {
    const t = only(inputs({
      orders: [
        order({ id: 'o1', placed_at: '2026-03-02T15:00:00Z' }),
        order({ id: 'o2', placed_at: '2026-01-05T15:00:00Z', kind: 'replacement' }),
      ],
    }));
    expect(t.milestones.ordered.date).toBe('2026-03-02');
    expect(t.milestones.ordered.source).toBe('orders.placed_at');
  });

  it('prefers units.shipped_at over customer_lifecycle and the order', () => {
    const t = only(inputs({
      units: [unit({ shipped_at: '2026-03-18T12:00:00Z' })],
      lifecycle: [lifecycleRow({ shipped_at: '2026-03-20T12:00:00Z' })],
      orders: [order({ shipped_at: '2026-03-22T12:00:00Z' })],
    }));
    expect(t.milestones.shipped.date).toBe('2026-03-18');
    expect(t.milestones.shipped.source).toBe('units.shipped_at');
  });

  it('falls back to customer_lifecycle when no unit is linked', () => {
    const t = only(inputs({ lifecycle: [lifecycleRow({ shipped_at: '2026-03-20T12:00:00Z' })] }));
    expect(t.milestones.shipped.date).toBe('2026-03-20');
    expect(t.milestones.shipped.source).toBe('customer_lifecycle.shipped_at');
  });

  // A unit that came back and went to rework still carries the old shipped_at.
  // Counting it would date this customer's timeline from a machine they no
  // longer have, so only a unit still in 'shipped' answers.
  it('only counts units whose status is shipped', () => {
    const t = only(inputs({
      units: [unit({ status: 'rework', shipped_at: '2026-01-01T12:00:00Z' })],
      lifecycle: [lifecycleRow({ shipped_at: '2026-03-20T12:00:00Z' })],
    }));
    expect(t.milestones.shipped.source).toBe('customer_lifecycle.shipped_at');
  });

  it('derives received from the shipment delivery confirmation', () => {
    const t = only(inputs({
      orders: [order({ id: 'o1' })],
      deliveries: [{ order_id: 'o1', delivered_at: '2026-03-24T20:14:00Z' }],
    }));
    expect(t.milestones.received.date).toBe('2026-03-24');
    expect(t.milestones.received.source).toBe('shipments.delivered_at');
  });

  it('falls back to the order’s own delivered_at when no shipment row has one', () => {
    const t = only(inputs({ orders: [order({ delivered_at: '2026-03-25T20:00:00Z' })] }));
    expect(t.milestones.received.date).toBe('2026-03-25');
    expect(t.milestones.received.source).toBe('orders.delivered_at');
  });

  it('takes the earliest delivery when a customer has several shipments', () => {
    const t = only(inputs({
      orders: [order({ id: 'o1' }), order({ id: 'o2' })],
      deliveries: [
        { order_id: 'o2', delivered_at: '2026-05-02T10:00:00Z' },
        { order_id: 'o1', delivered_at: '2026-03-24T10:00:00Z' },
      ],
    }));
    expect(t.milestones.received.date).toBe('2026-03-24');
  });

  it('derives the onboarding call from the Calendly ticket when onboard_date is unset', () => {
    const t = only(inputs({ tickets: [ticket()] }));
    expect(t.milestones.onboarding_call.date).toBe('2026-03-26');
    expect(t.milestones.onboarding_call.source).toBe('service_tickets.calendly_event_start');
  });

  it('ignores non-onboarding tickets when deriving the onboarding call', () => {
    const t = only(inputs({
      tickets: [ticket({ category: 'support', calendly_event_start: '2026-02-01T17:00:00Z' })],
    }));
    expect(t.milestones.onboarding_call.date).toBeNull();
  });

  it('derives onboarded from the lifecycle completion stamp', () => {
    const t = only(inputs({
      lifecycle: [lifecycleRow({ onboarding_completed_at: '2026-04-02T14:00:00Z' })],
    }));
    expect(t.milestones.onboarded.date).toBe('2026-04-02');
    expect(t.milestones.onboarded.source).toBe('customer_lifecycle.onboarding_completed_at');
  });

  it('falls back to the Lovely onboarding_done event', () => {
    const t = only(inputs({
      events: [event({ event_type: 'lovely.onboarding_done', occurred_at: '2026-04-05T14:00:00Z' })],
    }));
    expect(t.milestones.onboarded.date).toBe('2026-04-05');
    expect(t.milestones.onboarded.source).toBe('customer_events lovely.onboarding_done');
  });

  it('prefers the Lovely app account link over the event stream for first use', () => {
    const t = only(inputs({
      appLinks: [{ customer_id: 'c1', first_seen_at: '2026-03-30T08:00:00Z' }],
      events: [event({ occurred_at: '2026-04-03T09:00:00Z' })],
    }));
    expect(t.milestones.first_use.date).toBe('2026-03-30');
    expect(t.milestones.first_use.source).toBe('customer_app_links.first_seen_at');
  });

  it('falls back to the event stream when the app link has no first_seen_at', () => {
    const t = only(inputs({
      appLinks: [{ customer_id: 'c1', first_seen_at: null }],
      events: [event({ occurred_at: '2026-04-03T09:00:00Z' })],
    }));
    expect(t.milestones.first_use.date).toBe('2026-04-03');
    expect(t.milestones.first_use.source).toBe('customer_events (Lovely app)');
  });

  it('derives first use from the earliest Lovely event of any type', () => {
    const t = only(inputs({
      events: [
        event({ id: 'e1', event_type: 'lovely.onboarding_step', occurred_at: '2026-04-09T09:00:00Z' }),
        event({ id: 'e2', event_type: 'lovely.signup',          occurred_at: '2026-04-03T09:00:00Z' }),
      ],
    }));
    expect(t.milestones.first_use.date).toBe('2026-04-03');
  });

  // Klaviyo events are in the same table and are marketing email, not machine
  // use. Counting them would hand almost every customer a first-use date that
  // predates their machine.
  it('ignores non-Lovely event sources for first use', () => {
    const t = only(inputs({
      events: [event({ source: 'klaviyo', event_type: 'klaviyo.opened_email', occurred_at: '2026-01-02T09:00:00Z' })],
    }));
    expect(t.milestones.first_use.date).toBeNull();
  });

  it('leaves every milestone null for a customer with no data at all', () => {
    const t = only(inputs());
    for (const def of MILESTONES) {
      expect(t.milestones[def.key].date, def.key).toBeNull();
      expect(t.milestones[def.key].manual, def.key).toBe(false);
    }
    expect(t.ownsMachine).toBe(false);
  });

  it('never attributes another customer’s rows', () => {
    const rows = buildTimelines(inputs({
      customers: [customer({ id: 'c1' }), customer({ id: 'c2', full_name: 'Bo Li' })],
      units: [unit({ customer_id: 'c2', shipped_at: '2026-06-01T12:00:00Z' })],
      diagnosisCalls: [call({ customer_id: 'c2' })],
    }));
    expect(rows[0].milestones.shipped.date).toBeNull();
    expect(rows[0].diagnosisCalls).toHaveLength(0);
    expect(rows[1].milestones.shipped.date).toBe('2026-06-01');
    expect(rows[1].diagnosisCalls).toHaveLength(1);
  });

  it('drops rows with no customer_id rather than attributing them to the first customer', () => {
    const t = only(inputs({
      units: [unit({ customer_id: null, shipped_at: '2026-06-01T12:00:00Z' })],
      diagnosisCalls: [call({ customer_id: null })],
    }));
    expect(t.milestones.shipped.date).toBeNull();
    expect(t.diagnosisCalls).toHaveLength(0);
  });
});

// ── Overrides ───────────────────────────────────────────────────────────────

function override(over: Partial<TimelineOverride> = {}): TimelineOverride {
  return {
    id: 'm1', customer_id: 'c1', milestone: 'first_use',
    occurred_at: '2026-04-20', note: null, set_by: 'huayi@virgohome.io',
    created_at: '2026-04-21T00:00:00Z', updated_at: '2026-04-21T00:00:00Z',
    ...over,
  };
}

describe('buildTimelines — overrides', () => {
  it('a table override wins over the derivation and keeps the derived value visible', () => {
    const t = only(inputs({
      events: [event({ occurred_at: '2026-04-03T09:00:00Z' })],
      overrides: [override({ milestone: 'first_use', occurred_at: '2026-04-20' })],
    }));
    expect(t.milestones.first_use.date).toBe('2026-04-20');
    expect(t.milestones.first_use.manual).toBe(true);
    expect(t.milestones.first_use.derived).toBe('2026-04-03');
    expect(t.milestones.first_use.setBy).toBe('huayi@virgohome.io');
  });

  it('an override stands alone when there is no derivation under it', () => {
    const t = only(inputs({ overrides: [override({ milestone: 'onboarded', occurred_at: '2026-05-01' })] }));
    expect(t.milestones.onboarded.date).toBe('2026-05-01');
    expect(t.milestones.onboarded.manual).toBe(true);
    expect(t.milestones.onboarded.derived).toBeNull();
  });

  it('customers.received_on overrides the carrier delivery confirmation', () => {
    const t = only(inputs({
      customers: [customer({ received_on: '2026-03-26' })],
      orders: [order({ id: 'o1' })],
      deliveries: [{ order_id: 'o1', delivered_at: '2026-03-24T20:00:00Z' }],
    }));
    expect(t.milestones.received.date).toBe('2026-03-26');
    expect(t.milestones.received.manual).toBe(true);
    expect(t.milestones.received.source).toBe('customers.received_on');
    expect(t.milestones.received.derived).toBe('2026-03-24');
  });

  it('customers.shipped_on overrides units.shipped_at', () => {
    const t = only(inputs({
      customers: [customer({ shipped_on: '2026-03-19' })],
      units: [unit({ shipped_at: '2026-03-18T12:00:00Z' })],
    }));
    expect(t.milestones.shipped.date).toBe('2026-03-19');
    expect(t.milestones.shipped.manual).toBe(true);
  });

  // onboard_date is BOTH the override store and the first link of the
  // derivation chain, so a value there is the value — not an override sitting
  // on a separate derived number. Reporting it as manual would put "operator
  // set this" on all 122 customers whose onboard_date the onboarding-ticket
  // hook wrote automatically.
  it('does not call onboard_date manual when it is also what the derivation read', () => {
    const t = only(inputs({ customers: [customer({ onboard_date: '2026-03-26' })] }));
    expect(t.milestones.onboarding_call.date).toBe('2026-03-26');
    expect(t.milestones.onboarding_call.manual).toBe(false);
    expect(t.milestones.onboarding_call.source).toBe('customers.onboard_date');
  });

  it('only the three table-backed milestones read from the override table', () => {
    expect(TABLE_MILESTONE_KEYS).toEqual(['ordered', 'onboarded', 'first_use']);
  });

  it('ignores an override belonging to another customer', () => {
    const t = only(inputs({ overrides: [override({ customer_id: 'c2', milestone: 'first_use' })] }));
    expect(t.milestones.first_use.date).toBeNull();
  });
});

// ── Diagnosis calls ─────────────────────────────────────────────────────────

describe('buildTimelines — diagnosis calls', () => {
  it('attaches every call, newest first', () => {
    const t = only(inputs({
      diagnosisCalls: [
        call({ id: 'd1', occurred_at: '2026-05-10T18:00:00Z' }),
        call({ id: 'd2', occurred_at: '2026-07-22T18:00:00Z' }),
      ],
    }));
    expect(t.diagnosisCalls.map(c => c.id)).toEqual(['d2', 'd1']);
  });

  // A no-show is a call that happened on the calendar and is billed, so it
  // belongs in the timeline — labelled, not hidden.
  it('keeps no-shows', () => {
    const t = only(inputs({ diagnosisCalls: [call({ attended: false })] }));
    expect(t.diagnosisCalls).toHaveLength(1);
    expect(t.diagnosisCalls[0].attended).toBe(false);
  });
});

// ── ownsMachine ─────────────────────────────────────────────────────────────

describe('ownsMachine', () => {
  it('is true once a machine shipped', () => {
    expect(only(inputs({ units: [unit()] })).ownsMachine).toBe(true);
  });

  it('is true for a delivery with no linked unit', () => {
    const t = only(inputs({
      orders: [order({ id: 'o1' })],
      deliveries: [{ order_id: 'o1', delivered_at: '2026-03-24T20:00:00Z' }],
    }));
    expect(t.ownsMachine).toBe(true);
  });

  it('is false for a customer who only ever placed an order', () => {
    expect(only(inputs({ orders: [order()] })).ownsMachine).toBe(false);
  });
});

// ── Gaps + coverage ─────────────────────────────────────────────────────────

describe('consecutiveGaps', () => {
  it('measures each milestone against the previous dated one', () => {
    const t = only(inputs({
      orders: [order({ id: 'o1', placed_at: '2026-03-02T15:00:00Z' })],
      units: [unit({ shipped_at: '2026-03-18T12:00:00Z' })],
      deliveries: [{ order_id: 'o1', delivered_at: '2026-03-24T20:00:00Z' }],
    }));
    const g = consecutiveGaps(t);
    expect(g.ordered).toBeNull();          // nothing before it
    expect(g.shipped).toBe(16);
    expect(g.received).toBe(6);
  });

  // Skipping blanks is the point: a customer with no Received date should still
  // show how long shipped → onboarded took, not two dashes.
  it('skips a missing milestone and measures across the hole', () => {
    const t = only(inputs({
      units: [unit({ shipped_at: '2026-03-18T12:00:00Z' })],
      lifecycle: [lifecycleRow({
        shipped_at: '2026-03-18T12:00:00Z',
        onboarding_completed_at: '2026-04-02T14:00:00Z',
      })],
    }));
    const g = consecutiveGaps(t);
    expect(g.received).toBeNull();
    expect(g.onboarded).toBe(15);          // measured from shipped, not received
  });
});

describe('coverage', () => {
  it('counts customers with a value per milestone', () => {
    const rows = buildTimelines(inputs({
      customers: [customer({ id: 'c1' }), customer({ id: 'c2' })],
      units: [unit({ customer_id: 'c1' })],
      orders: [order({ customer_id: 'c1' }), order({ id: 'o2', customer_id: 'c2' })],
    }));
    const c = coverage(rows);
    expect(c.ordered).toBe(2);
    expect(c.shipped).toBe(1);
    expect(c.first_use).toBe(0);
  });
});

// ── CSV ─────────────────────────────────────────────────────────────────────

describe('timelinesCsv', () => {
  it('labels an operator-set cell as operator rather than its table', () => {
    const rows = buildTimelines(inputs({
      events: [event({ occurred_at: '2026-04-03T09:00:00Z' })],
      overrides: [override({ milestone: 'first_use', occurred_at: '2026-04-20' })],
    }));
    const csv = timelinesCsv(rows);
    const [header, row] = csv.split('\n');
    expect(header).toContain('Started using the machine (source)');
    expect(row).toContain('operator');
    expect(row).toContain('2026-04-20');
  });

  it('quotes a name containing a comma', () => {
    const rows = buildTimelines(inputs({ customers: [customer({ full_name: 'Wu, Ann' })] }));
    expect(timelinesCsv(rows).split('\n')[1]).toContain('"Wu, Ann"');
  });

  it('reports the FIRST diagnosis call and counts no-shows', () => {
    const rows = buildTimelines(inputs({
      diagnosisCalls: [
        call({ id: 'd1', occurred_at: '2026-05-10T18:00:00Z', attended: true }),
        call({ id: 'd2', occurred_at: '2026-07-22T18:00:00Z', attended: false }),
      ],
    }));
    const row = timelinesCsv(rows).split('\n')[1];
    expect(row.endsWith('2,2026-05-10,1')).toBe(true);
  });
});
