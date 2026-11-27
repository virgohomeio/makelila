import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { feedbackToTicket, subjectSnippet, type LovelyFeedback } from './mapFeedback.ts';
import type { ResolvedCustomer } from './mapReport.ts';

const feedback = (over: Partial<LovelyFeedback> = {}): LovelyFeedback => ({
  id: 'f1', user_id: 'u1', user_name: 'Angela Y', email: 'angela@x.com',
  serial_number: 'LL01-00000000363', kind: 'bug',
  message: 'Dashboard says LILA is waking up', page_path: '/dashboard',
  user_agent: 'Mozilla/5.0 (iPhone)', app_version: 'abc1234',
  photo_path: 'u1/1729000000-screen.png', created_at: '2026-10-14T20:00:00Z', ...over,
});

const noCustomer: ResolvedCustomer = { customer_id: null, customer_name: null, customer_email: null };
const customer: ResolvedCustomer = { customer_id: 'c1', customer_name: 'Angela Velasco', customer_email: 'av@x.com' };

Deno.test('feedbackToTicket: a bug is a normal-priority software ticket', () => {
  const t = feedbackToTicket(feedback(), customer, true);
  assertEquals(t.source, 'lovely_app');
  assertEquals(t.kind, 'ticket');
  assertEquals(t.category, 'support');
  assertEquals(t.status, 'waiting_on_us');
  assertEquals(t.priority, 'normal');
  assertEquals(t.issue_area, 'software');
  assertEquals(t.subject, 'App bug: Dashboard says LILA is waking up');
});

Deno.test('feedbackToTicket: an idea is low priority', () => {
  const t = feedbackToTicket(feedback({ kind: 'idea', message: 'Add recipes' }), customer, true);
  assertEquals(t.priority, 'low');
  assertEquals(t.issue_area, 'software');
  assertEquals(t.subject, 'App idea: Add recipes');
});

Deno.test('feedbackToTicket: "other" and unknown kinds land in Other', () => {
  const other = feedbackToTicket(feedback({ kind: 'other', message: 'Hi' }), customer, true);
  assertEquals(other.issue_area, 'other');
  assertEquals(other.subject, 'App feedback: Hi');
  const unknown = feedbackToTicket(feedback({ kind: 'praise', message: 'Hi' }), customer, true);
  assertEquals(unknown.issue_area, 'other');
  assertEquals(unknown.subject, 'App feedback: Hi');
});

Deno.test('feedbackToTicket: carries the ids, photo path and filing date', () => {
  const t = feedbackToTicket(feedback(), customer, true);
  assertEquals(t.lovely_feedback_id, 'f1');
  assertEquals(t.lovely_feedback_photo_path, 'u1/1729000000-screen.png');
  assertEquals(t.created_at, '2026-10-14T20:00:00Z');
  const bare = feedbackToTicket(feedback({ photo_path: null, created_at: null }), customer, true);
  assertEquals(bare.lovely_feedback_photo_path, null);
  assertEquals('created_at' in bare, false);
});

Deno.test('feedbackToTicket: description is the message plus the app context', () => {
  const t = feedbackToTicket(feedback(), customer, true);
  assertEquals(t.description, [
    'Dashboard says LILA is waking up',
    '',
    "Sent from the Lovely app's feedback button.",
    'Name in the app: Angela Y',
    'Page: /dashboard',
    'App version: abc1234',
    'Device: Mozilla/5.0 (iPhone)',
  ].join('\n'));
});

Deno.test('feedbackToTicket: missing context lines are left out, empty message is said so', () => {
  const t = feedbackToTicket(
    feedback({ message: '  ', user_name: null, page_path: null, app_version: null, user_agent: null }),
    customer, true,
  );
  assertEquals(t.subject, 'App bug from the Lovely app');
  assertEquals(t.description, "No message provided.\n\nSent from the Lovely app's feedback button.");
});

Deno.test('feedbackToTicket: known serial goes on the ticket, unknown serial is only noted', () => {
  assertEquals(feedbackToTicket(feedback({ serial_number: ' ll01-00000000363 ' }), customer, true).unit_serial, 'LL01-00000000363');
  const t = feedbackToTicket(feedback(), customer, false);
  assertEquals(t.unit_serial, null);
  assertEquals(
    t.description.endsWith(
      'Serial on the Lovely account: LL01-00000000363. It matched no unit in makelila, so any unit shown on this ticket was inferred from the customer.',
    ),
    true,
  );
  assertEquals(feedbackToTicket(feedback({ serial_number: null }), customer, false).unit_serial, null);
});

Deno.test('feedbackToTicket: resolved customer wins; otherwise the app name and email are kept', () => {
  const resolved = feedbackToTicket(feedback(), customer, true);
  assertEquals([resolved.customer_id, resolved.customer_name, resolved.customer_email], ['c1', 'Angela Velasco', 'av@x.com']);

  const unresolved = feedbackToTicket(feedback(), noCustomer, true);
  assertEquals([unresolved.customer_id, unresolved.customer_name, unresolved.customer_email], [null, 'Angela Y', 'angela@x.com']);

  const linkEmail = feedbackToTicket(feedback(), { ...noCustomer, customer_email: 'link@x.com' }, true);
  assertEquals(linkEmail.customer_email, 'link@x.com');
});

Deno.test('subjectSnippet: first non-empty line, whitespace collapsed, long text cut', () => {
  assertEquals(subjectSnippet('\n\n  first   line  \nsecond'), 'first line');
  assertEquals(subjectSnippet('a'.repeat(80)), 'a'.repeat(59) + '…');
  assertEquals(subjectSnippet('a'.repeat(60)), 'a'.repeat(60));
  assertEquals(subjectSnippet(null), '');
});
