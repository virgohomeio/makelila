import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildScoringPrompt, matchExistingStub, requireLeadershipRole } from './index.ts';

Deno.test('buildScoringPrompt: includes the JD text and every rubric dimension', () => {
  const prompt = buildScoringPrompt(
    'We need an Operations & Fulfillment Specialist to run our Markham warehouse...',
    [{ dimension: 'Logistics experience', weight_pct: 50 }, { dimension: 'Communication', weight_pct: 50 }],
  );
  assertEquals(prompt.includes('Operations & Fulfillment Specialist'), true);
  assertEquals(prompt.includes('Logistics experience'), true);
  assertEquals(prompt.includes('Communication'), true);
});

Deno.test('matchExistingStub: matches on case-insensitive exact name', () => {
  const candidates = [{ id: 'c1', full_name: 'Jenivan Sivakumaru' }, { id: 'c2', full_name: 'Roshan Shaji' }];
  assertEquals(matchExistingStub(candidates, 'jenivan sivakumaru'), 'c1');
});

Deno.test('matchExistingStub: returns null when no name matches', () => {
  const candidates = [{ id: 'c1', full_name: 'Jenivan Sivakumaru' }];
  assertEquals(matchExistingStub(candidates, 'Someone Else'), null);
});

Deno.test('matchExistingStub: returns null for an empty candidate list', () => {
  assertEquals(matchExistingStub([], 'Anyone'), null);
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
