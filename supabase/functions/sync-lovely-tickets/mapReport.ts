// Pure mapping from a Lovely damage report to a service_tickets insert row.
// No imports: kept runtime-neutral so it is testable without a database.

export type DamageReport = {
  id: string;
  user_id: string | null;
  serial_number: string | null;
  notes: string | null;
  created_at: string | null;
};

export type CustomerLookups = {
  /** units.serial (normalised) → units.customer_id */
  customerIdBySerial: Map<string, string>;
  /** customer_app_links.lovely_user_id → link */
  linkByUserId: Map<string, { customer_id: string | null; email: string | null }>;
  /** every units.serial (normalised) that exists, with or without a customer */
  knownSerials: Set<string>;
  /** customers.id → display fields */
  customerById: Map<string, { full_name: string | null; email: string | null }>;
};

export type ResolvedCustomer = {
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
};

export type TicketInsert = {
  source: 'lovely_app';
  kind: 'ticket';
  category: 'support';
  status: 'waiting_on_us';
  priority: 'normal';
  issue_area: 'shipping';
  subject: string;
  description: string;
  unit_serial: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  lovely_report_id: string;
  created_at?: string;
};

export function normalizeSerial(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase();
  return s || null;
}

// Serials are typed by customers and end up in a PostgREST `in (...)` filter.
// Anything outside this shape is treated as an unknown unit rather than sent,
// so one malformed serial cannot fail the lookup for every report.
export function isLookupSafeSerial(serial: string): boolean {
  return /^[A-Z0-9-]{1,40}$/.test(serial);
}

// Same order as ingest-lovely-event: the unit's serial is the strongest
// signal, the app account link is the fallback.
export function resolveCustomer(report: DamageReport, lookups: CustomerLookups): ResolvedCustomer {
  const serial = normalizeSerial(report.serial_number);
  const link = report.user_id ? lookups.linkByUserId.get(report.user_id) : undefined;
  const customerId =
    (serial ? lookups.customerIdBySerial.get(serial) : undefined)
    ?? link?.customer_id
    ?? null;

  if (customerId) {
    const c = lookups.customerById.get(customerId);
    return {
      customer_id: customerId,
      customer_name: c?.full_name?.trim() || null,
      customer_email: c?.email ?? link?.email ?? null,
    };
  }
  return { customer_id: null, customer_name: null, customer_email: link?.email ?? null };
}

// `unitExists`: whether makelila has a unit with the report's serial.
// service_tickets.unit_serial is a foreign key to units(serial), so an unknown
// serial is kept in the subject and description instead of failing the insert.
export function reportToTicket(
  report: DamageReport,
  customer: ResolvedCustomer,
  unitExists: boolean,
): TicketInsert {
  const serial = normalizeSerial(report.serial_number);
  const notes = report.notes?.trim() || 'No notes provided.';
  return {
    source: 'lovely_app',
    kind: 'ticket',
    category: 'support',
    status: 'waiting_on_us',
    priority: 'normal',
    issue_area: 'shipping',
    subject: serial ? `Damage report: ${serial}` : 'Damage report from Lovely app',
    description: serial && !unitExists
      ? `${notes}\n\nSerial entered in the Lovely app: ${serial}. It matched no unit in makelila, so any unit shown on this ticket was inferred from the customer.`
      : notes,
    unit_serial: unitExists ? serial : null,
    ...customer,
    lovely_report_id: report.id,
    ...(report.created_at ? { created_at: report.created_at } : {}),
  };
}
