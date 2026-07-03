// Diagnoses why a pending Lovely app user did or didn't auto-verify, using
// EXACTLY the Lovely app's matching rules (Lovely repo lib/inventory.ts):
// email trim+lowercase exact match; serial trim+uppercase compared to each
// serials[] element (elements also trimmed+uppercased). Keep in sync.
import { approveLovelyUser, type LovelyUser } from './lovely';
import { supabase } from './supabase';
import { logAction } from './activityLog';

export type CustomerSerialRecord = {
  id: string;
  email: string | null;
  full_name: string | null;
  serials: string[] | null;
};

export type VerificationVerdict =
  | 'will_auto_verify'   // match exists; user just needs to revisit the app
  | 'no_serial'          // nothing paired on the Lovely account yet
  | 'no_customer'        // no ops customer with this email
  | 'serial_mismatch';   // customer found, serial absent from their arrays

export type Diagnosis = {
  verdict: VerificationVerdict;
  matchedCustomers: CustomerSerialRecord[];
  serialOwner: CustomerSerialRecord | null;
};

const normalizeEmail = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();
export const normalizeSerial = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();

function hasSerial(c: CustomerSerialRecord, serial: string): boolean {
  return (c.serials ?? []).some(
    s => typeof s === 'string' && s.trim().toUpperCase() === serial,
  );
}

export function diagnoseUser(
  user: Pick<LovelyUser, 'email' | 'serial_number'>,
  customersByEmail: CustomerSerialRecord[],
  serialOwners: CustomerSerialRecord[],
): Diagnosis {
  const email = normalizeEmail(user.email);
  const serial = normalizeSerial(user.serial_number);
  const matchedCustomers = customersByEmail.filter(c => normalizeEmail(c.email) === email);
  const serialOwner = serial
    ? serialOwners.find(c => hasSerial(c, serial) && normalizeEmail(c.email) !== email) ?? null
    : null;

  let verdict: VerificationVerdict;
  if (!serial) verdict = 'no_serial';
  else if (matchedCustomers.length === 0) verdict = 'no_customer';
  else if (matchedCustomers.some(c => hasSerial(c, serial))) verdict = 'will_auto_verify';
  else verdict = 'serial_mismatch';

  return { verdict, matchedCustomers, serialOwner };
}

export type VerificationContext = {
  customersByEmail: CustomerSerialRecord[];
  serialOwners: CustomerSerialRecord[];
};

// Escape ILIKE wildcards so emails containing _ or % only match literally
// (mirrors the Lovely app's escapeIlike).
const escapeIlike = (v: string) => v.replace(/([\\%_])/g, '\\$1');

// PostgREST's .or() treats unescaped `,` `(` `)` as structural delimiters
// (and `"` as a quoting character), so an email containing one of these
// would corrupt the whole filter string. Emails with any of these characters
// are queried individually instead of via the or-chain.
const hasOrDelimiterChar = (v: string) => /[,()"]/.test(v);

/** One case-insensitive or-chain query covers emails that are safe for
 *  PostgREST's .or() filter syntax; any email containing a `.or()` delimiter
 *  character (`,` `(` `)` `"`) instead gets its own `.ilike('email', …)`
 *  query — the same shape the Lovely app itself uses to look up a single
 *  email — run in parallel and merged into customersByEmail. Plus one
 *  serials-overlap query. Exact-element overlap is OK: stored serials are
 *  normalized LL01-… uppercase (queue serials validated on assignment;
 *  sheet sync extracts LL01-[0-9]+). */
export async function fetchVerificationContext(users: LovelyUser[]): Promise<VerificationContext> {
  const emails = [...new Set(
    users.map(u => (u.email ?? '').trim().toLowerCase()).filter(Boolean),
  )];
  if (emails.length === 0) return { customersByEmail: [], serialOwners: [] };

  const serials = [...new Set(
    users.map(u => normalizeSerial(u.serial_number)).filter(Boolean),
  )];
  const safeEmails = emails.filter(e => !hasOrDelimiterChar(e));
  const unsafeEmails = emails.filter(e => hasOrDelimiterChar(e));

  const customersByEmail: CustomerSerialRecord[] = [];

  if (safeEmails.length > 0) {
    const orFilter = safeEmails.map(e => `email.ilike.${escapeIlike(e)}`).join(',');
    const { data: byEmail, error: emailErr } = await supabase
      .from('customers')
      .select('id, email, full_name, serials')
      .or(orFilter);
    if (emailErr) throw new Error(emailErr.message);
    customersByEmail.push(...((byEmail ?? []) as CustomerSerialRecord[]));
  }

  if (unsafeEmails.length > 0) {
    const perEmailResults = await Promise.all(
      unsafeEmails.map(async (email) => {
        const { data, error } = await supabase
          .from('customers')
          .select('id, email, full_name, serials')
          .ilike('email', escapeIlike(email));
        if (error) throw new Error(error.message);
        return (data ?? []) as CustomerSerialRecord[];
      }),
    );
    for (const rows of perEmailResults) customersByEmail.push(...rows);
  }

  let serialOwners: CustomerSerialRecord[] = [];
  if (serials.length > 0) {
    const { data: owners, error: serialErr } = await supabase
      .from('customers')
      .select('id, email, full_name, serials')
      .overlaps('serials', serials);
    if (serialErr) throw new Error(serialErr.message);
    serialOwners = (owners ?? []) as CustomerSerialRecord[];
  }

  return { customersByEmail, serialOwners };
}

/** Verification-tab fix: add the user's serial to the customer record
 *  (durable via customer_serial_overrides), then verify them in the Lovely
 *  app. Idempotent RPC + plain flag set, so retrying after a partial
 *  failure is safe. */
export async function addSerialAndVerify(user: LovelyUser, customerId: string): Promise<void> {
  const serial = normalizeSerial(user.serial_number);
  if (!serial) throw new Error('User has no paired serial to add.');

  const { error } = await supabase.rpc('add_customer_serial', {
    p_customer_id: customerId,
    p_serial: serial,
    p_reason: `Verification tab fix for Lovely user ${user.email}`,
  });
  if (error) throw new Error(error.message);

  await approveLovelyUser(user.id);
  await logAction(
    'lovely_serial_added',
    user.email ?? user.id,
    `Added ${serial} to customer + verified ${user.email ?? user.id}`,
    { entityType: 'customer', entityId: customerId, unitSerial: serial },
  );
}
