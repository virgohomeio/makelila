import { describe, it, expect } from 'vitest';
import { freightcomBookingConfirmed, FREIGHTCOM_SHIP_URL } from './freightcomBooking';

// The rule behind step 3's last gate on a Freightcom carton, and the one the
// panel reads to decide whether it is showing a booking or asking for one. It
// is derived from the row on purpose — there is no column claiming "this
// booking is confirmed", because a column like that can only ever come to
// disagree with the three fields that ARE the booking.
describe('freightcomBookingConfirmed', () => {
  const full = {
    carrier: 'UPS',
    tracking_num: '1Z2985EADK98125759',
    label_pdf_path: 'q-1/label-1760000000000.pdf',
  };

  it('takes all three together as a booking on the record', () => {
    expect(freightcomBookingConfirmed(full)).toBe(true);
  });

  // The label is the one that was optional before 2026-10-08, and the one a
  // claim against a lost box needs. Two of three is a booking half made.
  it('refuses a row with no label PDF on it', () => {
    expect(freightcomBookingConfirmed({ ...full, label_pdf_path: null })).toBe(false);
  });

  it('refuses a row with no carrier and a row with no tracking number', () => {
    expect(freightcomBookingConfirmed({ ...full, carrier: null })).toBe(false);
    expect(freightcomBookingConfirmed({ ...full, tracking_num: null })).toBe(false);
  });

  // A dropdown cleared back to its empty option writes '' rather than null,
  // and a tracking field can hold the whitespace a paste brought with it.
  // Either read as "present" would open the gate on nothing.
  it('does not mistake blank text for an answer', () => {
    expect(freightcomBookingConfirmed({ ...full, carrier: '' })).toBe(false);
    expect(freightcomBookingConfirmed({ ...full, tracking_num: '   ' })).toBe(false);
  });

  it('points at our own Freightcom account, over https', () => {
    expect(FREIGHTCOM_SHIP_URL).toMatch(/^https:\/\/live\.freightcom\.com\//);
  });
});
