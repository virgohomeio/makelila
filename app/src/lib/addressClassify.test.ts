import { describe, it, expect } from 'vitest';
import {
  normalizePostal,
  parsePostalFromText,
  comparePostal,
  isPremiseLevel,
  isUsableGranularity,
  guessDwellingFromText,
  dwellingFromValidation,
  dwellingFromModelLabel,
  unitStatusFromValidation,
  areaTypeFromPostal,
  needsFitConfirmation,
  dwellingProvenance,
  DWELLING_LABEL,
  DWELLING_NOTE,
  type AVResult,
} from './addressClassify';

// Helper: a minimal but realistic Address Validation result.
function av(over: Partial<AVResult> = {}): AVResult {
  return {
    verdict: { validationGranularity: 'PREMISE', addressComplete: true },
    address: { formattedAddress: '1 Test St', addressComponents: [], missingComponentTypes: [] },
    metadata: {},
    ...over,
  };
}

describe('normalizePostal', () => {
  it('reduces a ZIP+4 to the 5-digit prefix so it can be compared with what the customer typed', () => {
    // Every US row in prod has this shape: Google returns 17901-8740, the
    // customer typed 17901. Comparing raw would mismatch every US order.
    expect(normalizePostal('17901-8740', 'US')).toBe('17901');
    expect(normalizePostal('17901', 'US')).toBe('17901');
    expect(normalizePostal('06483-3612', 'US')).toBe('06483');
  });

  it('strips spacing from a Canadian postal code', () => {
    expect(normalizePostal('L4S 2R6', 'CA')).toBe('L4S2R6');
    expect(normalizePostal('l4s2r6', 'CA')).toBe('L4S2R6');
    expect(normalizePostal('L4S-2R6', 'CA')).toBe('L4S2R6');
  });

  it('returns null for a code that is not well-formed for its country', () => {
    expect(normalizePostal('99999 9X9', 'CA')).toBeNull();
    expect(normalizePostal('ABCDE', 'US')).toBeNull();
    expect(normalizePostal('', 'US')).toBeNull();
    expect(normalizePostal(null, 'CA')).toBeNull();
  });
});

describe('parsePostalFromText', () => {
  it('pulls a postal code out of a free-text street line', () => {
    // Older imported orders look like this: the whole address in address_line.
    expect(parsePostalFromText('7367 Kamwood Street, San Diego, CA, 92126, USA', 'US')).toBe('92126');
    expect(parsePostalFromText('53 Guy street, Wabush, NL A0R 1B0', 'CA')).toBe('A0R1B0');
  });

  it('returns null when there is nothing postal-shaped', () => {
    expect(parsePostalFromText('118 Holly Dr', 'US')).toBeNull();
    expect(parsePostalFromText(null, 'CA')).toBeNull();
  });
});

describe('comparePostal', () => {
  it('matches when both sides agree', () => {
    expect(comparePostal('L4S2R6', 'L4S2R6', 'PREMISE')).toBe('match');
  });

  it('mismatches only when both sides are readable and differ', () => {
    expect(comparePostal('17901', '17902', 'PREMISE')).toBe('mismatch');
  });

  it('never reports a mismatch when a side is missing', () => {
    // A mismatch flags the order and emails the customer. We only do that when
    // we actually know the code is wrong.
    expect(comparePostal(null, '17901', 'PREMISE')).toBe('unverifiable');
    expect(comparePostal('17901', null, 'PREMISE')).toBe('unverifiable');
  });

  it('never reports a mismatch when Google could not resolve the address', () => {
    expect(comparePostal('17901', '17902', 'OTHER')).toBe('unverifiable');
    expect(comparePostal('17901', '17902', undefined)).toBe('unverifiable');
  });

  it('still confirms the postal at street level, where the building is unknown', () => {
    // ROUTE is good enough to confirm a postal code but not to name a building.
    expect(comparePostal('17901', '17901', 'ROUTE')).toBe('match');
    expect(isUsableGranularity('ROUTE')).toBe(true);
    expect(isPremiseLevel('ROUTE')).toBe(false);
  });
});

