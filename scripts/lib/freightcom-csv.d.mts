// Type declarations for freightcom-csv.mjs.
//
// The parser is plain ESM so `node scripts/import-freightcom-tracking.mjs` runs
// against a checkout with no build step, matching the other importers in this
// directory. These declarations exist so the vitest suite in app/ typechecks it
// properly rather than importing it as `any`.

export type ShipmentStatus =
  | 'booked' | 'in_transit' | 'delivered' | 'exception' | 'missing' | 'cancelled';

export type ImportedRawPayload = {
  imported_from: string;
  transaction_no: string;
  ship_to_name: string | null;
  ship_from_name: string | null;
  direction: 'outbound' | 'return';
  ref: string | null;
  delivered_on: string | null;
  dashboard_status: string | null;
};

/** A row shaped for public.shipments. Optional keys are omitted, never null —
 *  the importer must not overwrite a stored value with a blank. */
export type ImportedShipment = {
  freightcom_shipment_id: string;
  carrier: string;
  service: string;
  status: ShipmentStatus;
  primary_tracking_number: string | null;
  raw_payload: ImportedRawPayload;
  freightcom_status?: string;
  booked_at?: string;
  delivered_at?: string;
  billed_amount?: number;
  billed_currency?: string;
  billed_cad?: number;
};

export type HeaderMap = Partial<Record<
  'shipment_id' | 'tracking' | 'carrier' | 'service' | 'status' | 'ship_to'
  | 'ship_from' | 'reference' | 'delivered_on' | 'booked_on' | 'cost' | 'currency',
  number
>>;

export function parseCsv(text: string): string[][];
export function mapHeaders(headerRow: string[]): HeaderMap;
export function toIsoDate(v: unknown): string | null;
export function toAmount(v: unknown): number | null;
export function toCurrency(v: unknown, explicit?: unknown): string | null;
export function mapStatus(label: unknown): { status: ShipmentStatus; freightcom_status: string | null };
export function deriveDirection(shipFrom: unknown, shipTo: unknown): 'outbound' | 'return';
export function rowToShipment(record: string[], headers: HeaderMap): ImportedShipment | null;
export function parseExport(text: string): {
  rows: ImportedShipment[];
  headers: HeaderMap;
  skipped: number;
  missing: string[];
};
