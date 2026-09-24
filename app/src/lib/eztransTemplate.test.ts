import { describe, it, expect } from 'vitest';
// The EZ Trans wording exists in three places by necessity: the panel needs it
// to preview without a round-trip, the edge function needs it to send when the
// template row hasn't been migrated into an environment, and the migration
// seeds the editable row. Nothing in the toolchain would notice them drifting
// apart, and the failure mode is a 3PL that gets different instructions
// depending on which environment sent the mail — so assert it here.
import {
  DEFAULT_EZTRANS_BODY,
  DEFAULT_EZTRANS_SUBJECT,
  EZTRANS_TEMPLATE_KEY,
  ezTransVariables,
  buildEzTransBooking,
  type EzTransShipTo,
} from './eztrans';
import { renderTemplate } from './templates';
import {
  DEFAULT_EZTRANS_BODY as SHARED_BODY,
  DEFAULT_EZTRANS_SUBJECT as SHARED_SUBJECT,
  EZTRANS_TEMPLATE_KEY as SHARED_KEY,
  EZTRANS_TEMPLATE_VARIABLES,
  renderEzTransTemplate,
} from '../../../supabase/functions/_shared/eztransTemplate.ts';

// Every migration that touches this template row, not just the one that
// seeded it: the wording has been changed since (the label and the packing
// list are one attachment now), and what matters is that the row a migrated
// database ends up with is the built-in default — not which file put it there.
const MIGRATION = Object.entries(
  import.meta.glob('../../../supabase/migrations/*_eztrans_booking*.sql', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>,
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, sql]) => sql)
  .join('\n');

const ORDER: EzTransShipTo & { order_ref: string } = {
  order_ref: '#1184',
  customer_name: 'Juanita M Wells',
  customer_email: 'juanita@example.com',
  customer_phone: '+17095551234',
  address_line: '14 Grenfell Drive',
  address_line2: 'Unit 3',
  city: 'Wabush',
  region_state: 'NL',
  postal_code: 'A0R 1B0',
  country: 'CA',
};

const ARGS = {
  order: ORDER,
  serial: 'LL01-P100X-00412',
  masterCarton: '1',
  carrier: 'Purolator',
  tracking: 'PUR123456789',
};

describe('the built-in default does not drift from the edge function copy', () => {
  it('uses the same template key on both sides', () => {
    expect(EZTRANS_TEMPLATE_KEY).toBe(SHARED_KEY);
  });

  it('has a byte-identical subject', () => {
    expect(DEFAULT_EZTRANS_SUBJECT).toBe(SHARED_SUBJECT);
  });

  it('has a byte-identical body', () => {
    expect(DEFAULT_EZTRANS_BODY).toBe(SHARED_BODY);
  });

  it('substitutes variables the same way on both sides', () => {
    const vars = ezTransVariables(ARGS);
    expect(renderTemplate(DEFAULT_EZTRANS_BODY, vars))
      .toBe(renderEzTransTemplate(SHARED_BODY, vars));
    // An unfilled variable is left standing, not blanked, in both.
    expect(renderTemplate('x {{nope}}', {})).toBe('x {{nope}}');
    expect(renderEzTransTemplate('x {{nope}}', {})).toBe('x {{nope}}');
  });
});

describe('the migrations leave the row matching the built-in default', () => {
  it('are in the repo', () => {
    expect(MIGRATION).toBeTruthy();
  });

  it('leaves the same key and the same subject and body', () => {
    // The migration writes E'...' strings, so \n is an escape there and a real
    // newline here. Compare after undoing that.
    const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/''/g, "'");
    const literals = [...MIGRATION.matchAll(/E'((?:[^']|'')*)'/g)].map(m => unescape(m[1]));
    expect(MIGRATION).toContain(`'${EZTRANS_TEMPLATE_KEY}'`);
    expect(literals).toContain(DEFAULT_EZTRANS_SUBJECT);
    expect(literals).toContain(DEFAULT_EZTRANS_BODY);
  });

  it('declares every variable the default actually uses', () => {
    const used = [...DEFAULT_EZTRANS_BODY.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
    const declared = new Set(EZTRANS_TEMPLATE_VARIABLES);
    for (const v of used) expect(declared.has(v as never)).toBe(true);
    for (const v of EZTRANS_TEMPLATE_VARIABLES) expect(MIGRATION).toContain(`'${v}'`);
  });

  it('fills every variable it declares — no {{placeholder}} reaches the 3PL', () => {
    const rendered = buildEzTransBooking(ARGS);
    expect(rendered.body).not.toMatch(/\{\{/);
    expect(rendered.subject).not.toMatch(/\{\{/);
  });
});

describe('an edited template', () => {
  it('is what gets rendered when one is supplied', () => {
    const rendered = buildEzTransBooking({
      ...ARGS,
      template: { subject: 'Rush — {{order_ref}}', body: 'Please expedite {{serial}}.' },
    });
    expect(rendered.subject).toBe('Rush — #1184');
    expect(rendered.body).toBe('Please expedite LL01-P100X-00412.');
  });

  it('cannot change the packing list', () => {
    const rendered = buildEzTransBooking({
      ...ARGS,
      template: { subject: 'x', body: 'nothing about the shipment at all' },
    });
    const list = rendered.packingList.join('\n');
    expect(list).toContain('Serial No: LL01-P100X-00412');
    expect(list).toContain('Master Carton: 1');
    expect(list).toContain('SKU: LILA-P100X');
    expect(list).toContain('Carrier: Purolator');
  });

  it('falls back to the default when the row is empty or missing', () => {
    expect(buildEzTransBooking({ ...ARGS, template: null }).body)
      .toBe(buildEzTransBooking(ARGS).body);
    expect(buildEzTransBooking({ ...ARGS, template: { subject: '', body: '' } }).subject)
      .toBe(buildEzTransBooking(ARGS).subject);
  });
});