describe('guessDwellingFromText — the pre-verification starting point', () => {
  it('reads the SECOND address line, where Shopify puts the unit number', () => {
    // Regression: all three of these are live orders that read "house ·
    // single-family · standard delivery" because the old heuristic only ever
    // looked at address1.
    expect(guessDwellingFromText('10350 W Bay Harbor Dr', '4N', '33154')).toBe('apt');
    expect(guessDwellingFromText('925 Bute St', '21', 'V6E 1Y7')).toBe('apt');
    expect(guessDwellingFromText('1401 Precon Dr', 'Suite 102', '23320')).toBe('apt');
    expect(guessDwellingFromText('304 Eighth Ave', 'B448', 'T0J 1N0')).toBe('apt');
  });

  it('still catches a unit written into the first line', () => {
    expect(guessDwellingFromText('55 Front St Apt 12', null, 'M5J 1E6')).toBe('apt');
    expect(guessDwellingFromText('55 Front St, Suite 900', '', 'M5J 1E6')).toBe('apt');
    expect(guessDwellingFromText('55 Front St #3', null, 'M5J 1E6')).toBe('apt');
  });

  it('treats a lone dash as the blank field Shopify means it to be', () => {
    // Live order #1049 has address2 = "-". That is not a unit number.
    expect(guessDwellingFromText('10202 Ruffian Ln', '-', '21811')).toBe('house');
    expect(guessDwellingFromText('10202 Ruffian Ln', '  ', '21811')).toBe('house');
  });

  it('does not call a spilled street name a unit', () => {
    // Live orders put the real street in address2 ("716 Old Sackville Rd",
    // "Grey Road 119", "Johnstone Lane") — a run of plain words, not a unit.
    expect(guessDwellingFromText('16', 'Johnstone Lane', 'E3C 0E3')).toBe('house');
    expect(guessDwellingFromText('629031', 'Grey Road 119', 'N0H 1J0')).toBe('house');
  });

  it('treats a bare mailbox line as mail, not as a unit', () => {
    // Live orders #1214 (Tisdale SK) and #1216 (Naramata BC) put a rural
    // mailbox in address2 alongside a real street address on line 1. That is
    // where the customer collects their MAIL; the freight still goes to the
    // street, and reading it as an apartment sends the operator chasing a unit
    // number that does not exist.
    expect(guessDwellingFromText('1405 98 St', 'Box 1282', 'S0E 1T0')).toBe('house');
    expect(guessDwellingFromText('465 Grimaldi Lane', 'Pb311', 'V0H 1N0')).toBe('house');
    expect(guessDwellingFromText('1 Main St', 'Bag 44', 'N0H 1J0')).toBe('house');
  });

  it('recognises a PO box in either line', () => {
    expect(guessDwellingFromText('PO Box 14', null, 'Y1A 0C4')).toBe('po_box');
    expect(guessDwellingFromText('1405 98 St', 'P.O. Box 1282', 'S0E 1T0')).toBe('po_box');
    expect(guessDwellingFromText('Postal Box 9', null, 'A0R 1B0')).toBe('po_box');
  });

  it('recognises a rural route', () => {
    expect(guessDwellingFromText('RR 3', null, 'N0H 1J0')).toBe('remote');
    expect(guessDwellingFromText('General Delivery', null, 'A0R 1B0')).toBe('remote');
  });

  it('honours the operator-maintained remote postal prefixes', () => {
    expect(guessDwellingFromText('1 Main St', null, 'X0A 0H0', ['X0A'])).toBe('remote');
  });

  it('falls back to house for a plain street address', () => {
    expect(guessDwellingFromText('118 Holly Dr', null, 'L4S 2R6')).toBe('house');
    expect(guessDwellingFromText('2797 Gumdrop Dr.', '', '95148')).toBe('house');
  });
});

