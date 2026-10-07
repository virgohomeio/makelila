import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildScoringPrompt, requireLeadershipRole } from './index.ts';

Deno.test('buildScoringPrompt: includes the JD text and every rubric dimension', () => {
  const prompt = buildScoringPrompt(
    'We need an Operations & Fulfillment Specialist to run our Markham warehouse...',
    [{ dimension: 'Logistics experience', weight_pct: 50 }, { dimension: 'Communication', weight_pct: 50 }],
  );
  assertEquals(prompt.includes('Operations & Fulfillment Specialist'), true);
  assertEquals(prompt.includes('Logistics experience'), true);
  assertEquals(prompt.includes('Communication'), true);
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

import { assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildTextResumeMessage, parseModelJson, parseProviderOrder, pickProviders } from './index.ts';

const ALL = { claude: 'sk-ant', qwen: 'sk-ws-q', openai: 'sk-proj-o' };

Deno.test('pickProviders: Claude, then Qwen, then OpenAI when all three keys are set', () => {
  assertEquals(pickProviders(ALL), ['claude', 'qwen', 'openai']);
});

Deno.test('pickProviders: skips providers with no key, keeping relative order', () => {
  assertEquals(pickProviders({ claude: 'sk-ant', openai: 'sk-proj-o' }), ['claude', 'openai']);
  assertEquals(pickProviders({ qwen: 'sk-ws-q' }), ['qwen']);
});

Deno.test('pickProviders: an empty-string key counts as unset', () => {
  assertEquals(pickProviders({ claude: 'sk-ant', qwen: '', openai: undefined }), ['claude']);
});

Deno.test('pickProviders: empty when no key is configured', () => {
  assertEquals(pickProviders({}), []);
  assertEquals(pickProviders({ claude: undefined, qwen: '', openai: '' }), []);
});

Deno.test('pickProviders: RESUME_PROVIDER_ORDER reorders the chain', () => {
  assertEquals(pickProviders(ALL, 'openai,claude,qwen'), ['openai', 'claude', 'qwen']);
  assertEquals(pickProviders(ALL, 'qwen'), ['qwen', 'claude', 'openai']);
});

Deno.test('parseProviderOrder: defaults when unset, blank, or all-garbage', () => {
  assertEquals(parseProviderOrder(undefined), ['claude', 'qwen', 'openai']);
  assertEquals(parseProviderOrder(''), ['claude', 'qwen', 'openai']);
  assertEquals(parseProviderOrder('gemini,llama'), ['claude', 'qwen', 'openai']);
});

Deno.test('parseProviderOrder: unnamed providers are appended, never dropped', () => {
  assertEquals(parseProviderOrder('openai'), ['openai', 'claude', 'qwen']);
  assertEquals(parseProviderOrder('openai,typo'), ['openai', 'claude', 'qwen']);
});

Deno.test('parseProviderOrder: tolerates whitespace, case, and duplicates', () => {
  assertEquals(parseProviderOrder(' OpenAI , claude ,openai'), ['openai', 'claude', 'qwen']);
});

Deno.test('parseModelJson: parses bare JSON', () => {
  assertEquals(parseModelJson('{"full_name":"Ada"}'), { full_name: 'Ada' });
});

Deno.test('parseModelJson: strips ```json fences and surrounding whitespace', () => {
  assertEquals(parseModelJson('\n```json\n{"full_name":"Ada"}\n```\n'), { full_name: 'Ada' });
  assertEquals(parseModelJson('```\n{"full_name":"Ada"}\n```'), { full_name: 'Ada' });
});

Deno.test('parseModelJson: throws on non-JSON output', () => {
  assertThrows(() => parseModelJson('Sorry, I cannot read this file.'));
  assertThrows(() => parseModelJson(''));
});

Deno.test('buildTextResumeMessage: wraps the extracted resume text ahead of the scoring prompt', () => {
  const msg = buildTextResumeMessage('Score this.', 'Ada Lovelace\nada@example.com');
  assertEquals(msg.indexOf('Ada Lovelace') < msg.indexOf('Score this.'), true);
  assertEquals(msg.includes('ada@example.com'), true);
});

Deno.test('buildTextResumeMessage: caps very long resume text so one bad file cannot blow the context', () => {
  const msg = buildTextResumeMessage('Score this.', 'x'.repeat(200_000));
  assertEquals(msg.length < 100_000, true);
  assertEquals(msg.includes('Score this.'), true);
});

import { matchExistingCandidate } from './index.ts';

const stub = (id: string, full_name: string, email: string | null = null) =>
  ({ id, full_name, email, enrichment_status: 'stub' as const });
const attached = (id: string, full_name: string, email: string | null = null) =>
  ({ id, full_name, email, enrichment_status: 'resume_attached' as const });

Deno.test('matchExistingCandidate: a re-uploaded resume matches the record the first upload created', () => {
  const rows = [attached('c1', 'Ada Lovelace', 'ada@example.com')];
  const match = matchExistingCandidate(rows, { full_name: 'Ada Lovelace', email: 'ada@example.com' });
  assertEquals(match?.id, 'c1');
});

Deno.test('matchExistingCandidate: enriches an Indeed stub by name when the stub has no email', () => {
  const rows = [stub('c1', 'Jenivan Sivakumaru'), attached('c2', 'Roshan Shaji', 'roshan@example.com')];
  const match = matchExistingCandidate(rows, { full_name: 'jenivan sivakumaru', email: 'jen@example.com' });
  assertEquals(match?.id, 'c1');
  assertEquals(match?.enrichment_status, 'stub');
});

Deno.test('matchExistingCandidate: matches on email when the resume spells the name differently', () => {
  const rows = [attached('c1', 'Ada Lovelace', 'ada@example.com')];
  const match = matchExistingCandidate(rows, { full_name: 'Ada B. Lovelace', email: ' ADA@Example.com ' });
  assertEquals(match?.id, 'c1');
});

Deno.test('matchExistingCandidate: two applicants sharing a name but not an email stay separate', () => {
  const rows = [attached('c1', 'John Smith', 'john.smith@example.com')];
  assertEquals(matchExistingCandidate(rows, { full_name: 'John Smith', email: 'jsmith@other.com' }), null);
});

Deno.test('matchExistingCandidate: falls back to an exact name match when neither side has an email', () => {
  const rows = [attached('c1', 'Ada Lovelace', null)];
  assertEquals(matchExistingCandidate(rows, { full_name: '  ada lovelace ', email: null })?.id, 'c1');
});

Deno.test('matchExistingCandidate: prefers the stub when a stub and a full record both match', () => {
  const rows = [attached('c2', 'Ada Lovelace', null), stub('c1', 'Ada Lovelace')];
  assertEquals(matchExistingCandidate(rows, { full_name: 'Ada Lovelace', email: null })?.id, 'c1');
});

Deno.test('matchExistingCandidate: returns null when nobody matches', () => {
  assertEquals(matchExistingCandidate([], { full_name: 'Anyone', email: 'a@b.com' }), null);
  assertEquals(
    matchExistingCandidate([attached('c1', 'Ada Lovelace', 'ada@example.com')], { full_name: 'Someone Else', email: null }),
    null,
  );
});
