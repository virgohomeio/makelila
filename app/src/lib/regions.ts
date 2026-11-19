/** Province/state names for the geographic profitability comparison.
 *
 *  The code→name lookup lives here and nowhere else. The outlines the map
 *  draws are a separate, generated module — see lib/regionShapes.ts.
 *
 *  Keys are the same `country-region` codes the customer_profitability view
 *  emits, so 'CA-CA' can never collide with California.
 */

export const CA_REGION_NAMES: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon',
};

export const US_REGION_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** Full name for a 'CA-ON' / 'US-CA' code. Falls back to the code itself so an
 *  unmapped region still renders as something a human can read. */
export function regionName(regionCode: string | null | undefined): string {
  if (!regionCode) return 'Unknown';
  const [country, region] = regionCode.split('-');
  if (!region) return regionCode;
  const table = country === 'CA' ? CA_REGION_NAMES : country === 'US' ? US_REGION_NAMES : null;
  return table?.[region] ?? regionCode;
}
