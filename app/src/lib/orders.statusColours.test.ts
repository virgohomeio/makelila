import { describe, it, expect } from 'vitest';
import { ORDER_STATUS_META, OPEN_ORDER_STATUSES } from './orders';
import type { OrderStatus } from './orders';

/* Sales' status palette moved off the cool blue-gray ramp the redesign spec
 * marked for deletion, onto the same warm system Support Tickets uses. These
 * tests pin the two properties that made the move worth doing, so a future
 * edit can't quietly undo them. They deliberately mirror
 * service.statusColours.test.ts — if the rule changes, it changes in both. */

const LADYBUG_RED = '#CC2D30';
const PAGE_GROUND = '#FAF8F5';   // --color-page

const ALL = Object.keys(ORDER_STATUS_META) as OrderStatus[];

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  expect(h, `${hex} should be a 6-digit hex`).toMatch(/^[0-9a-fA-F]{6}$/);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, always >= 1. */
function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** How red-dominant a colour is: red channel margin over the larger of G/B,
 *  as a fraction of 255. Ladybug Red scores ~0.61; a warm clay scores ~0.24. */
function redness(hex: string): number {
  const [r, g, b] = channels(hex);
  return (r - Math.max(g, b)) / 255;
}

describe('order status colours', () => {
  it('covers every OrderStatus', () => {
    // Compile-time exhaustiveness would not catch a status added to the union
    // and to the map with an empty label, so check the shape too.
    expect(ALL.length).toBeGreaterThanOrEqual(5);
    for (const s of ALL) {
      expect(ORDER_STATUS_META[s].label, `${s} has no label`).toBeTruthy();
    }
  });

  it.each(ALL)('%s pill text clears AA against its own bg', (s) => {
    const { color, bg } = ORDER_STATUS_META[s];
    expect(contrast(color, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ALL)('%s pill text clears AA against the page ground', (s) => {
    expect(contrast(ORDER_STATUS_META[s].color, PAGE_GROUND)).toBeGreaterThanOrEqual(4.5);
  });

  // Queue-bar segments are filled with `color` and carry white numerals.
  it.each(ALL)('%s reads as a segment fill under white text', (s) => {
    expect(contrast('#FFFFFF', ORDER_STATUS_META[s].color)).toBeGreaterThanOrEqual(4.5);
  });

  it('holds no colour that competes with Ladybug Red', () => {
    expect(redness(LADYBUG_RED)).toBeGreaterThan(0.5);
    for (const s of ALL) {
      expect(
        redness(ORDER_STATUS_META[s].color),
        `${s} (${ORDER_STATUS_META[s].color}) reads as a competing red`,
      ).toBeLessThan(0.35);
    }
  });

  it('leaves the terminal status out of the open queue', () => {
    expect(OPEN_ORDER_STATUSES).not.toContain('cancelled');
    for (const s of OPEN_ORDER_STATUSES) {
      expect(ORDER_STATUS_META[s], `${s} has no colour`).toBeDefined();
    }
  });
});
