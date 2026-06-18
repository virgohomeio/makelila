import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { matchesDiagnosisTitle, isDuplicateOf } from './dedupe.ts';

Deno.test('matchesDiagnosisTitle is case-insensitive substring', () => {
  assertEquals(matchesDiagnosisTitle('LILA Diagnosis Chat with Jane', 'LILA Diagnosis Chat'), true);
  assertEquals(matchesDiagnosisTitle('lila diagnosis chat', 'LILA Diagnosis Chat'), true);
  assertEquals(matchesDiagnosisTitle('Onboarding call', 'LILA Diagnosis Chat'), false);
  assertEquals(matchesDiagnosisTitle(undefined, 'LILA Diagnosis Chat'), false);
});
Deno.test('isDuplicateOf matches same email within ±15 min', () => {
  const existing = [{ customer_email: 'a@b.com', calendly_event_start: '2026-06-20T15:00:00Z' }];
  assertEquals(isDuplicateOf({ email: 'A@B.com', startIso: '2026-06-20T15:10:00Z' }, existing), true);
  assertEquals(isDuplicateOf({ email: 'a@b.com', startIso: '2026-06-20T15:30:00Z' }, existing), false);
  assertEquals(isDuplicateOf({ email: 'x@y.com', startIso: '2026-06-20T15:05:00Z' }, existing), false);
  assertEquals(isDuplicateOf({ email: null, startIso: '2026-06-20T15:00:00Z' }, existing), false);
});
