import { describe, it, expect } from 'vitest';
import {
  computeCustomerStatuses, STATUS_FILTERS, effectiveFollowUpAnchor, type CustomerStatusContext,
} from './followupStatus';
import type { Customer } from './customers';
import type { ServiceTicket } from './service';

const base: Customer = {
  id: 'c1', hubspot_id: null, email: 'a@b.com', first_name: null, last_name: null,
  full_name: 'Test User', phone: null, address_line: null, city: null, region: null,
  postal_code: null, country: null, notes: null, onboard_date: null,
  color: null, shipped_on: null, received_on: null, diagnosis_on: null,
  dashboard: null, software: null, timezone: null,
  fu1_status: null, fu2_status: null, fu_notes: null, review_status: null, manual_status_tags: null,
  last_synced_at: null, serials: null, serials_synced_at: null,
  name_request_sent_at: null, journey_stage_override: null,
  journey_stage_override_at: null, journey_stage_override_by: null,
  first_touch_source: null, first_touch_campaign_id: null, first_touch_at: null,
  last_touch_source: null, last_touch_campaign_id: null, last_touch_at: null,
  telemetry_autoticket_suppress: false, created_at: '', updated_at: '',
};
const emptyCtx: CustomerStatusContext = {
  openTickets: [], queuedReplacement: false, returned: false, awaitingOnboarding: false,
};
const today = new Date('2026-06-18T12:00:00');
const daysAgo = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const daysAhead = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

describe('computeCustomerStatuses', () => {
  it('marks FU1 overdue when onboarded >14d ago and fu1 not done', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    expect(computeCustomerStatuses(c, emptyCtx, today).has('overdue')).toBe(true);
  });
  it('marks due_today when FU1 due exactly today', () => {
    const c = { ...base, onboard_date: daysAgo(14) };
    expect(computeCustomerStatuses(c, emptyCtx, today).has('due_today')).toBe(true);
  });
  it('marks due_7d when next FU falls within the coming week', () => {
    const c = { ...base, onboard_date: daysAgo(10) };
    const s = computeCustomerStatuses(c, emptyCtx, today);
    expect(s.has('due_7d')).toBe(true);
    expect(s.has('due_today')).toBe(false);
    expect(s.has('overdue')).toBe(false);
  });
  it('does NOT mark due_7d when next FU is 8 days out', () => {
    const c = { ...base, onboard_date: daysAhead(-6) };
    expect(computeCustomerStatuses(c, emptyCtx, today).has('due_7d')).toBe(false);
  });
  it('marks in_followup when onboarded and not complete', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    expect(computeCustomerStatuses(c, emptyCtx, today).has('in_followup')).toBe(true);
  });
  it('marks active when onboarded, both FUs done, no open issues', () => {
    const c = { ...base, onboard_date: daysAgo(40), fu1_status: 'called', fu2_status: 'called' };
    const s = computeCustomerStatuses(c, emptyCtx, today);
    expect(s.has('active')).toBe(true);
    expect(s.has('in_followup')).toBe(false);
  });
  it('does NOT mark active when a return exists', () => {
    const c = { ...base, onboard_date: daysAgo(40), fu1_status: 'x', fu2_status: 'y' };
    const s = computeCustomerStatuses(c, { ...emptyCtx, returned: true }, today);
    expect(s.has('active')).toBe(false);
    expect(s.has('returned')).toBe(true);
  });
  it('derives ticket-based statuses', () => {
    const t = (status: ServiceTicket['status'], category: ServiceTicket['category'] = 'support') => ({ status, category, source: 'hubspot' as ServiceTicket['source'] });
    const ctx = { ...emptyCtx, openTickets: [t('on_hold'), t('waiting_on_customer'), t('queued_for_replacement'), t('call_scheduled', 'diagnosis_call')] };
    const s = computeCustomerStatuses({ ...base }, ctx, today);
    expect(s.has('on_hold')).toBe(true);
    expect(s.has('awaiting_response')).toBe(true);
    expect(s.has('queued_replacement')).toBe(true);
    expect(s.has('awaiting_diagnosis')).toBe(true);
  });
  it('marks awaiting_review from review_status', () => {
    const c = { ...base, review_status: 'requested' };
    expect(computeCustomerStatuses(c, emptyCtx, today).has('awaiting_review')).toBe(true);
  });
  it('STATUS_FILTERS covers all 14 keys in display order', () => {
    expect(STATUS_FILTERS.map(f => f.key)).toEqual([
      'overdue', 'due_today', 'due_7d', 'fu_on_hold', 'ticket_followup_due',
      'in_followup', 'awaiting_onboarding', 'awaiting_response', 'awaiting_diagnosis', 'queued_replacement',
      'on_hold', 'awaiting_review', 'active', 'returned',
    ]);
  });
});

