import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateIssue } from './index.ts';

const VALID_IDS = ['pro', 'mini', 'shop'];

Deno.test('validateIssue: accepts a well-formed issue', () => {
  const result = validateIssue({
    product_id: 'pro',
    title: 'Latch snaps off',
    severity: 'high',
    tag: 'Hardware · Latch',
    team: 'Ben Liang',
    meta: 'Latches break under normal use.',
    link: 'https://example.com/photo.jpg',
    mp_blocker: true,
  }, VALID_IDS);
  assertEquals(result?.product_id, 'pro');
  assertEquals(result?.severity, 'high');
  assertEquals(result?.mp_blocker, true);
});

Deno.test('validateIssue: rejects unknown product_id', () => {
  const result = validateIssue({
    product_id: 'nope', title: 'x', severity: 'high', meta: 'y',
  }, VALID_IDS);
  assertEquals(result, null);
});

Deno.test('validateIssue: rejects invalid severity', () => {
  const result = validateIssue({
    product_id: 'pro', title: 'x', severity: 'urgent', meta: 'y',
  }, VALID_IDS);
  assertEquals(result, null);
});

Deno.test('validateIssue: rejects empty title or meta', () => {
  assertEquals(validateIssue({ product_id: 'pro', title: '', severity: 'high', meta: 'y' }, VALID_IDS), null);
  assertEquals(validateIssue({ product_id: 'pro', title: 'x', severity: 'high', meta: '' }, VALID_IDS), null);
});

Deno.test('validateIssue: defaults tag to Other, team to empty string, mp_blocker to false when missing', () => {
  const result = validateIssue({
    product_id: 'pro', title: 'x', severity: 'low', meta: 'y',
  }, VALID_IDS);
  assertEquals(result?.tag, 'Other');
  assertEquals(result?.team, '');
  assertEquals(result?.mp_blocker, false);
});

Deno.test('validateIssue: rejects null or non-object issue', () => {
  assertEquals(validateIssue(null, VALID_IDS), null);
  assertEquals(validateIssue('not an object', VALID_IDS), null);
});
