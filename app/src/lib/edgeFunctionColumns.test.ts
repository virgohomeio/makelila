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

  it('reads the destination postal code from orders.postal_code when quoting and booking', () => {
    for (const fn of ['freightcom-quote/index.ts', 'freightcom-book/index.ts']) {
      const found = files.find(([path]) => path === fn);
      expect(found, `${fn} not found`).toBeTruthy();
      expect(found![1], fn).toMatch(/\.select\('id, postal_code, country'\)/);
    }
  });
});
