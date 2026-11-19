import { describe, it, expect } from 'vitest';

// `public.parts.id` is a TEXT primary key holding human-readable codes
// ('P-LID-V36', 'C-STARTER'), not a uuid — see 20260420340000_parts_module.sql.
// Most other tables in this schema do use uuid PKs, and
// 20260604220000_decrement_part_on_hand.sql declared `p_part_id uuid` on that
// assumption. Nothing catches the mismatch at build time: PostgREST passes the
// JSON string straight through and Postgres fails the coercion at call time
// with `invalid input syntax for type uuid: "P-LID-V36"`, so every replacement
// order containing a part line item died at the decrement step — after the
// order row and ticket back-link had already been written, leaving an orphan.
// The unit tests could not see it either: they mock `supabase.rpc`, and a mock
// has no type system.
//
// The only place the parameter type and the column type meet is the SQL, so
// that is where this guard lives. Sources come through Vite's raw glob rather
// than node:fs so the test needs no @types/node in the app tsconfig.
const MIGRATION_SOURCES = import.meta.glob('../../../supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Timestamp-prefixed filenames sort lexicographically into apply order, so the
 *  last definition of an object is the one the live schema actually has. */
const migrations: Array<[string, string]> = Object.entries(MIGRATION_SOURCES)
  .map(([path, src]): [string, string] => [path.replace(/^.*\/migrations\//, ''), src])
  .sort(([a], [b]) => a.localeCompare(b));

/** The type of `public.parts.id` as most recently declared in a create table. */
function declaredPartsIdType(): string | null {
  let type: string | null = null;
  for (const [, src] of migrations) {
    const table = /create table (?:if not exists )?public\.parts\s*\(([\s\S]*?)\n\);/i.exec(src);
    if (!table) continue;
    const id = /^\s*id\s+([a-z ]+?)\s+primary key/im.exec(table[1]);
    if (id) type = id[1].trim().toLowerCase();
  }
  return type;
}

/** Every parameter named `p_part_id`, keyed by function name, latest wins. */
function partIdParamTypes(): Map<string, { type: string; file: string }> {
  const found = new Map<string, { type: string; file: string }>();
  const fnRe = /create or replace function public\.([a-z0-9_]+)\s*\(([^)]*)\)/gi;
  for (const [file, src] of migrations) {
    for (const m of src.matchAll(fnRe)) {
      const [, name, params] = m;
      const param = /\bp_part_id\s+([a-z ]+?)\s*(?:,|$|=|default)/i.exec(params);
      if (param) found.set(name, { type: param[1].trim().toLowerCase(), file });
    }
  }
  return found;
}

describe('parts RPC signatures match public.parts.id', () => {
  it('finds the migrations tree', () => {
    expect(migrations.length).toBeGreaterThan(200);
  });

  it('declares parts.id as text', () => {
    // If this ever legitimately becomes uuid, the RPCs below must change with it.
    expect(declaredPartsIdType()).toBe('text');
  });

  it('takes p_part_id as the same type as the column it filters on', () => {
    const columnType = declaredPartsIdType();
    const params = partIdParamTypes();
    expect(params.size, 'no p_part_id parameters found — did the regex drift?')
      .toBeGreaterThan(0);
    const mismatched = [...params.entries()]
      .filter(([, { type }]) => type !== columnType)
      .map(([name, { type, file }]) => `${name}(p_part_id ${type}) in ${file}`);
    expect(mismatched, `parts.id is ${columnType}`).toEqual([]);
  });
});
