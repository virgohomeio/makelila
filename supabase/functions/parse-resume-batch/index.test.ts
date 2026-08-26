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
