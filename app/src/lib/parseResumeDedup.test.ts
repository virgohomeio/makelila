import { describe, it, expect } from 'vitest';

// parse-resume-batch decides whether an uploaded resume belongs to someone
// already on the board. It used to look that up with
// `.eq('enrichment_status', 'stub')`, which can only ever see Indeed stubs —
// a candidate an earlier upload had already filed is 'resume_attached', so
// re-uploading the same resume filed the applicant a second time.
//
// The matcher itself is unit-tested in the function's own Deno suite, which
// CI does not run (no Deno on the runners). This guards the part of the fix
// that lives in the query, from the suite that does run. Source is pulled
// through Vite's raw glob, the same way edgeFunctionColumns.test.ts reads the
// functions tree without node:fs.
const SOURCE = Object.values(
  import.meta.glob('../../../supabase/functions/parse-resume-batch/index.ts', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>,
)[0] as string | undefined;

/** Comments explain the retired filter by name, so strip them before scanning. */
const code = (SOURCE ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('parse-resume-batch duplicate lookup', () => {
  it('finds the function source', () => {
    expect(code).toContain("from('candidates')");
  });

  it('never scopes the lookup to stubs, which would hide already-filed applicants', () => {
    expect(code).not.toContain("eq('enrichment_status', 'stub')");
  });

  it('loads the email alongside the name, since email is what settles identity', () => {
    expect(code).toContain("select('id, full_name, email, phone, enrichment_status')");
  });
});
