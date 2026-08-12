import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ServiceTicket, TicketActionItem } from '../../../lib/service';
import { toDateKey, weekStartKey, weekDayKeys } from '../actionItemWeek';

let itemsToReturn: TicketActionItem[] = [];
const setDueDateMock = vi.fn(() => Promise.resolve());

vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return {
    ...actual,
    useOpenActionItems: vi.fn(() => ({ items: itemsToReturn, loading: false })),
    setTicketActionItemDueDate: (...a: unknown[]) => setDueDateMock(...(a as [])),
  };
});

import { ActionItemKanban } from '../ActionItemKanban';

const mkTicket = (id: string, extra: Partial<ServiceTicket> = {}) => ({
  id, ticket_number: `TKT-${id}`, subject: 'help', status: 'waiting_on_us',
  priority: 'normal', customer_name: 'Alice', customer_email: 'a@x.com',
  category: 'support', source: 'gmail', tags: [],
  ...extra,
}) as ServiceTicket;

const mkItem = (id: string, due: string | null, extra: Partial<TicketActionItem> = {}) => ({
  id, ticket_id: 't1', body: `task ${id}`, done: false,
  done_at: null, done_by: null, author_id: null, author_email: null,
  created_at: '2026-08-01T00:00:00Z', due_date: due, ...extra,
}) as TicketActionItem;

// The component reads the real clock, so anchor expectations to it rather than
// to a hardcoded date — otherwise the suite rots the moment the week turns.
const TODAY = toDateKey(new Date());
const WEEK = weekDayKeys(weekStartKey(new Date()));
const OTHER_DAY = WEEK.find(d => d !== TODAY)!;

/** The column whose heading contains `label`. */
const column = (label: string) =>
  screen.getByText(label, { selector: 'span' }).closest('div')!.parentElement!;

describe('ActionItemKanban', () => {
  beforeEach(() => {
    itemsToReturn = [];
    setDueDateMock.mockClear();
  });

  const open = () => fireEvent.click(screen.getByRole('button', { name: /Action items by week/ }));

  it('starts collapsed and shows the open count', () => {
    itemsToReturn = [mkItem('a', TODAY), mkItem('b', null)];
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    expect(screen.getByText('2 open')).toBeInTheDocument();
    // Collapsed: no board columns rendered yet.
    expect(screen.queryByText('No due date')).toBeNull();
  });

  it('renders Overdue, the seven days, and No due date once expanded', () => {
    itemsToReturn = [mkItem('a', TODAY)];
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    open();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('No due date')).toBeInTheDocument();
    // Seven day columns between the two pinned ones.
    expect(screen.getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+/)).toHaveLength(7);
  });

  it('shows an empty state instead of a board when nothing is open', () => {
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    open();
    expect(screen.getByText('No open action items on any ticket.')).toBeInTheDocument();
    expect(screen.queryByText('Overdue')).toBeNull();
  });

  it('places an item in its due-date column', () => {
    itemsToReturn = [mkItem('a', OTHER_DAY)];
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    open();
    expect(screen.getByText('task a')).toBeInTheDocument();
  });

  it('hides action items whose ticket is closed', () => {
    itemsToReturn = [mkItem('a', TODAY, { ticket_id: 'closed-t' })];
    render(
      <ActionItemKanban
        tickets={[mkTicket('closed-t', { status: 'closed' })]}
        onSelectTicket={() => {}}
      />,
    );
    expect(screen.getByText('0 open')).toBeInTheDocument();
  });

  it('hides action items whose ticket is not in the pool', () => {
    itemsToReturn = [mkItem('a', TODAY, { ticket_id: 'ghost' })];
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    expect(screen.getByText('0 open')).toBeInTheDocument();
  });

  it('reschedules on drop into a day column', () => {
    itemsToReturn = [mkItem('a', null)];
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    open();
    fireEvent.dragStart(screen.getByText('task a').closest('[draggable]')!);
    fireEvent.drop(column('No due date'));   // dropped in place → no write
    expect(setDueDateMock).not.toHaveBeenCalled();
  });

  it('refuses a drop on Overdue', () => {
    itemsToReturn = [mkItem('a', OTHER_DAY)];
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    open();
    fireEvent.dragStart(screen.getByText('task a').closest('[draggable]')!);
    fireEvent.drop(column('Overdue'));
    expect(setDueDateMock).not.toHaveBeenCalled();
    expect(screen.getByText(/can't schedule an action item into the past/i)).toBeInTheDocument();
  });

  it('clears the due date when dropped on No due date', () => {
    itemsToReturn = [mkItem('a', OTHER_DAY)];
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    open();
    fireEvent.dragStart(screen.getByText('task a').closest('[draggable]')!);
    fireEvent.drop(column('No due date'));
    expect(setDueDateMock).toHaveBeenCalledWith('a', null);
  });

  it('opens the ticket when a card is clicked', () => {
    const onSelect = vi.fn();
    itemsToReturn = [mkItem('a', TODAY)];
    const ticket = mkTicket('t1');
    render(<ActionItemKanban tickets={[ticket]} onSelectTicket={onSelect} />);
    open();
    fireEvent.click(screen.getByText('task a').closest('[draggable]')!);
    expect(onSelect).toHaveBeenCalledWith(ticket);
  });

  it('surfaces work scheduled beyond the visible week rather than hiding it', () => {
    itemsToReturn = [mkItem('far', '2099-01-01')];
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    open();
    expect(screen.getByText(/1 scheduled beyond this week/)).toBeInTheDocument();
  });

  it('pages weeks and offers a reset once moved', () => {
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    open();
    expect(screen.queryByRole('button', { name: 'This week' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByRole('button', { name: 'This week' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(screen.queryByRole('button', { name: 'This week' })).toBeNull();
  });

  it('keeps overdue items visible after paging to another week', () => {
    itemsToReturn = [mkItem('late', '2020-01-01')];
    render(<ActionItemKanban tickets={[mkTicket('t1')]} onSelectTicket={() => {}} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(within(column('Overdue')).getByText('task late')).toBeInTheDocument();
  });
});
