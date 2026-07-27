import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateRubric } from './index.ts';

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
