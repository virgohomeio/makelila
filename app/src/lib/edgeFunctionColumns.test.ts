import { describe, it, expect } from 'vitest';

// Edge functions run in Deno against the live schema and have no type checking
// against it, so a column that does not exist fails only at request time — as a
// PostgREST 42703, which `.single()` then surfaces as a plain "not found". That
// is exactly how `freightcom-quote`, `freightcom-book` and `book-return-label`
// came to select `orders.address_postal_code` (the column is
// `orders.postal_code`): every quote returned "Order not found", every return
// label returned "no postal code on file", and freight_quotes never received a
// single row. This guards the whole functions tree against the column names we
// know are wrong.
//
// Sources are pulled through Vite's raw glob rather than node:fs so the test
// needs no @types/node in the app tsconfig.
const FUNCTION_SOURCES = import.meta.glob('../../../supabase/functions/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Comments routinely name the retired columns to explain why they are wrong,
 *  so strip them before scanning for real references. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const files: Array<[string, string]> = Object.entries(FUNCTION_SOURCES)
  .map(([path, src]) => [path.replace(/^.*\/supabase\/functions\//, ''), stripComments(src)]);

// Columns that read as plausible but do not exist on public.orders. Extend this
// list whenever a schema rename retires a name that edge functions might reach
// for out of habit.
const NONEXISTENT_ORDER_COLUMNS = ['address_postal_code', 'address_zip'];

describe('edge functions reference real orders columns', () => {
  it('finds the functions tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const column of NONEXISTENT_ORDER_COLUMNS) {
    it(`never selects orders.${column}`, () => {
      const offenders = files.filter(([, src]) => src.includes(column)).map(([path]) => path);
      expect(offenders).toEqual([]);
    });
  }

  it('reads the columns the shipment email needs to find a recipient', () => {
    // send-fulfillment-email resolves the recipient from the order's own
    // customer_email and, when that is null, from the customer record
    // customer_id points at. Reading only the order column is the bug that
    // made Candace Chan's replacement (R-0023) unsendable: the order row had
    // no email and her customer record had one. A rename of either column
    // would silently restore that, as a PostgREST 42703 reported as "not
    // found".
    const found = files.find(([path]) => path === 'send-fulfillment-email/index.ts');
    expect(found, 'send-fulfillment-email/index.ts not found').toBeTruthy();
    const src = found![1];

    const orderSelect = src.match(/\.select\('([^']*customer_email[^']*)'\)/);
    expect(orderSelect, 'no orders select naming customer_email').toBeTruthy();
    for (const col of ['order_ref', 'customer_name', 'customer_email', 'customer_id']) {
      expect(orderSelect![1].split(/,\s*/), `orders select is missing ${col}`).toContain(col);
    }

    // The fallback read itself: the directory columns the recipient rule uses.
    const custSelect = src.match(/from\('customers'\)\s*\.select\('([^']*)'\)/);
    expect(custSelect, 'no customers select — the fallback address cannot be read').toBeTruthy();
    for (const col of ['full_name', 'email', 'primary_user_email']) {
      expect(custSelect![1].split(/,\s*/), `customers select is missing ${col}`).toContain(col);
    }
  });

  it('reads the address and contact columns Freightcom needs when quoting and booking', () => {
    // customer_email joined this select on 2026-08-13: Freightcom refuses to
    // rate an international shipment without an email address at each end, so a
    // rename of that column would silently break every US order again.
    //
    // Asserted one column at a time rather than as one exact literal:
    // freightcom-quote reads four more of them (line_items, address_match,
    // address_google_postal, address_verified_at) to decide how many boxes to
    // rate and which postal code to rate against, and pinning the whole select
    // string made adding a column look like a regression.
    const REQUIRED: Record<string, string[]> = {
      'freightcom-quote/index.ts': [
        'id', 'postal_code', 'country', 'customer_email',
        'line_items', 'address_match', 'address_google_postal',
      ],
      'freightcom-book/index.ts':   ['id', 'postal_code', 'country', 'customer_email'],
      'book-return-label/index.ts': ['id', 'postal_code', 'country', 'customer_email'],
    };
    for (const [fn, columns] of Object.entries(REQUIRED)) {
      const found = files.find(([path]) => path === fn);
      expect(found, `${fn} not found`).toBeTruthy();
      const select = found![1].match(/\.select\('([^']*postal_code[^']*)'\)/);
      expect(select, `${fn} has no orders select`).toBeTruthy();
      const selected = select![1].split(/,\s*/);
      for (const col of columns) {
        expect(selected, `${fn} select is missing ${col}`).toContain(col);
      }
    }
  });
});
