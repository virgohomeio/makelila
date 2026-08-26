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
import { buildTextResumeMessage, parseModelJson, pickProviders } from './index.ts';

Deno.test('pickProviders: Claude first, Qwen as fallback, when both keys are set', () => {
  assertEquals(pickProviders('sk-ant', 'sk-qwen'), ['claude', 'qwen']);
});

Deno.test('pickProviders: Claude only when no Qwen key (pre-fallback behaviour)', () => {
  assertEquals(pickProviders('sk-ant', undefined), ['claude']);
  assertEquals(pickProviders('sk-ant', ''), ['claude']);
});

Deno.test('pickProviders: Qwen directly when the Anthropic key is missing', () => {
  assertEquals(pickProviders(undefined, 'sk-qwen'), ['qwen']);
  assertEquals(pickProviders('', 'sk-qwen'), ['qwen']);
});

Deno.test('pickProviders: empty when neither key is configured', () => {
  assertEquals(pickProviders(undefined, undefined), []);
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
