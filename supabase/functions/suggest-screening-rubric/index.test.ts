import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateRubric, requireLeadershipRole } from './index.ts';

Deno.test('validateRubric: accepts a well-formed rubric summing to 100', () => {
  const result = validateRubric([
    { dimension: 'Logistics experience', weight_pct: 50 },
    { dimension: 'Communication', weight_pct: 50 },
  ]);
  assertEquals(result?.length, 2);
});

Deno.test('validateRubric: rejects weights that do not sum to 100', () => {
  const result = validateRubric([{ dimension: 'A', weight_pct: 40 }, { dimension: 'B', weight_pct: 40 }]);
  assertEquals(result, null);
});

Deno.test('validateRubric: rejects a non-array payload', () => {
  assertEquals(validateRubric({ dimension: 'A' }), null);
  assertEquals(validateRubric(null), null);
});

Deno.test('validateRubric: rejects an entry missing a dimension label', () => {
  const result = validateRubric([{ dimension: '', weight_pct: 100 }]);
  assertEquals(result, null);
});

Deno.test('requireLeadershipRole: allows finance and admin through', () => {
  assertEquals(requireLeadershipRole('finance'), null);
  assertEquals(requireLeadershipRole('admin'), null);
});

Deno.test('requireLeadershipRole: rejects a non-leadership internal user (e.g. recruiter) with 403', async () => {
  const res = requireLeadershipRole('recruiter');
  assertEquals(res?.status, 403);
  const body = await res?.json();
  assertEquals(body.error, 'This function is restricted to finance/admin (Hiring module leadership).');
});

Deno.test('requireLeadershipRole: rejects a missing/null role with 403', () => {
  assertEquals(requireLeadershipRole(null)?.status, 403);
  assertEquals(requireLeadershipRole(undefined)?.status, 403);
});
