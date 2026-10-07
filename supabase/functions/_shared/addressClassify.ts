// Turning a Google Address Validation response into the three claims the
// Order Review address card makes to an operator:
//
//   1. does the postal code the customer typed match the real one,
//   2. what kind of building are we shipping to (house / apartment / condo /
//      business / PO box / remote), and
//   3. is the delivery area urban, suburban or rural.
//
// The rule this file exists to enforce: NEVER ASSERT A CLAIM WE DIDN'T GET
// EVIDENCE FOR. Before this module the dwelling type was a regex over the
// street line run once at Shopify-sync time, and the area type was a literal
// `return 'suburban'` fallthrough — so 280 of 287 orders read "HOUSE ·
// single-family · standard delivery" and ~200 read "Suburban" whether or not
// anyone had ever looked. An operator can't act on a field that says the same
// thing for every order. Every function here returns a `source` alongside its
// answer, and returns null/'unconfirmed' rather than guessing.
//
// MIRROR LOCATION: app/src/lib/addressClassify.ts (kept byte-identical;
// app/scripts/check-classifier-drift.mjs enforces).
//
// Zero imports — pure TS — so Deno (the verify-address and sync-shopify-orders
// edge functions) and Node (Vitest) consume the same file, and the wording an
// operator reads is the wording the tests assert.

// ── Types ───────────────────────────────────────────────────────────────

/** What we're delivering to. Widened past the original house/apt/remote/condo
 *  because USPS distinguishes a firm and a PO box from a dwelling, and both
 *  change how a pallet-sized composter gets delivered. */
export type Dwelling = 'house' | 'apt' | 'condo' | 'remote' | 'business' | 'po_box';

/** Where a dwelling verdict came from, weakest first:
 *
 *    'sync-guess' — a text match on the address the customer typed, checked
 *        against nothing. The card must not present it as confirmed.
 *    'model'      — the model that classifies the area type also read the
 *        address and named the building. Evidence, but not a record: a
 *        judgement about a place rather than a postal authority's file on it.
 *        It exists because uspsData is US-only, so a Canadian house or
 *        apartment could never be confirmed at all — and most orders are
 *        Canadian.
 *    'google'     — Google/USPS resolved the actual premise and said what is
 *        on it. The only source that is a record rather than a reading.
 *    'manual'     — an operator set it, which beats all of the above: they have
 *        spoken to the customer, we have parsed a string. */
export type DwellingSource = 'sync-guess' | 'model' | 'google' | 'manual';

export type AreaType = 'urban' | 'suburban' | 'rural';

/** Whether a required apartment/unit number is actually on the order.
 *  'missing' is the expensive one: the street exists and is a multi-unit
 *  building, but no unit was supplied, so the carrier has nowhere to leave a
 *  freight delivery. */
export type UnitStatus = 'ok' | 'missing' | 'unrecognized' | 'not_required' | 'unknown';

export type PostalMatch = 'match' | 'mismatch' | 'unverifiable';

// The subset of Google's Address Validation response this module reads. Every
// field is optional: the API omits `uspsData` outside the US entirely, and
// omits individual USPS fields for addresses it can't fully resolve.
// https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress
export type AVAddressComponent = {
  componentName?: { text?: string };
  componentType?: string;
  confirmationLevel?: string;
};

export type AVResult = {
  verdict?: {
    inputGranularity?: string;
    validationGranularity?: string;
    addressComplete?: boolean;
    hasUnconfirmedComponents?: boolean;
    hasInferredComponents?: boolean;
    hasReplacedComponents?: boolean;
  };
  address?: {
    formattedAddress?: string;
    postalAddress?: { postalCode?: string };
    addressComponents?: AVAddressComponent[];
    missingComponentTypes?: string[];
    unconfirmedComponentTypes?: string[];
  };
  metadata?: {
    business?: boolean;
    poBox?: boolean;
    residential?: boolean;
  };
  uspsData?: {
    dpvConfirmation?: string;
    dpvCmra?: string;
    dpvVacant?: string;
    // F=Firm, G=General Delivery, H=High-rise/apartment, P=PO Box,
    // R=Rural Route, S=Street. The single most direct dwelling signal we get.
    addressRecordType?: string;
    carrierRoute?: string;
  };
};

