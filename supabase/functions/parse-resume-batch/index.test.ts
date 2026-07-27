import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildScoringPrompt, matchExistingStub } from './index.ts';

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
