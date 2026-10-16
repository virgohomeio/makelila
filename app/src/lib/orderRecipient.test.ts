import { describe, it, expect } from 'vitest';
import { resolveOrderRecipient, sameParty } from './orderRecipient';

const order = (over: Partial<Parameters<typeof resolveOrderRecipient>[0]> = {}) => ({
  customer_name: 'Candace Chan',
  customer_email: null as string | null,
  customer_id: '0028d187' as string | null,
  ...over,
});

const directory = (over: Partial<NonNullable<Parameters<typeof resolveOrderRecipient>[1]>> = {}) => ({
  id: '0028d187',
  full_name: 'Candace Chan',
  email: 'garycandacechan@gmail.com',
  primary_user_email: null as string | null,
  ...over,
});

describe('sameParty', () => {
  it('ignores case and surrounding space', () => {
    expect(sameParty('Candace Chan', '  candace chan ')).toBe(true);
  });

  it('ignores the doubled spacing a generated full_name can carry', () => {
    // customers.full_name is generated from first_name + last_name, so a blank
    // middle component leaves two spaces where the order has one.
    expect(sameParty('Candace Chan', 'Candace  Chan')).toBe(true);
  });

  it('is false for two different people', () => {
    expect(sameParty('Scott Gilbert', 'Karolina Chmiel')).toBe(false);
  });

  it('is false when either side is blank', () => {
    expect(sameParty('', 'Candace Chan')).toBe(false);
    expect(sameParty('Candace Chan', null)).toBe(false);
  });
});

describe('resolveOrderRecipient', () => {
  it("uses the order's own column when it has one", () => {
    const r = resolveOrderRecipient(
      order({ customer_email: 'onorder@example.com' }),
      directory(),
    );
    expect(r).toEqual({ email: 'onorder@example.com', source: 'order', nameMismatch: false });
  });

  it('falls back to the linked customer record when the order column is null', () => {
    // R-0023 (Candace Chan): born off an ops_manual ticket with no email, while
    // the directory had one all along. This is the bug this module exists for.
    const r = resolveOrderRecipient(order(), directory());
    expect(r).toEqual({
      email: 'garycandacechan@gmail.com',
      source: 'directory',
      nameMismatch: false,
    });
  });

  it("prefers the primary user's own address over the purchaser's", () => {
    // Same precedence as resolveCustomerParties: outbound mail addresses the
    // person running the machine when they have an inbox of their own.
    const r = resolveOrderRecipient(
      order(),
      directory({ primary_user_email: 'theuser@example.com' }),
    );
    expect(r.email).toBe('theuser@example.com');
    expect(r.source).toBe('directory');
  });

  it('still reaches the purchaser when the primary user has no address on file', () => {
    // R-0018 (Scott Gilbert): primary_user_name 'Karolina Chmiel' with no
    // primary_user_email. Mail must still reach somebody.
    const r = resolveOrderRecipient(
      order({ customer_name: 'Scott Gilbert' }),
      directory({ full_name: 'Scott Gilbert', email: 'mrscottg@gmail.com' }),
    );
    expect(r.email).toBe('mrscottg@gmail.com');
  });

  it('refuses a directory row that names a different person', () => {
    // orders.customer_id is set by a trigger that matches on NAME as well as
    // email, and a name match can land on the wrong customer. Better to ask the
    // operator for an address than to email a stranger their shipment.
    const r = resolveOrderRecipient(
      order({ customer_name: 'Jason Amero' }),
      directory(),
    );
    expect(r).toEqual({ email: null, source: null, nameMismatch: true });
  });

  it('resolves nothing when the order has no customer linked', () => {
    // R-0010 / R-0026 — no customer_id at all. These genuinely still block.
    const r = resolveOrderRecipient(order({ customer_id: null }), null);
    expect(r).toEqual({ email: null, source: null, nameMismatch: false });
  });

  it('resolves nothing when the linked record has no address either', () => {
    const r = resolveOrderRecipient(order(), directory({ email: null }));
    expect(r).toEqual({ email: null, source: null, nameMismatch: false });
  });

  it('trims a padded address rather than handing Resend whitespace', () => {
    const r = resolveOrderRecipient(order(), directory({ email: '  garycandacechan@gmail.com  ' }));
    expect(r.email).toBe('garycandacechan@gmail.com');
  });

  it('treats an empty string on the order as no address', () => {
    const r = resolveOrderRecipient(order({ customer_email: '   ' }), directory());
    expect(r).toEqual({
      email: 'garycandacechan@gmail.com',
      source: 'directory',
      nameMismatch: false,
    });
  });
});
