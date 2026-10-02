import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { chainFailures, jsonFromModelText, parseProviderOrder, pickProviders } from './llmProviders.ts';

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

Deno.test('pickProviders: no keys at all yields no providers (caller reports it)', () => {
  assertEquals(pickProviders({}), []);
});

Deno.test('parseProviderOrder: an explicit order wins', () => {
  assertEquals(parseProviderOrder('openai,claude'), ['openai', 'claude', 'qwen']);
});

Deno.test('parseProviderOrder: a provider left out of the CSV is appended, not dropped', () => {
  // The whole point: reordering must never silently disable a configured key.
  assertEquals(parseProviderOrder('qwen'), ['qwen', 'claude', 'openai']);
});

Deno.test('parseProviderOrder: a typo degrades to the default order', () => {
  assertEquals(parseProviderOrder('opennai'), ['claude', 'qwen', 'openai']);
  assertEquals(parseProviderOrder(undefined), ['claude', 'qwen', 'openai']);
});

Deno.test('parseProviderOrder: case and whitespace do not matter, duplicates collapse', () => {
  assertEquals(parseProviderOrder(' OpenAI , openai , CLAUDE '), ['openai', 'claude', 'qwen']);
});

Deno.test('chainFailures: names every provider that failed, in order', () => {
  assertEquals(
    chainFailures(['Claude 400: credit balance is too low', 'Qwen chat 401: bad key']),
    'Claude 400: credit balance is too low; then Qwen chat 401: bad key',
  );
});

Deno.test('chainFailures: a single failure is reported on its own', () => {
  assertEquals(chainFailures(['Claude 400: nope']), 'Claude 400: nope');
});

Deno.test('chainFailures: no failures at all still says something useful', () => {
  assertEquals(chainFailures([]), 'no provider configured');
});

Deno.test('jsonFromModelText: reads a bare JSON object', () => {
  assertEquals(jsonFromModelText('{"a": 1}'), { a: 1 });
});

Deno.test('jsonFromModelText: strips a ```json fence', () => {
  assertEquals(jsonFromModelText('```json\n{"a": 1}\n```'), { a: 1 });
});

Deno.test('jsonFromModelText: digs the object out of surrounding prose', () => {
  assertEquals(jsonFromModelText('Here you go:\n{"a": 1}\nHope that helps'), { a: 1 });
});

Deno.test('jsonFromModelText: throws when there is no object at all', () => {
  assertThrows(() => jsonFromModelText('I could not read this document.'));
});
