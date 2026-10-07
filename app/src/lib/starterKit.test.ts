import { describe, it, expect } from 'vitest';
import {
  amazonOrdersUrl,
  isMissingStarterSkipColumn,
  starterBlocker,
  starterRequired,
  starterSettled,
  STARTER_BLOCKER,
} from './starterKit';

describe('starterRequired — who is owed a bag of soil', () => {
  it('asks it of every machine sale, US and CA alike', () => {
    expect(starterRequired({ kind: 'sale', country: 'US' })).toBe(true);
    expect(starterRequired({ kind: 'sale', country: 'CA' })).toBe(true);
  });

  // The customer already bought a machine and already got the soil that came
  // with it. Sending another bag with a $24 lid is not the workflow.
  it('asks nothing of a replacement, whatever is in the box', () => {
    expect(starterRequired({ kind: 'replacement', country: 'US' })).toBe(false);
    expect(starterRequired({ kind: 'replacement', country: 'CA' })).toBe(false);
  });
});

describe('starterSettled — has the question been answered', () => {
  it('a tracking number answers it', () => {
    expect(starterSettled({ starter_tracking_num: 'TBA303011917292' })).toBe(true);
  });

  it('a declared exemption answers it', () => {
    expect(starterSettled({
      starter_tracking_num: null,
      starter_skipped_at: '2026-10-07T12:00:00Z',
      starter_skip_reason: 'customer already has one',
    })).toBe(true);
  });

  it('nothing on the row does not', () => {
    expect(starterSettled({ starter_tracking_num: null })).toBe(false);
  });

  // The field exists and has been typed in, but with whitespace. That is the
  // same as empty — a space is not a tracking number.
  it('a blank-looking number does not', () => {
    expect(starterSettled({ starter_tracking_num: '   ' })).toBe(false);
  });

  // A database that has not run 20261007120000 returns rows with neither skip
  // column on them. That must read as "not skipped", not throw.
  it('reads a row from before the migration as unanswered', () => {
    expect(starterSettled({ starter_tracking_num: null })).toBe(false);
  });
});

describe('starterBlocker — what step 3 is still waiting on', () => {
  it('names the starter on an unanswered sale', () => {
    expect(starterBlocker({ kind: 'sale', country: 'CA' }, { starter_tracking_num: null }))
      .toBe(STARTER_BLOCKER);
  });

  it('is silent once a number is on the row', () => {
    expect(starterBlocker({ kind: 'sale', country: 'CA' }, { starter_tracking_num: 'TBA1' }))
      .toBeNull();
  });

  it('is silent on an exempted sale', () => {
    expect(starterBlocker(
      { kind: 'sale', country: 'US' },
      { starter_tracking_num: null, starter_skipped_at: '2026-10-07T12:00:00Z' },
    )).toBeNull();
  });

  // The failure this gate had the first time round: an order with no starter
  // kit, no number to paste, and no way past the step (5a01566).
  it('is silent on a replacement with nothing on the row at all', () => {
    expect(starterBlocker({ kind: 'replacement', country: 'US' }, { starter_tracking_num: null }))
      .toBeNull();
  });

  it('names the soil rather than the field — the operator has shopping to do', () => {
    expect(STARTER_BLOCKER).toMatch(/compost starter/i);
    expect(STARTER_BLOCKER).toMatch(/Amazon/);
  });
});

describe('amazonOrdersUrl — the storefront follows the destination', () => {
  // Amazon's storefronts are separate businesses with separate carts: a
  // Canadian shipment booked on amazon.com arrives with a customs charge on a
  // bag of soil, when it arrives at all.
  it('sends a Canadian shipment to amazon.ca', () => {
    expect(amazonOrdersUrl('CA')).toContain('amazon.ca');
  });

  it('sends a US one to amazon.com', () => {
    expect(amazonOrdersUrl('US')).toContain('amazon.com');
  });

  it('falls back to amazon.com when the destination is unknown', () => {
    expect(amazonOrdersUrl(null)).toContain('amazon.com');
    expect(amazonOrdersUrl(undefined)).toContain('amazon.com');
  });
});

describe('isMissingStarterSkipColumn — a deploy that landed before the DDL', () => {
  it('recognises undefined_column', () => {
    expect(isMissingStarterSkipColumn({ code: '42703' })).toBe(true);
  });

  it('recognises PostgREST failing to find it in its schema cache', () => {
    expect(isMissingStarterSkipColumn({ code: 'PGRST204' })).toBe(true);
  });

  it('recognises it by name when there is no code', () => {
    expect(isMissingStarterSkipColumn(new Error(
      "Could not find the 'starter_skipped_at' column of 'fulfillment_queue'",
    ))).toBe(true);
  });

  it('does not swallow a real failure', () => {
    expect(isMissingStarterSkipColumn(new Error('network error'))).toBe(false);
    expect(isMissingStarterSkipColumn({ code: '23514' })).toBe(false);
    expect(isMissingStarterSkipColumn(null)).toBe(false);
  });
});
