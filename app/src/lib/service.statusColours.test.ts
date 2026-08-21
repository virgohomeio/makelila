import { describe, it, expect } from 'vitest';
import {
  STATUS_META, CATEGORY_META, PRIORITY_META,
  TICKET_STATUSES, statusMeta, priorityMeta,
} from './service';

/* The status/category/priority palettes moved off the cool blue-gray ramp the
 * redesign spec marked for deletion. These tests pin the two properties that
 * made the move worth doing, so a future edit can't quietly undo them:
 *
 *   1. Pill text clears WCAG AA (4.5:1) against its own background.
 *   2. Nothing in these palettes is a red that competes with Ladybug Red
 *      #CC2D30, which is reserved for action. 'urgent' priority is the one
 *      deliberate exception — it is a warning, not an action.
 */

const LADYBUG_RED = '#CC2D30';

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

describe('ticket status colours', () => {
  it('covers every status in TICKET_STATUSES', () => {
    for (const s of TICKET_STATUSES) {
      expect(STATUS_META[s], `STATUS_META is missing ${s}`).toBeDefined();
      expect(typeof STATUS_META[s].label).toBe('string');
    }
  });

  it.each(TICKET_STATUSES)('%s pill text clears AA against its own bg', (s) => {
    const { color, bg } = STATUS_META[s];
    expect(contrast(color, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TICKET_STATUSES)('%s pill text clears AA against the page ground', (s) => {
    // Pills also sit directly on --color-page in a few places (kanban cards).
    expect(contrast(STATUS_META[s].color, '#FAF8F5')).toBeGreaterThanOrEqual(4.5);
  });

  it('holds no colour that competes with Ladybug Red', () => {
    // Ladybug Red is far more red-dominant than anything in the warm ramp.
    expect(redness(LADYBUG_RED)).toBeGreaterThan(0.5);
    for (const s of TICKET_STATUSES) {
      expect(
        redness(STATUS_META[s].color),
        `${s} (${STATUS_META[s].color}) reads as a competing red`,
      ).toBeLessThan(0.35);
    }
  });

  it('has retired the cool blue-gray ramp', () => {
    const retired = ['#2b6cb0', '#718096', '#edf2f7', '#f7fafc', '#cbd5e0', '#a0aec0'];
    const inUse = [
      ...TICKET_STATUSES.flatMap(s => [STATUS_META[s].color, STATUS_META[s].bg]),
      ...Object.values(CATEGORY_META).flatMap(m => [m.color, m.bg]),
      ...Object.values(PRIORITY_META).map(m => m.color),
      statusMeta('some_unknown_status').color,
      statusMeta('some_unknown_status').bg,
      priorityMeta('some_unknown_priority').color,
    ].map(v => v.toLowerCase());
    for (const dead of retired) {
      expect(inUse, `${dead} is back`).not.toContain(dead);
    }
  });

  it('gives every status a distinct colour', () => {
    const colours = TICKET_STATUSES.map(s => STATUS_META[s].color.toLowerCase());
    expect(new Set(colours).size).toBe(colours.length);
  });
});

describe('category + priority colours', () => {
  it.each(Object.keys(CATEGORY_META))('%s category badge clears AA', (k) => {
    const m = CATEGORY_META[k as keyof typeof CATEGORY_META];
    expect(contrast(m.color, m.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Object.keys(PRIORITY_META))('%s priority text clears AA on the page', (k) => {
    const m = PRIORITY_META[k as keyof typeof PRIORITY_META];
    expect(contrast(m.color, '#FAF8F5')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps urgent as the only red, and deeper than Ladybug Red', () => {
    expect(redness(PRIORITY_META.urgent.color)).toBeGreaterThan(0.35);
    for (const k of ['low', 'normal', 'high'] as const) {
      expect(redness(PRIORITY_META[k].color)).toBeLessThan(0.35);
    }
    // urgent uses --color-error-strong. tokens.css documents that this token
    // is deliberately NOT held to the >=1.7 luminance separation from Ladybug
    // Red that --color-error carries -- reaching 1.7 would require going
    // nearly as dark as --color-error and collapse the base/strong pair. What
    // it must be is unambiguously deeper than the brand red, and AA-legible.
    expect(luminance(PRIORITY_META.urgent.color)).toBeLessThan(luminance(LADYBUG_RED));
    expect(contrast(PRIORITY_META.urgent.color, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
