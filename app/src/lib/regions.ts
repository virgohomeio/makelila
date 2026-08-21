/** Province/state reference data for the geographic profitability comparison.
 *
 *  Two things live here and nowhere else: the code→name lookup, and the tile
 *  positions the map draws from. A tile grid rather than real geography — one
 *  square per province/state, placed roughly where it sits on the continent.
 *  Prince Edward Island and California get the same amount of ink, which is
 *  the point: the map is comparing profit per region, and a true choropleth
 *  would hide every small region behind a big one.
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

export type Tile = { code: string; row: number; col: number };

/** Canada, three rows, west to east. Rows 0-2 of a shared 11-column grid. */
const CA_TILES: Tile[] = [
                                        { code: 'CA-YT', row: 0, col: 1 },
  { code: 'CA-NT', row: 0, col: 2 },     { code: 'CA-NU', row: 0, col: 3 },
  { code: 'CA-BC', row: 1, col: 0 },     { code: 'CA-AB', row: 1, col: 1 },
  { code: 'CA-SK', row: 1, col: 2 },     { code: 'CA-MB', row: 1, col: 3 },
  { code: 'CA-ON', row: 1, col: 4 },     { code: 'CA-QC', row: 1, col: 5 },
  { code: 'CA-NL', row: 1, col: 7 },
  { code: 'CA-NB', row: 2, col: 5 },     { code: 'CA-NS', row: 2, col: 7 },
  { code: 'CA-PE', row: 2, col: 6 },
];

/** The conventional US state tile grid, shifted down to sit under Canada.
 *  Row 3 is left empty as the border. */
const US_TILES: Tile[] = [
  { code: 'US-AK', row: 4, col: 0 },  { code: 'US-ME', row: 4, col: 10 },
  { code: 'US-VT', row: 5, col: 9 },  { code: 'US-NH', row: 5, col: 10 },
  { code: 'US-WA', row: 6, col: 0 },  { code: 'US-ID', row: 6, col: 1 },
  { code: 'US-MT', row: 6, col: 2 },  { code: 'US-ND', row: 6, col: 3 },
  { code: 'US-MN', row: 6, col: 4 },  { code: 'US-IL', row: 6, col: 5 },
  { code: 'US-WI', row: 6, col: 6 },  { code: 'US-MI', row: 6, col: 7 },
  { code: 'US-NY', row: 6, col: 8 },  { code: 'US-RI', row: 6, col: 9 },
  { code: 'US-MA', row: 6, col: 10 },
  { code: 'US-OR', row: 7, col: 0 },  { code: 'US-NV', row: 7, col: 1 },
  { code: 'US-WY', row: 7, col: 2 },  { code: 'US-SD', row: 7, col: 3 },
  { code: 'US-IA', row: 7, col: 4 },  { code: 'US-IN', row: 7, col: 5 },
  { code: 'US-OH', row: 7, col: 6 },  { code: 'US-PA', row: 7, col: 7 },
  { code: 'US-NJ', row: 7, col: 8 },  { code: 'US-CT', row: 7, col: 9 },
  { code: 'US-CA', row: 8, col: 0 },  { code: 'US-UT', row: 8, col: 1 },
  { code: 'US-CO', row: 8, col: 2 },  { code: 'US-NE', row: 8, col: 3 },
  { code: 'US-MO', row: 8, col: 4 },  { code: 'US-KY', row: 8, col: 5 },
  { code: 'US-WV', row: 8, col: 6 },  { code: 'US-VA', row: 8, col: 7 },
  { code: 'US-MD', row: 8, col: 8 },  { code: 'US-DE', row: 8, col: 9 },
  { code: 'US-AZ', row: 9, col: 1 },  { code: 'US-NM', row: 9, col: 2 },
  { code: 'US-KS', row: 9, col: 3 },  { code: 'US-AR', row: 9, col: 4 },
  { code: 'US-TN', row: 9, col: 5 },  { code: 'US-NC', row: 9, col: 6 },
  { code: 'US-SC', row: 9, col: 7 },  { code: 'US-DC', row: 9, col: 8 },
  { code: 'US-OK', row: 10, col: 3 }, { code: 'US-LA', row: 10, col: 4 },
  { code: 'US-MS', row: 10, col: 5 }, { code: 'US-AL', row: 10, col: 6 },
  { code: 'US-GA', row: 10, col: 7 },
  { code: 'US-HI', row: 11, col: 0 }, { code: 'US-TX', row: 11, col: 3 },
  { code: 'US-FL', row: 11, col: 8 },
];

export const REGION_TILES: Tile[] = [...CA_TILES, ...US_TILES];

export const TILE_GRID_COLS = 11;
export const TILE_GRID_ROWS = 12;
