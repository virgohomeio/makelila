import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateIssue, classifyReferences } from './index.ts';

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

Deno.test('classifyReferences: accepts and classifies github, notion, and doc URLs', () => {
  const result = classifyReferences([
    'https://github.com/virgohomeio/makelila/pull/44',
    'https://notion.so/some-page-abc123',
    'https://docs.google.com/document/d/xyz',
    'https://drive.google.com/file/d/xyz',
  ]);
  assertEquals(result, [
    { url: 'https://github.com/virgohomeio/makelila/pull/44', kind: 'github' },
    { url: 'https://notion.so/some-page-abc123', kind: 'notion' },
    { url: 'https://docs.google.com/document/d/xyz', kind: 'doc' },
    { url: 'https://drive.google.com/file/d/xyz', kind: 'doc' },
  ]);
});

Deno.test('classifyReferences: unrecognized hostnames classify as other', () => {
  const result = classifyReferences(['https://example.com/some-doc.pdf']);
  assertEquals(result, [{ url: 'https://example.com/some-doc.pdf', kind: 'other' }]);
});

Deno.test('classifyReferences: rejects non-http(s) schemes', () => {
  const result = classifyReferences([
    'javascript:alert(1)',
    'ftp://example.com/file',
    'https://github.com/ok/repo',
  ]);
  assertEquals(result, [{ url: 'https://github.com/ok/repo', kind: 'github' }]);
});

Deno.test('classifyReferences: dedupes exact-match URLs', () => {
  const result = classifyReferences([
    'https://github.com/ok/repo',
    'https://github.com/ok/repo',
  ]);
  assertEquals(result.length, 1);
});

Deno.test('classifyReferences: caps at 10 references', () => {
  const urls = Array.from({ length: 15 }, (_, i) => `https://example.com/doc-${i}`);
  const result = classifyReferences(urls);
  assertEquals(result.length, 10);
});

Deno.test('classifyReferences: non-array input returns empty array', () => {
  assertEquals(classifyReferences(null), []);
  assertEquals(classifyReferences(undefined), []);
  assertEquals(classifyReferences('not an array'), []);
});

Deno.test('classifyReferences: drops non-string and empty entries', () => {
  const result = classifyReferences(['https://github.com/ok/repo', 123, '', '   ', null]);
  assertEquals(result, [{ url: 'https://github.com/ok/repo', kind: 'github' }]);
});