export type AVResponse = { result?: AVResult };

// ── Postal normalisation ────────────────────────────────────────────────

/** Reduce a postal code to the form the two sides can actually be compared in.
 *  US: the 5-digit prefix, because Google returns ZIP+4 ("17901-8740") and the
 *  customer types five digits — comparing raw would report a mismatch on every
 *  single US order. CA: the 6 characters, space-insensitive. Returns null when
 *  the value isn't a well-formed code for the country, so a malformed postal
 *  degrades to 'unverifiable' rather than to a false mismatch. */
export function normalizePostal(p: string | null | undefined, country: string): string | null {
  if (!p) return null;
  const s = p.replace(/[\s-]/g, '').toUpperCase();
  if (country === 'US') {
    const m = s.match(/^(\d{5})\d{0,4}$/);
    return m ? m[1] : null;
  }
  if (country === 'CA') {
    return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(s) ? s : null;
  }
  return s || null;
}

/** Last-resort postal extraction for orders synced before we captured
 *  shipping_address.zip into its own column — the code is often sitting in the
 *  free-text street line. */
export function parsePostalFromText(addressLine: string | null | undefined, country: string): string | null {
  if (!addressLine) return null;
  if (country === 'US') {
    const m = addressLine.match(/\b(\d{5})(-\d{4})?\b/);
    return m ? m[1] : null;
  }
  if (country === 'CA') {
    const m = addressLine.match(/\b([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)\b/);
    return m ? (m[1] + m[2]).toUpperCase() : null;
  }
  return null;
}

/** Granularities that mean Google couldn't pin the address to a real place.
 *  ROUTE/BLOCK resolve only to a street or a city block — good enough to
 *  confirm the postal code, not good enough to assert what building it is. */
export function isUsableGranularity(g: string | null | undefined): boolean {
  return g === 'PREMISE' || g === 'SUB_PREMISE' || g === 'PREMISE_PROXIMITY'
      || g === 'ROUTE' || g === 'BLOCK';
}

/** Granularities precise enough to say what *kind of building* this is.
 *  A ROUTE-level hit tells us the street is real and nothing more. */
export function isPremiseLevel(g: string | null | undefined): boolean {
  return g === 'PREMISE' || g === 'SUB_PREMISE' || g === 'PREMISE_PROXIMITY';
}

/** Compare what the customer typed against what the postal authority returned.
 *  Either side being unreadable yields 'unverifiable' — never a mismatch,
 *  because a mismatch flags the order and emails the customer, and we should
 *  only do that when we actually know the code is wrong. */
export function comparePostal(
  customerPostal: string | null,
  validatedPostal: string | null,
  granularity: string | null | undefined,
): PostalMatch {
  if (!isUsableGranularity(granularity)) return 'unverifiable';
  if (!customerPostal || !validatedPostal) return 'unverifiable';
  return customerPostal === validatedPostal ? 'match' : 'mismatch';
}

// ── Dwelling type ───────────────────────────────────────────────────────

const UNIT_WORD = /\b(?:apt|apartment|unit|suite|ste|#\s*[\dA-Za-z]|bldg|building|floor|fl|rm|room|penthouse|ph)\b|#\s*[\dA-Za-z]/i;
const PO_BOX_WORD = /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box|postal\s+box|boite\s+postale|c\.?\s*p\.?\s*\d)\b/i;
const RURAL_WORD = /\b(?:rr|r\.r\.|rural\s+route|hc|highway\s+contract|general\s+delivery|gen\s+del|concession|conc|sideroad|side\s+rd)\s*\.?\s*\d*\b/i;
// A street-type word in the second line means the customer split one street
// address across both fields ("16" / "Johnstone Lane", "629031" / "Grey Road
// 119") rather than naming a unit. Several live orders are shaped this way.
const STREET_WORD = /\b(?:st|street|rd|road|ave|av|avenue|dr|drive|ln|lane|blvd|boulevard|cres|crescent|way|ct|court|trl|trail|hwy|highway|pl|place|terr|terrace|cir|circle|pkwy|parkway|route|rue|chemin)\b\.?/i;
// A second line that is only a mailbox number — "Box 1282" in Tisdale SK,
// "Pb311" in Naramata BC — is where the customer collects their MAIL. It is
// not a unit within a building, and freight still goes to the street address on
// line 1. Without this both read as apartments.
const MAILBOX_ONLY = /^(?:p\.?\s*o\.?\s*)?(?:box|bag|pb|p\.b\.)\s*#?\s*\d+[a-z]?$/i;

/** The pre-verification guess, from the text the customer typed and nothing
 *  else. Reads BOTH address lines: Shopify puts "Apt 4N" in address2, and the
 *  original heuristic only looked at address1 — which is why 14 orders with a
 *  unit number sitting in address2 (a 4th-floor unit in a Bay Harbor Islands
 *  tower, #21 on Bute St in downtown Vancouver, "Suite 102" in Chesapeake) all
 *  read "house · standard delivery".
 *
 *  Always pair with source 'sync-guess'. It is a starting point for the
 *  operator, not a verdict. */
export function guessDwellingFromText(
  addressLine: string | null | undefined,
  addressLine2: string | null | undefined,
  postalCode: string | null | undefined,
  remotePrefixes: string[] = [],
): Dwelling {
  const line1 = (addressLine ?? '').trim();
  // A lone '-' or '.' is Shopify's "customer left this blank" filler, not a unit.
  const line2 = (addressLine2 ?? '').trim().replace(/^[-.\s]+$/, '');
  const both = `${line1} ${line2}`.trim();

  if (PO_BOX_WORD.test(both)) return 'po_box';

  if (postalCode) {
    const p = postalCode.toUpperCase().replace(/\s/g, '');
    if (remotePrefixes.some(prefix => prefix && p.startsWith(prefix))) return 'remote';
  }
  if (RURAL_WORD.test(both)) return 'remote';

  // A non-empty second line is nearly always a unit designator, even when it
  // carries no keyword ("4N", "21", "B448") — unless it reads as a street name,
  // which means the customer split one address across the two fields.
  const line2IsStreet = STREET_WORD.test(line2) && !UNIT_WORD.test(line2);
  const line2IsMailbox = MAILBOX_ONLY.test(line2);
  if (line2.length > 0 && !line2IsStreet && !line2IsMailbox) return 'apt';
  if (UNIT_WORD.test(line1)) return 'apt';
  return 'house';
}

/** The post-verification dwelling type, from what Google and USPS actually
 *  said. Returns null when the response carries no usable evidence — the
 *  caller must then keep the existing verdict and leave its source at
 *  'sync-guess' rather than laundering a guess into a confirmation. */
export function dwellingFromValidation(result: AVResult | null | undefined): Dwelling | null {
  if (!result) return null;
  const granularity = result.verdict?.validationGranularity;
  const usps = result.uspsData ?? {};
  const meta = result.metadata ?? {};

  // USPS record type is the most direct statement available, and it is
  // authoritative where it exists (US only).
  switch (usps.addressRecordType) {
    case 'P': return 'po_box';
    case 'H': return 'apt';   // high-rise / multi-unit building
    case 'F': return 'business';
    case 'R': return 'remote'; // rural route / highway contract
    case 'G': return 'po_box'; // general delivery — collected at a post office
  }

  // A CMRA is a mailbox store (UPS Store and friends): a commercial counter,
  // not a dwelling, and it cannot receive a pallet.
  if (usps.dpvCmra === 'Y') return 'business';

  if (meta.poBox === true) return 'po_box';

  // Outside the US there's no uspsData, so fall back to Google's own metadata
  // and the shape of the resolved address. Only trust these at premise level —
  // a ROUTE-level hit says the street exists, not what stands on it.
  if (!isPremiseLevel(granularity)) return null;

  if (meta.business === true && meta.residential !== true) return 'business';

  const hasSubpremise = (result.address?.addressComponents ?? [])
    .some(c => c.componentType === 'subpremise');
  const wantsSubpremise = (result.address?.missingComponentTypes ?? []).includes('subpremise');
  if (granularity === 'SUB_PREMISE' || hasSubpremise || wantsSubpremise) return 'apt';

  if (meta.residential === true) return 'house';

  // Premise-level, residential flag absent, no unit anywhere: a standalone
  // building. Google resolved it to a premise, so this is evidence, not a
  // default.
  return 'house';
}

/** The building type a model named, mapped onto our own vocabulary. Anything
 *  unrecognised — including the model's own "unknown" — returns null, so a
 *  reply we cannot read leaves the verdict where it was instead of moving it.
 *
 *  Pair with source 'model'. Google's own evidence outranks this wherever it
 *  exists; this fills the gap outside the US, where there is no USPS record
 *  type and a premise-level hit alone cannot tell a house from a walk-up. */
export function dwellingFromModelLabel(label: string | null | undefined): Dwelling | null {
  const norm = (label ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!norm) return null;

  // "unknown" is an answer, and the answer is "leave the verdict alone". It has
  // to be caught before the substring pass, or "unknown residential building"
  // would read as a house.
  if (norm === 'unknown' || norm === 'unclear' || norm === 'n_a' || norm === 'null') return null;

  switch (norm) {
    case 'house':
    case 'detached':
    case 'townhouse':
    case 'single_family':      return 'house';
    case 'apt':
    case 'apartment':
    case 'apartment_building':
    case 'multi_unit':         return 'apt';
    case 'condo':
    case 'condominium':        return 'condo';
    case 'business':
    case 'commercial':
    case 'office':             return 'business';
    case 'po_box':
    case 'pobox':              return 'po_box';
    case 'remote':
    case 'rural_route':
    case 'farm':               return 'remote';
  }

  // A model asked for one of six words routinely answers with a phrase —
  // "single family home", "low-rise apartment building", "commercial/retail".
  // Refusing those left the verdict at the sync-time regex, which is the exact
  // failure this function exists to end, so a phrase is read for the word it
  // contains. Order matters: 'condo' before the house words, because
  // "condominium townhouse" is a condo.
  if (/po_?box|post_office_box|postal_box/.test(norm))                 return 'po_box';
  if (/condo/.test(norm))                                              return 'condo';
  if (/apart|multi_?unit|multi_?family|high_?rise|low_?rise|walk_?up|duplex|triplex|flat/.test(norm)) return 'apt';
  if (/business|commercial|office|retail|industrial|warehouse|firm|store/.test(norm)) return 'business';
  if (/rural|farm|remote|acreage|ranch|homestead/.test(norm))           return 'remote';
  if (/house|home|detached|townhouse|town_home|bungalow|cottage|residential|single_?family/.test(norm)) return 'house';

  return null;
}

/** Is the apartment/unit number we need actually on the order?
 *
 *  'missing' is the case worth building this for. USPS dpvConfirmation 'D'
 *  means the street address is confirmed but its *secondary* (unit) is
 *  missing — i.e. this is a multi-unit building and nobody told us which unit.
 *  Outside the US the same fact arrives as 'subpremise' in
 *  missingComponentTypes. A composter ships freight; a driver with no unit
 *  number leaves it in a lobby or takes it back to the terminal. */
export function unitStatusFromValidation(
  result: AVResult | null | undefined,
  addressLine2: string | null | undefined,
): UnitStatus {
  if (!result) return 'unknown';
  const usps = result.uspsData ?? {};
  const line2 = (addressLine2 ?? '').trim().replace(/^[-.\s]+$/, '');
  const missingTypes = result.address?.missingComponentTypes ?? [];

  if (usps.dpvConfirmation === 'D') return 'missing';
  if (usps.dpvConfirmation === 'S') return 'unrecognized';
  if (missingTypes.includes('subpremise')) return 'missing';

  const dwelling = dwellingFromValidation(result);
  if (dwelling === 'apt') return line2.length > 0 ? 'ok' : 'missing';

  if (usps.dpvConfirmation === 'Y') return 'not_required';
  if (dwelling === 'house' || dwelling === 'po_box') return 'not_required';
  return 'unknown';
}

// ── Area type ───────────────────────────────────────────────────────────

/** The only area-type call a postal code alone supports: Canada Post encodes
 *  rural in the FSA's second character ('0'), and an operator-maintained list
 *  of remote prefixes covers the rest.
 *
 *  Everything else returns NULL ON PURPOSE. Urban and suburban cannot be told
 *  apart from a postal code, and the previous implementation's `return
 *  'suburban'` catch-all is why downtown Vancouver (V6E) and a Bay Harbor
 *  Islands condo tower were both filed as suburban with an "auto" provenance
 *  that read identically to a real classification. Unclassified is a useful
 *  state; a confident wrong answer is not. */
export function areaTypeFromPostal(
  postalCode: string | null | undefined,
  country: string,
  remotePrefixes: string[] = [],
): AreaType | null {
  const p = (postalCode ?? '').toUpperCase().replace(/\s/g, '');
  if (!p) return null;
  if (remotePrefixes.some(prefix => prefix && p.startsWith(prefix))) return 'rural';
  if (country === 'CA' && /^[A-Z]0/.test(p)) return 'rural';
  return null;
}

// ── Operator-facing copy ────────────────────────────────────────────────
// Kept here so the card and the tests read the same strings.

export const DWELLING_LABEL: Record<Dwelling, string> = {
  house:    'House',
  apt:      'Apartment',
  condo:    'Condo',
  remote:   'Remote / rural route',
  business: 'Business',
  po_box:   'PO Box',
};

export const DWELLING_NOTE: Record<Dwelling, string> = {
  house:    'Single-family · standard delivery',
  apt:      'Multi-unit building · delivery needs a unit number and may need coordination',
  condo:    'Condo · concierge / loading-dock booking likely',
  remote:   'Remote or rural route · freight surcharge likely',
  business: 'Commercial address · check receiving hours before booking freight',
  po_box:   'PO Box · cannot receive freight, a street address is required',
};

/** Dwelling types that need a human to confirm the unit actually fits before
 *  the order ships. 'house' is the only one that never does. */
export function needsFitConfirmation(d: Dwelling): boolean {
  return d !== 'house';
}

export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  ok:           'Unit number on file',
  missing:      'No unit number — multi-unit building',
  unrecognized: 'Unit number not recognised at this address',
  not_required: 'No unit number needed',
  unknown:      'Unit requirement unknown',
};

/** One sentence saying exactly where a claim came from, so an operator can
 *  tell a checked fact from a starting guess at a glance. */
export function dwellingProvenance(source: DwellingSource, verifiedAt: string | null): string {
  if (source === 'manual') return 'set by an operator';
  if (source === 'google') {
    return verifiedAt
      ? `confirmed by address verification ${new Date(verifiedAt).toLocaleDateString()}`
      : 'confirmed by address verification';
  }
  if (source === 'model') {
    const when = verifiedAt ? ` ${new Date(verifiedAt).toLocaleDateString()}` : '';
    return `read from the address by the classifier${when} — no postal-authority record for this building`;
  }
  return 'unconfirmed — guessed from the address text, not yet verified';
}