describe('dwellingFromValidation — the verified answer', () => {
  it('reads the USPS record type, which states the building kind outright', () => {
    expect(dwellingFromValidation(av({ uspsData: { addressRecordType: 'H' } }))).toBe('apt');
    expect(dwellingFromValidation(av({ uspsData: { addressRecordType: 'P' } }))).toBe('po_box');
    expect(dwellingFromValidation(av({ uspsData: { addressRecordType: 'F' } }))).toBe('business');
    expect(dwellingFromValidation(av({ uspsData: { addressRecordType: 'R' } }))).toBe('remote');
    expect(dwellingFromValidation(av({ uspsData: { addressRecordType: 'S' } }))).toBe('house');
  });

  it('calls a mailbox store a business — it cannot take a pallet', () => {
    expect(dwellingFromValidation(av({ uspsData: { dpvCmra: 'Y' } }))).toBe('business');
  });

  it('uses SUB_PREMISE granularity where there is no USPS data (Canada)', () => {
    expect(dwellingFromValidation(av({
      verdict: { validationGranularity: 'SUB_PREMISE' },
    }))).toBe('apt');
  });

  it('uses a subpremise component where there is no USPS data', () => {
    expect(dwellingFromValidation(av({
      address: { addressComponents: [{ componentType: 'subpremise', componentName: { text: '21' } }] },
    }))).toBe('apt');
  });

  it('treats a subpremise Google says is MISSING as an apartment too', () => {
    // The building has units; this order just didn't name one.
    expect(dwellingFromValidation(av({
      address: { addressComponents: [], missingComponentTypes: ['subpremise'] },
    }))).toBe('apt');
  });

  it('uses Google metadata for business and PO box', () => {
    expect(dwellingFromValidation(av({ metadata: { business: true } }))).toBe('business');
    expect(dwellingFromValidation(av({ metadata: { poBox: true } }))).toBe('po_box');
  });

  it('prefers residential over business when Google reports both', () => {
    // A home business is still a house for delivery purposes.
    expect(dwellingFromValidation(av({ metadata: { business: true, residential: true } }))).toBe('house');
  });

  it('refuses to name a building when Google only resolved the street', () => {
    // This is the whole point: no evidence, no claim.
    expect(dwellingFromValidation(av({ verdict: { validationGranularity: 'ROUTE' } }))).toBeNull();
    expect(dwellingFromValidation(av({ verdict: { validationGranularity: 'OTHER' } }))).toBeNull();
    expect(dwellingFromValidation(av({ verdict: {} }))).toBeNull();
    expect(dwellingFromValidation(null)).toBeNull();
    expect(dwellingFromValidation(undefined)).toBeNull();
  });

  it('still reads USPS data at street granularity, since USPS states it directly', () => {
    expect(dwellingFromValidation(av({
      verdict: { validationGranularity: 'ROUTE' },
      uspsData: { addressRecordType: 'H' },
    }))).toBe('apt');
  });
});

describe('unitStatusFromValidation — the missing-unit trap', () => {
  it('flags dpvConfirmation D: street confirmed, unit missing', () => {
    // The expensive case. A freight driver with no unit number leaves the
    // pallet in a lobby or takes it back to the terminal.
    expect(unitStatusFromValidation(av({ uspsData: { dpvConfirmation: 'D' } }), null)).toBe('missing');
    expect(unitStatusFromValidation(av({ uspsData: { dpvConfirmation: 'D' } }), '4N')).toBe('missing');
  });

  it('flags a unit USPS does not recognise at that address', () => {
    expect(unitStatusFromValidation(av({ uspsData: { dpvConfirmation: 'S' } }), '4N')).toBe('unrecognized');
  });

  it('flags a missing subpremise outside the US', () => {
    expect(unitStatusFromValidation(av({
      address: { missingComponentTypes: ['subpremise'] },
    }), null)).toBe('missing');
  });

  it('is satisfied when the building has units and the order names one', () => {
    expect(unitStatusFromValidation(av({
      verdict: { validationGranularity: 'SUB_PREMISE' },
    }), '21')).toBe('ok');
  });

  it('flags an apartment where the order names no unit', () => {
    expect(unitStatusFromValidation(av({
      verdict: { validationGranularity: 'SUB_PREMISE' },
    }), null)).toBe('missing');
    expect(unitStatusFromValidation(av({
      verdict: { validationGranularity: 'SUB_PREMISE' },
    }), ' - ')).toBe('missing');
  });

  it('says no unit is needed for a confirmed single-delivery address', () => {
    expect(unitStatusFromValidation(av({
      uspsData: { dpvConfirmation: 'Y', addressRecordType: 'S' },
    }), null)).toBe('not_required');
  });

  it('admits it does not know when there is no evidence', () => {
    expect(unitStatusFromValidation(av({ verdict: { validationGranularity: 'ROUTE' } }), null)).toBe('unknown');
    expect(unitStatusFromValidation(null, '4N')).toBe('unknown');
  });
});

