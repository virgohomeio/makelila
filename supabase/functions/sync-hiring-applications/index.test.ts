import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseIndeedNotification } from './index.ts';

const REAL_SUBJECT = '[Action required] New application for Operations & Fulfillment Specialist, Markham, ON L3R 9Z7';
const REAL_FROM = 'conversation-jenivansivakumaru-9pqzi@indeedemail.com';
const REAL_BODY = `Jenivan Sivakumaru applied to the Operations & Fulfillment Specialist position posted on Indeed. You will find their information below and resume attached (if one was provided).

https://account.indeed.com/o/myaccess/switch/confirm?employerId=8c0b8fb9ae554408dac0e11bfd3c25f6&continue=https%3A%2F%2Femployers.indeed.com%2Fcandidates%2Fview%3Fid%3Da2d8364fa918%26refUid%3D1jqc7qi7ckdcg800

Name: Jenivan Sivakumaru
Email: conversation-jenivansivakumaru-9pqzi@indeedemail.com`;

Deno.test('parseIndeedNotification: extracts name, job title, relay email, dashboard link from a real per-candidate email', () => {
  const result = parseIndeedNotification(REAL_SUBJECT, REAL_FROM, REAL_BODY);
  assertEquals(result?.candidateName, 'Jenivan Sivakumaru');
  assertEquals(result?.jobTitle, 'Operations & Fulfillment Specialist');
  assertEquals(result?.relayEmail, 'conversation-jenivansivakumaru-9pqzi@indeedemail.com');
  assertEquals(result?.dashboardUrl?.includes('employers.indeed.com/candidates/view'), true);
});

Deno.test('parseIndeedNotification: returns null for non-application senders (marketing)', () => {
  const result = parseIndeedNotification(
    'Upcoming webinar — Hiring smarter: What strategy works best?',
    'learn@mc.indeed.com',
    'Join our webinar...',
  );
  assertEquals(result, null);
});

Deno.test('parseIndeedNotification: returns null for non-indeed senders entirely', () => {
  const result = parseIndeedNotification(REAL_SUBJECT, 'someone@gmail.com', REAL_BODY);
  assertEquals(result, null);
});

Deno.test('parseIndeedNotification: bundled digest email returns null (needs the See-all-candidates flow, not per-candidate parsing)', () => {
  // employers-noreply@indeed.com bundled emails ("X and N others applied")
  // don't carry a single candidate name/dashboard-link pair cleanly — V1
  // intentionally skips them and relies on the per-candidate conversation-*
  // emails, which fire for the same applicants individually in practice.
  const result = parseIndeedNotification(
    REAL_SUBJECT, 'employers-noreply@indeed.com', 'Junhyuk (James) Park and 2 others applied',
  );
  assertEquals(result, null);
});

Deno.test('parseIndeedNotification: extracts job title cleanly when location has a comma', () => {
  const result = parseIndeedNotification(
    '[Action required] New application for Product Engineering Co-op VCycene Inc. | Markham, ON (In-Person) | 8-Month Co-op, Markham, ON L3R 9Z7',
    'conversation-tylerchin-58ifd@indeedemail.com',
    'Tyler Chin applied to the Product Engineering Co-op VCycene Inc. | Markham, ON (In-Person) | 8-Month Co-op position posted on Indeed.\n\nhttps://employers.indeed.com/candidates/view?id=abc123\n\nName: Tyler Chin\nEmail: conversation-tylerchin-58ifd@indeedemail.com',
  );
  assertEquals(result?.candidateName, 'Tyler Chin');
  assertEquals(result?.jobTitle, 'Product Engineering Co-op VCycene Inc. | Markham, ON (In-Person) | 8-Month Co-op');
});