describe('diagnosis calls no longer affect follow-ups', () => {
  it('a customer with an open diagnosis_call ticket still gets normal FU1/FU2 (not held/superseded)', () => {
    const c = { ...base, onboard_date: daysAgo(20) }; // FU1 overdue by onboard math
    const s = computeCustomerStatuses(c, {
      ...emptyCtx,
      openTickets: [{ status: 'call_scheduled', category: 'diagnosis_call', source: 'google_calendar' }],
    }, today);
    expect(s.has('overdue')).toBe(true);            // normal cadence applies
    expect(s.has('fu_on_hold')).toBe(false);        // diagnosis calls don't hold
    expect(s.has('awaiting_diagnosis')).toBe(true); // the diagnosis-call status still shows
  });
});

describe('follow-up hold on open issues', () => {
  const ticket = (
    category: ServiceTicket['category'],
    status: ServiceTicket['status'] = 'waiting_on_us',
    source: ServiceTicket['source'] = 'hubspot',
  ) => ({ status, category, source });

  it('holds FU when a replacement is queued (suppresses overdue, adds fu_on_hold)', () => {
    const c = { ...base, onboard_date: daysAgo(20) }; // would be FU1 overdue
    const s = computeCustomerStatuses(c, { ...emptyCtx, queuedReplacement: true }, today);
    expect(s.has('fu_on_hold')).toBe(true);
    expect(s.has('overdue')).toBe(false);
    expect(s.has('in_followup')).toBe(false);
    expect(s.has('queued_replacement')).toBe(true);
  });

  it('holds FU when an open support ticket exists', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    const s = computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('support')] }, today);
    expect(s.has('fu_on_hold')).toBe(true);
    expect(s.has('overdue')).toBe(false);
  });

  it('holds FU for an open repair ticket', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    expect(computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('repair')] }, today).has('fu_on_hold')).toBe(true);
  });

  it('does NOT hold FU for an open onboarding-call ticket', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    const s = computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('onboarding')] }, today);
    expect(s.has('fu_on_hold')).toBe(false);
    expect(s.has('overdue')).toBe(true);
  });

  it('does NOT hold FU for an auto-synced Quo message-thread support ticket', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    const s = computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('support', 'waiting_on_us', 'quo')] }, today);
    expect(s.has('fu_on_hold')).toBe(false);
    expect(s.has('overdue')).toBe(true);
  });

  it('does NOT hold FU for a Gmail-synced support ticket', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    expect(computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('support', 'waiting_on_us', 'gmail')] }, today).has('fu_on_hold')).toBe(false);
  });

  it('holds FU for a genuine ops-created support ticket (source ops_manual)', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    expect(computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('support', 'waiting_on_us', 'ops_manual')] }, today).has('fu_on_hold')).toBe(true);
  });

  it('does NOT mark fu_on_hold when the follow-up is already complete', () => {
    const c = { ...base, onboard_date: daysAgo(40), fu1_status: 'called', fu2_status: 'called' };
    const s = computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('support')] }, today);
    expect(s.has('fu_on_hold')).toBe(false);
  });

  it('does NOT mark fu_on_hold for an unscheduled customer (no onboard date)', () => {
    const s = computeCustomerStatuses({ ...base, onboard_date: null }, { ...emptyCtx, queuedReplacement: true }, today);
    expect(s.has('fu_on_hold')).toBe(false);
  });

  it('auto-resumes: no blocking condition -> overdue returns', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    const s = computeCustomerStatuses(c, emptyCtx, today);
    expect(s.has('fu_on_hold')).toBe(false);
    expect(s.has('overdue')).toBe(true);
  });
});

describe('post-close ticket follow-up', () => {
  const closed = (closedAgoDays: number, followupDoneAt: string | null = null) =>
    ({ id: 'tk1', closedAt: daysAgo(closedAgoDays) + 'T00:00:00', followupDoneAt });

  it('marks ticket_followup_due 14+ days after close when not done', () => {
    const s = computeCustomerStatuses({ ...base }, { ...emptyCtx, lastClosedTicket: closed(14) }, today);
    expect(s.has('ticket_followup_due')).toBe(true);
  });
  it('does NOT mark before 14 days', () => {
    const s = computeCustomerStatuses({ ...base }, { ...emptyCtx, lastClosedTicket: closed(5) }, today);
    expect(s.has('ticket_followup_due')).toBe(false);
  });
  it('does NOT mark once the follow-up is done', () => {
    const s = computeCustomerStatuses({ ...base }, { ...emptyCtx, lastClosedTicket: closed(30, daysAgo(1) + 'T00:00:00') }, today);
    expect(s.has('ticket_followup_due')).toBe(false);
  });
  it('does NOT mark while an open issue ticket still exists', () => {
    const s = computeCustomerStatuses({ ...base }, {
      ...emptyCtx, openTickets: [{ status: 'waiting_on_us', category: 'support', source: 'hubspot' }], lastClosedTicket: closed(30),
    }, today);
    expect(s.has('ticket_followup_due')).toBe(false);
  });
});

