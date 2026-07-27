import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isPastRetention } from './index.ts';

Deno.test('isPastRetention: true when rejected_at is more than 1 year before now', () => {
  const now = new Date('2027-08-01T00:00:00Z');
  assertEquals(isPastRetention('2026-06-01T00:00:00Z', now), true);
});

Deno.test('isPastRetention: false when rejected_at is less than 1 year before now', () => {
  const now = new Date('2026-08-01T00:00:00Z');
  assertEquals(isPastRetention('2026-06-01T00:00:00Z', now), false);
});

Deno.test('isPastRetention: false exactly at the 1-year boundary minus a second', () => {
  const now = new Date('2027-06-01T00:00:00Z');
  assertEquals(isPastRetention('2026-06-01T00:00:01Z', now), false);
});
