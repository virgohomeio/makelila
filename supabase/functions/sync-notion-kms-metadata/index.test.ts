// supabase/functions/sync-notion-kms-metadata/index.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

// extractTitle is exported from the implementation for testability
// Import after creating index.ts
import { extractTitle } from './index.ts';

Deno.test('extractTitle: standard page title property', () => {
  const page = {
    properties: {
      title: { title: [{ plain_text: 'LILA Pro PRD' }] },
    },
  };
  assertEquals(extractTitle(page), 'LILA Pro PRD');
});

Deno.test('extractTitle: Name property fallback', () => {
  const page = {
    properties: {
      Name: { title: [{ plain_text: 'Design Matrix' }] },
    },
  };
  assertEquals(extractTitle(page), 'Design Matrix');
});

Deno.test('extractTitle: missing title returns empty string', () => {
  const page = { properties: {} };
  assertEquals(extractTitle(page), '');
});

Deno.test('extractTitle: malformed page does not throw', () => {
  assertEquals(extractTitle(null as unknown as Record<string, unknown>), '');
  assertEquals(extractTitle({} as Record<string, unknown>), '');
});
