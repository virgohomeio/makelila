import { describe, it, expect } from 'vitest';
import { replacementQueueKindsByTicket, groupQueueKinds } from '../replacementQueue';
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