describe('follow-up hold + reschedule on ticket close', () => {
  const openT = (category: ServiceTicket['category'] = 'support', source: ServiceTicket['source'] = 'ops_manual') =>
    ({ status: 'in_progress' as ServiceTicket['status'], category, source });

  it('holds a pending FU while a genuine open support ticket exists', () => {
    const c = { ...base, onboard_date: daysAgo(20) }; // FU1 overdue by onboard math
    const ctx = { ...emptyCtx, openTickets: [openT('support', 'ops_manual')] };
    const s = computeCustomerStatuses(c, ctx, today);
    expect(s.has('fu_on_hold')).toBe(true);
    expect(s.has('overdue')).toBe(false);
  });

  it('reschedules FU1 to close+14d after all tickets close', () => {
    const c = { ...base, onboard_date: daysAgo(40) }; // long overdue by onboard math
    // Ticket closed 5 days ago → FU1 due close+14 → 9 days out → not overdue/not due_today
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: daysAgo(5) + 'T00:00:00Z' };
    const s = computeCustomerStatuses(c, ctx, today);
    expect(s.has('overdue')).toBe(false);
    expect(s.has('due_today')).toBe(false);
    expect(s.has('in_followup')).toBe(true);
  });

  it('marks FU1 due_today exactly 14 days after close', () => {
    const c = { ...base, onboard_date: daysAgo(40) };
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: daysAgo(14) + 'T00:00:00Z' };
    expect(computeCustomerStatuses(c, ctx, today).has('due_today')).toBe(true);
  });

  it('reschedules only the pending touch (FU1 done → FU2 at close+28d)', () => {
    const c = { ...base, onboard_date: daysAgo(40), fu1_status: 'called' };
    // Closed 10 days ago → FU2 due close+28 → 18 days out → upcoming, not due_7d
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: daysAgo(10) + 'T00:00:00Z' };
    const s = computeCustomerStatuses(c, ctx, today);
    expect(s.has('overdue')).toBe(false);
    expect(s.has('due_7d')).toBe(false);
    expect(s.has('in_followup')).toBe(true);
  });
});

describe('effectiveFollowUpAnchor', () => {
  it('returns null when onboard_date is null', () => {
    expect(effectiveFollowUpAnchor({ ...base }, emptyCtx)).toBeNull();
  });
  it('returns onboard_date when there is no closed ticket', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    expect(effectiveFollowUpAnchor(c, emptyCtx)).toBe('2026-05-01');
  });
  it('shifts the anchor to a ticket that closed after onboarding', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: '2026-06-10T09:30:00Z' };
    expect(effectiveFollowUpAnchor(c, ctx)).toBe('2026-06-10');
  });
  it('keeps onboard_date when the closed ticket predates onboarding', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: '2026-04-01T00:00:00Z' };
    expect(effectiveFollowUpAnchor(c, ctx)).toBe('2026-05-01');
  });
  it('keeps the base anchor while a ticket is still open', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    const ctx = { ...emptyCtx, openTickets: [{ status: 'in_progress' as ServiceTicket['status'], category: 'support' as ServiceTicket['category'], source: 'ops_manual' as ServiceTicket['source'] }], lastClosedAnyTicketAt: '2026-06-10T00:00:00Z' };
    expect(effectiveFollowUpAnchor(c, ctx)).toBe('2026-05-01');
  });
});

import { matchKeysFor, type Matchable } from './followupStatus';

describe('matchKeysFor', () => {
  it('emits id, lowercased email, and lowercased name keys', () => {
    const m: Matchable = { customer_id: 'abc', customer_email: 'A@B.com', customer_name: 'Jane Doe' };
    expect(matchKeysFor(m)).toEqual(['id:abc', 'email:a@b.com', 'name:jane doe']);
  });
  it('skips missing fields', () => {
    expect(matchKeysFor({ customer_id: null, customer_email: null, customer_name: 'X' })).toEqual(['name:x']);
  });
});
