import { describe, it, expect } from 'vitest';
import {
  replacementQueueKindsByTicket, groupQueueKinds,
  matchesReplacementKind, replacementKindOptions,
} from '../replacementQueue';
import type { ServiceTicket, TicketStatus } from '../../../lib/service';
import type { Order } from '../../../lib/orders';

const t = (id: string, extra: Partial<ServiceTicket> = {}) =>
  ({ id, status: 'queued_for_replacement' as TicketStatus, replacement_order_id: null, ...extra }) as ServiceTicket;

const o = (id: string, line_items: unknown[], extra: Partial<Order> = {}) =>
  ({ id, line_items, awaiting_batch_id: null, linked_ticket_id: null, ...extra }) as Order;

describe('replacementQueueKindsByTicket', () => {
  it('resolves the order via the ticket back-link', () => {
    const m = replacementQueueKindsByTicket(
      [t('t1', { replacement_order_id: 'o1' })],
      [o('o1', [{ kind: 'unit_pending', batch: 'P100X' }])],
    );
    expect(m.get('t1')).toEqual(['P100X']);
  });

  it('falls back to the order → ticket link when the ticket has no back-link', () => {
    const m = replacementQueueKindsByTicket(
      [t('t1')],
      [o('o1', [{ kind: 'part', sku: 'LILA-LID-V36' }], { linked_ticket_id: 't1' })],
    );
    expect(m.get('t1')).toEqual(['PARTS']);
  });

  it('covers tickets queued via a status TAG, not just the workflow status', () => {
    const m = replacementQueueKindsByTicket(
      [t('t1', { status: 'in_progress', tags: ['queued_for_replacement'], replacement_order_id: 'o1' })],
      [o('o1', [{ kind: 'unit_pending', batch: 'LILA-Mini' }])],
    );
    expect(m.get('t1')).toEqual(['LILA-Mini']);
  });

  it('ignores tickets that are not queued for a replacement', () => {
    const m = replacementQueueKindsByTicket(
      [t('t1', { status: 'waiting_on_us', replacement_order_id: 'o1' })],
      [o('o1', [{ kind: 'unit_pending', batch: 'P100X' }])],
    );
    expect(m.has('t1')).toBe(false);
  });

  it('omits a queued ticket whose order is missing, so the row keeps the plain status pill', () => {
    const m = replacementQueueKindsByTicket([t('t1', { replacement_order_id: 'gone' })], []);
    expect(m.has('t1')).toBe(false);
  });
});

describe('groupQueueKinds', () => {
  it('collects the distinct kinds across a customer\'s open tickets', () => {
    const kinds = new Map([['t1', ['P100X']], ['t2', ['PARTS']], ['t3', ['P100X']]]);
    expect(groupQueueKinds([t('t1'), t('t2'), t('t3')], kinds)).toEqual(['P100X', 'PARTS']);
  });

  it('sorts units before parts', () => {
    const kinds = new Map([['t1', ['PARTS']], ['t2', ['P150']]]);
    expect(groupQueueKinds([t('t1'), t('t2')], kinds)).toEqual(['P150', 'PARTS']);
  });

  it('is empty when nothing is queued', () => {
    expect(groupQueueKinds([t('t1')], new Map())).toEqual([]);
  });
});

describe('matchesReplacementKind', () => {
  it('lets everything through on "all", including tickets with no resolvable order', () => {
    expect(matchesReplacementKind(['P100X'], 'all')).toBe(true);
    expect(matchesReplacementKind([], 'all')).toBe(true);
  });

  it('separates parts from batches', () => {
    expect(matchesReplacementKind(['PARTS'], 'parts')).toBe(true);
    expect(matchesReplacementKind(['P100X'], 'parts')).toBe(false);
    expect(matchesReplacementKind(['P100X'], 'any_batch')).toBe(true);
    expect(matchesReplacementKind(['LILA-Mini'], 'any_batch')).toBe(true);
    expect(matchesReplacementKind(['PARTS'], 'any_batch')).toBe(false);
  });

  it('narrows to one batch', () => {
    expect(matchesReplacementKind(['P100X'], 'batch:P100X')).toBe(true);
    expect(matchesReplacementKind(['LILA-Mini'], 'batch:P100X')).toBe(false);
    expect(matchesReplacementKind(['PARTS'], 'batch:P100X')).toBe(false);
  });

  it('excludes a ticket with no resolvable order from every specific filter', () => {
    // Otherwise an unresolvable ticket would masquerade as a parts order.
    expect(matchesReplacementKind([], 'parts')).toBe(false);
    expect(matchesReplacementKind([], 'any_batch')).toBe(false);
    expect(matchesReplacementKind([], 'batch:P100X')).toBe(false);
  });
});

describe('replacementKindOptions', () => {
  const kinds = new Map([
    ['t1', ['PARTS']], ['t2', ['PARTS']], ['t3', ['P100X']], ['t4', ['LILA-Mini']],
  ]);
  const tickets = [t('t1'), t('t2'), t('t3'), t('t4')];

  it('counts All, Parts and Any batch, then one entry per batch', () => {
    expect(replacementKindOptions(tickets, kinds)).toEqual([
      { key: 'all',             label: 'All',       count: 4, group: 'all' },
      { key: 'parts',           label: 'Parts',     count: 2, group: 'parts' },
      { key: 'any_batch',       label: 'Any batch', count: 2, group: 'any_batch' },
      { key: 'batch:LILA-Mini', label: 'LILA-Mini', count: 1, group: 'batch' },
      { key: 'batch:P100X',     label: 'P100X',     count: 1, group: 'batch' },
    ]);
  });

  it('surfaces a batch it has never seen before, with no code change', () => {
    // The whole point: a future batch appears the moment one replacement
    // order carries it. Nothing here is a hardcoded batch list.
    const opts = replacementKindOptions([t('t1')], new Map([['t1', ['P250-Neo']]]));
    expect(opts.map(o => o.key)).toEqual(['all', 'any_batch', 'batch:P250-Neo']);
  });

  it('hides buckets that would read as a dead chip', () => {
    const opts = replacementKindOptions([t('t1')], new Map([['t1', ['PARTS']]]));
    expect(opts.map(o => o.key)).toEqual(['all', 'parts']);
  });

  it('counts a ticket with no resolvable order under All only', () => {
    const opts = replacementKindOptions([t('t1'), t('t2')], new Map([['t1', ['PARTS']]]));
    expect(opts).toEqual([
      { key: 'all',   label: 'All',   count: 2, group: 'all' },
      { key: 'parts', label: 'Parts', count: 1, group: 'parts' },
    ]);
  });

  it('is just All when nothing is queued', () => {
    expect(replacementKindOptions([], new Map()).map(o => o.key)).toEqual(['all']);
  });
});