describe('areaTypeFromPostal', () => {
  it('reads rural out of a Canadian FSA', () => {
    expect(areaTypeFromPostal('N0H 1J0', 'CA')).toBe('rural');
    expect(areaTypeFromPostal('A0R 1B0', 'CA')).toBe('rural');
    expect(areaTypeFromPostal('T0J1N0', 'CA')).toBe('rural');
  });

  it('honours the operator-maintained remote prefixes', () => {
    expect(areaTypeFromPostal('X0A 0H0', 'CA', ['X0A'])).toBe('rural');
    expect(areaTypeFromPostal('99723', 'US', ['997'])).toBe('rural');
  });

  it('returns null rather than defaulting to suburban', () => {
    // The bug this replaces: a `return 'suburban'` catch-all filed downtown
    // Vancouver (V6E) and a Bay Harbor Islands condo tower as suburban, with
    // an "auto" provenance indistinguishable from a real classification.
    expect(areaTypeFromPostal('V6E 1Y7', 'CA')).toBeNull();
    expect(areaTypeFromPostal('L4S 2R6', 'CA')).toBeNull();
    expect(areaTypeFromPostal('33154', 'US')).toBeNull();
    expect(areaTypeFromPostal('90272', 'US')).toBeNull();
    expect(areaTypeFromPostal(null, 'US')).toBeNull();
    expect(areaTypeFromPostal('', 'CA')).toBeNull();
  });
});

describe('operator-facing copy', () => {
  it('gives every dwelling type a label and a delivery consequence', () => {
    for (const d of Object.keys(DWELLING_LABEL) as Array<keyof typeof DWELLING_LABEL>) {
      expect(DWELLING_LABEL[d].length).toBeGreaterThan(0);
      expect(DWELLING_NOTE[d].length).toBeGreaterThan(0);
    }
  });

  it('requires a fit confirmation for everything except a house', () => {
    expect(needsFitConfirmation('house')).toBe(false);
    expect(needsFitConfirmation('apt')).toBe(true);
    expect(needsFitConfirmation('condo')).toBe(true);
    expect(needsFitConfirmation('remote')).toBe(true);
    expect(needsFitConfirmation('business')).toBe(true);
    expect(needsFitConfirmation('po_box')).toBe(true);
  });

  it('says plainly when a verdict is only a guess', () => {
    expect(dwellingProvenance('sync-guess', null)).toMatch(/unconfirmed/i);
    expect(dwellingProvenance('sync-guess', '2026-09-10T15:14:35Z')).toMatch(/unconfirmed/i);
    expect(dwellingProvenance('google', '2026-09-10T15:14:35Z')).toMatch(/confirmed by address verification/i);
    expect(dwellingProvenance('manual', null)).toMatch(/operator/i);
  });

  // A model reading is neither a record nor a regex, and must not read as
  // either — it is the only building signal a Canadian address ever gets.
  it('distinguishes a model reading from a postal-authority record', () => {
    const model = dwellingProvenance('model', '2026-09-10T15:14:35Z');
    expect(model).toMatch(/classifier/i);
    expect(model).toMatch(/no postal-authority record/i);
    expect(model).not.toMatch(/unconfirmed/i);
    expect(model).not.toMatch(/confirmed by address verification/i);
  });
});

describe('dwellingFromModelLabel', () => {
  it('maps the labels the prompt asks for onto our own vocabulary', () => {
    expect(dwellingFromModelLabel('house')).toBe('house');
    expect(dwellingFromModelLabel('apartment')).toBe('apt');
    expect(dwellingFromModelLabel('condo')).toBe('condo');
    expect(dwellingFromModelLabel('business')).toBe('business');
    expect(dwellingFromModelLabel('po_box')).toBe('po_box');
  });

  it('accepts the near-misses a model reaches for', () => {
    expect(dwellingFromModelLabel('Apartment Building')).toBe('apt');
    expect(dwellingFromModelLabel('single-family')).toBe('house');
    expect(dwellingFromModelLabel('  CONDOMINIUM ')).toBe('condo');
    expect(dwellingFromModelLabel('rural route')).toBe('remote');
  });

  // A reply we cannot read must leave the verdict where it was, not move it.
  it('returns null for unknown, empty or unrecognised answers', () => {
    expect(dwellingFromModelLabel('unknown')).toBeNull();
    expect(dwellingFromModelLabel('')).toBeNull();
    expect(dwellingFromModelLabel(null)).toBeNull();
    expect(dwellingFromModelLabel('houseboat')).toBeNull();
  });
});
