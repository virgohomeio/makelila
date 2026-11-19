// Pure mapping from a Lovely in-app feedback row (the app's "Send feedback"
// button: bug / idea / other) to a service_tickets insert row. Runtime-neutral
// like mapReport.ts, so it is testable without a database.

import { normalizeSerial, type ResolvedCustomer } from './mapReport.ts';

// One row of the Lovely project's public.feedback, plus the Lovely account's
// email, as returned by the lovely-feedback edge function.
export type LovelyFeedback = {
  id: string;
  user_id: string | null;
  user_name: string | null;
  email: string | null;
  serial_number: string | null;
  kind: string;
  message: string | null;
  page_path: string | null;
  user_agent: string | null;
  app_version: string | null;
  photo_path: string | null;
  created_at: string | null;
};

export type FeedbackTicketInsert = {
  source: 'lovely_app';
  kind: 'ticket';
  category: 'support';
  status: 'waiting_on_us';
  priority: 'low' | 'normal';
  issue_area: 'software' | 'other';
  subject: string;
  description: string;
  unit_serial: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  lovely_feedback_id: string;
  lovely_feedback_photo_path: string | null;
  created_at?: string;
};

// Ideas are low priority so they don't compete with bugs for the SLA clock.
const KIND_META: Record<string, { label: string; priority: 'low' | 'normal'; issue_area: 'software' | 'other' }> = {
  bug:   { label: 'App bug',      priority: 'normal', issue_area: 'software' },
  idea:  { label: 'App idea',     priority: 'low',    issue_area: 'software' },
  other: { label: 'App feedback', priority: 'normal', issue_area: 'other' },
};

const SUBJECT_SNIPPET_MAX = 60;

// First non-empty line of the message, whitespace collapsed, cut to fit a
// ticket list row.
export function subjectSnippet(message: string | null | undefined): string {
  const line = (message ?? '')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .find(l => l.length > 0) ?? '';
  return line.length > SUBJECT_SNIPPET_MAX ? `${line.slice(0, SUBJECT_SNIPPET_MAX - 1)}…` : line;
}

// `unitExists`: whether makelila has a unit with the feedback's serial. Same
// foreign-key reasoning as reportToTicket: an unknown serial is noted in the
// description instead of failing the insert.
export function feedbackToTicket(
  fb: LovelyFeedback,
  customer: ResolvedCustomer,
  unitExists: boolean,
): FeedbackTicketInsert {
  const meta = KIND_META[fb.kind] ?? KIND_META.other;
  const serial = normalizeSerial(fb.serial_number);
  const snippet = subjectSnippet(fb.message);

  const context = [
    "Sent from the Lovely app's feedback button.",
    fb.user_name?.trim() ? `Name in the app: ${fb.user_name.trim()}` : null,
    fb.page_path ? `Page: ${fb.page_path}` : null,
    fb.app_version ? `App version: ${fb.app_version}` : null,
    fb.user_agent ? `Device: ${fb.user_agent}` : null,
    serial && !unitExists
      ? `Serial on the Lovely account: ${serial}. It matched no unit in makelila, so any unit shown on this ticket was inferred from the customer.`
      : null,
  ].filter((l): l is string => l !== null);

  return {
    source: 'lovely_app',
    kind: 'ticket',
    category: 'support',
    status: 'waiting_on_us',
    priority: meta.priority,
    issue_area: meta.issue_area,
    subject: snippet ? `${meta.label}: ${snippet}` : `${meta.label} from the Lovely app`,
    description: `${fb.message?.trim() || 'No message provided.'}\n\n${context.join('\n')}`,
    unit_serial: unitExists ? serial : null,
    customer_id: customer.customer_id,
    // Unmatched senders keep the name and email from their app account, so CS
    // still has someone to reply to.
    customer_name: customer.customer_name ?? (fb.user_name?.trim() || null),
    customer_email: customer.customer_email ?? fb.email ?? null,
    lovely_feedback_id: fb.id,
    lovely_feedback_photo_path: fb.photo_path || null,
    ...(fb.created_at ? { created_at: fb.created_at } : {}),
  };
}
