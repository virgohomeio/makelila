import { describe, it, expect } from 'vitest';
import {
  WARN_CAD, CRITICAL_CAD,
  flagFor, dedupe, averageByWeekday, bestRatePerOrder, driftSince, isCalifornia,
  money, signed, pctBelow,
} from '../../../supabase/functions/_shared/freightRateReport.ts';
import type { ProbeRow } from '../../../supabase/functions/_shared/freightRateReport.ts';

// The arithmetic behind the rate-probe report. The edge functions themselves
// run untested against the live API, so this module is where the parts that can
// be wrong quietly — a threshold off by a cent, a weekday average that
// double-counts a tie, a ZIP range that misses San Jose — are actually pinned.
//
// Rates used below are the ones measured against the live API on 2026-09-10 and
// the pair already in freight_quotes, so the fixtures are the real shape of the
// data rather than round numbers.

function row(over: Partial<ProbeRow> & { order_id: string; rate_cad: number | null }): ProbeRow {
  return {
    order_ref: '#1185',
    customer_name: 'James Soto',
    dest_postal: '94526',
    dest_country: 'US',
    ship_date: '2026-09-23',
    ship_weekday: 3,
    run_index: 1,
    ...over,
  };
}

describe('flagFor', () => {
  it('flags strictly above the thresholds, not at them', () => {
    // "Over $150 and $200" — $150.00 exactly is not over $150.
    expect(flagFor(WARN_CAD)).toBe('none');
    expect(flagFor(WARN_CAD + 0.01)).toBe('warn');
    expect(flagFor(CRITICAL_CAD)).toBe('warn');
    expect(flagFor(CRITICAL_CAD + 0.01)).toBe('critical');
  });

  it('places the measured live rates where an operator would expect', () => {
    expect(flagFor(36.43)).toBe('none');      // Toronto, one box
    expect(flagFor(59.98)).toBe('none');      // Toronto, two boxes
    expect(flagFor(125.52)).toBe('none');     // rural ON, extended-area surcharge
    expect(flagFor(167.87)).toBe('warn');     // 90210, UPS Standard
    expect(flagFor(180.27)).toBe('warn');
    expect(flagFor(240.00)).toBe('critical');
  });

  it('treats a missing or non-finite rate as unflagged rather than as zero', () => {
    // A non-CAD total is stored as null. Reading that as $0 would silently
    // report the dearest shipments as the cheapest day of the week.
    expect(flagFor(null)).toBe('none');
    expect(flagFor(Number.NaN)).toBe('none');
  });
});

describe('dedupe', () => {
  it('keeps one row per order, ship date and run when carriers tie', () => {
    const tied = [
      row({ order_id: 'a', rate_cad: 36.43 }),
      row({ order_id: 'a', rate_cad: 36.43 }),  // second carrier, same price
      row({ order_id: 'a', rate_cad: 36.43, ship_date: '2026-09-24', ship_weekday: 4 }),
      row({ order_id: 'b', rate_cad: 59.98 }),
    ];
    expect(dedupe(tied)).toHaveLength(3);
  });

  it('does not collapse the same order across runs', () => {
    const across = [
      row({ order_id: 'a', rate_cad: 169.24, run_index: 1 }),
      row({ order_id: 'a', rate_cad: 180.27, run_index: 2 }),
    ];
    expect(dedupe(across)).toHaveLength(2);
  });
});

describe('averageByWeekday', () => {
  it('sorts cheapest weekday first and averages across customers', () => {
    const rows = [
      row({ order_id: 'a', rate_cad: 100, ship_weekday: 1 }),
      row({ order_id: 'b', rate_cad: 200, ship_weekday: 1 }),
      row({ order_id: 'a', rate_cad: 120, ship_weekday: 5 }),
      row({ order_id: 'b', rate_cad: 130, ship_weekday: 5 }),
    ];
    const out = averageByWeekday(rows);
    expect(out[0]).toEqual({ day: 5, avg: 125, n: 2 });
    expect(out[1]).toEqual({ day: 1, avg: 150, n: 2 });
  });

  it('averages rather than minimises, so the nearest customer cannot win every day', () => {
    // A Toronto order is cheaper than a rural one on every weekday. Taking a
    // minimum across customers would report Toronto's weekday as "cheapest"
    // regardless of what the rate card actually did.
    const rows = [
      row({ order_id: 'toronto', rate_cad: 36.43, ship_weekday: 2 }),
      row({ order_id: 'rural',   rate_cad: 200.00, ship_weekday: 2 }),
      row({ order_id: 'toronto', rate_cad: 40.00, ship_weekday: 4 }),
      row({ order_id: 'rural',   rate_cad: 120.00, ship_weekday: 4 }),
    ];
    expect(averageByWeekday(rows)[0].day).toBe(4);
  });

  it('ignores null rates instead of counting them as zero', () => {
    const rows = [
      row({ order_id: 'a', rate_cad: 100, ship_weekday: 3 }),
      row({ order_id: 'b', rate_cad: null, ship_weekday: 3 }),
    ];
    expect(averageByWeekday(rows)).toEqual([{ day: 3, avg: 100, n: 1 }]);
  });
});

describe('bestRatePerOrder', () => {
  it('takes each order its cheapest day, and lists the dearest order first', () => {
    const rows = [
      row({ order_id: 'a', order_ref: '#1185', rate_cad: 180.27, ship_weekday: 1 }),
      row({ order_id: 'a', order_ref: '#1185', rate_cad: 167.87, ship_weekday: 4, ship_date: '2026-09-24' }),
      row({ order_id: 'b', order_ref: '#1220', rate_cad: 59.98,  ship_weekday: 2 }),
    ];
    const out = bestRatePerOrder(rows);
    expect(out.map(o => o.order_ref)).toEqual(['#1185', '#1220']);
    expect(out[0].rate).toBe(167.87);
    expect(out[0].weekday).toBe(4);
    expect(out[0].postal).toBe('94526 US');
  });

  it('flags on the best achievable rate, so an expensive Friday alone is not a flag', () => {
    const rows = [
      row({ order_id: 'a', rate_cad: 210, ship_weekday: 5 }),   // dear on Friday
      row({ order_id: 'a', rate_cad: 140, ship_weekday: 2 }),   // fine on Tuesday
    ];
    const best = bestRatePerOrder(rows)[0];
    expect(best.rate).toBe(140);
    expect(flagFor(best.rate)).toBe('none');
  });
});

describe('driftSince', () => {
  it('compares each order first run against latest, largest move first', () => {
    const rows = [
      row({ order_id: 'a', order_ref: '#1185', rate_cad: 169.24, run_index: 1 }),
      row({ order_id: 'a', order_ref: '#1185', rate_cad: 180.27, run_index: 4 }),
      row({ order_id: 'b', order_ref: '#1220', rate_cad: 100.00, run_index: 1 }),
      row({ order_id: 'b', order_ref: '#1220', rate_cad: 101.00, run_index: 4 }),
    ];
    const out = driftSince(rows, 1, 4);
    expect(out).toHaveLength(2);
    // The real observed move: $169.24 -> $180.27 is +6.5%.
    expect(out[0].order_ref).toBe('#1185');
    expect(out[0].pct).toBeCloseTo(6.517, 2);
    expect(out[1].pct).toBeCloseTo(1.0, 5);
  });

  it('returns nothing when there is only one run to compare', () => {
    expect(driftSince([row({ order_id: 'a', rate_cad: 100 })], 1, 1)).toEqual([]);
  });

  it('skips an order that is missing from either run rather than inventing a change', () => {
    const rows = [
      row({ order_id: 'a', rate_cad: 100, run_index: 1 }),
      row({ order_id: 'b', rate_cad: 100, run_index: 4 }),
    ];
    expect(driftSince(rows, 1, 4)).toEqual([]);
  });

  it('uses each run cheapest, not whichever row came first', () => {
    const rows = [
      row({ order_id: 'a', rate_cad: 200, run_index: 1 }),
      row({ order_id: 'a', rate_cad: 100, run_index: 1, ship_date: '2026-09-24' }),
      row({ order_id: 'a', rate_cad: 150, run_index: 2 }),
      row({ order_id: 'a', rate_cad: 110, run_index: 2, ship_date: '2026-09-25' }),
    ];
    const [d] = driftSince(rows, 1, 2);
    expect([d.first, d.last]).toEqual([100, 110]);
  });
});

describe('isCalifornia', () => {
  it('covers the confirmed California orders and the range edges', () => {
    expect(isCalifornia({ dest_country: 'US', dest_postal: '94526' })).toBe(true); // James Soto
    expect(isCalifornia({ dest_country: 'US', dest_postal: '95148' })).toBe(true); // San Jose
    expect(isCalifornia({ dest_country: 'US', dest_postal: '91702' })).toBe(true); // Azusa
    expect(isCalifornia({ dest_country: 'US', dest_postal: '91302' })).toBe(true); // Calabasas
    expect(isCalifornia({ dest_country: 'US', dest_postal: '90001' })).toBe(true);
    expect(isCalifornia({ dest_country: 'US', dest_postal: '96162' })).toBe(true);
  });

  it('excludes neighbours just outside the range and every Canadian postal', () => {
    expect(isCalifornia({ dest_country: 'US', dest_postal: '89999' })).toBe(false);
    expect(isCalifornia({ dest_country: 'US', dest_postal: '96163' })).toBe(false);
    expect(isCalifornia({ dest_country: 'US', dest_postal: '17901' })).toBe(false);
    // A Canadian code can begin with digits-looking characters; country decides.
    expect(isCalifornia({ dest_country: 'CA', dest_postal: 'M1N1H9' })).toBe(false);
    expect(isCalifornia({ dest_country: 'CA', dest_postal: '94526' })).toBe(false);
  });
});

describe('formatting', () => {
  it('renders money and signed percentages the way the email reads them', () => {
    expect(money(36.4)).toBe('$36.40');
    expect(signed(6.517)).toBe('+6.5');
    expect(signed(-2.25)).toBe('-2.3');
    expect(pctBelow(120, 150)).toBe('20.0%');
  });

  it('does not divide by zero when every rate is zero', () => {
    expect(pctBelow(0, 0)).toBe('0.0%');
  });
});
