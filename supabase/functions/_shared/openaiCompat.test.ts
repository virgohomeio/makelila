import { assertEquals, assertRejects, assertMatch, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { chatCompletion } from './openaiCompat.ts';

type Call = { url: string; method: string; headers: Headers; body: unknown };

function stubFetch(responses: (Response | 'throw')[]) {
  const calls: Call[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    const next = responses.shift();
    if (!next) throw new Error(`stubFetch: unexpected call #${calls.length} to ${String(input)}`);
    if (next === 'throw') throw new TypeError('network down');
    return next;
  }) as typeof fetch;
  return { calls, fetch: fetchStub };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const base = {
  label: 'OpenAI',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  user: 'Respond with JSON ONLY',
};

Deno.test('chatCompletion: posts messages with a bearer token and returns the assistant text', async () => {
  const { calls, fetch } = stubFetch([
    jsonRes({ choices: [{ message: { role: 'assistant', content: '{"full_name":"Ada"}' } }] }),
  ]);
  const text = await chatCompletion({ ...base, system: 'Output strict JSON only.', fetch });
  assertEquals(text, '{"full_name":"Ada"}');

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assertEquals(calls[0].headers.get('authorization'), 'Bearer sk-test');
  assertEquals(calls[0].headers.get('content-type'), 'application/json');
  const body = JSON.parse(calls[0].body as string);
  assertEquals(body.model, 'gpt-4o-mini');
  assertEquals(body.messages, [
    { role: 'system', content: 'Output strict JSON only.' },
    { role: 'user', content: 'Respond with JSON ONLY' },
  ]);
});

Deno.test('chatCompletion: omits max_tokens unless asked, so reasoning models that reject it still work', async () => {
  const { calls, fetch } = stubFetch([jsonRes({ choices: [{ message: { content: 'ok' } }] })]);
  await chatCompletion({ ...base, fetch });
  assertEquals('max_tokens' in JSON.parse(calls[0].body as string), false);
});

Deno.test('chatCompletion: sends max_tokens when one is given', async () => {
  const { calls, fetch } = stubFetch([jsonRes({ choices: [{ message: { content: 'ok' } }] })]);
  await chatCompletion({ ...base, maxTokens: 1024, fetch });
  assertEquals(JSON.parse(calls[0].body as string).max_tokens, 1024);
});

Deno.test('chatCompletion: omits the system message when none is given', async () => {
  const { calls, fetch } = stubFetch([jsonRes({ choices: [{ message: { content: 'ok' } }] })]);
  await chatCompletion({ ...base, fetch });
  assertEquals(JSON.parse(calls[0].body as string).messages, [{ role: 'user', content: 'Respond with JSON ONLY' }]);
});

Deno.test('chatCompletion: strips a trailing slash from the base URL', async () => {
  const { calls, fetch } = stubFetch([jsonRes({ choices: [{ message: { content: 'ok' } }] })]);
  await chatCompletion({ ...base, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/', fetch });
  assertEquals(calls[0].url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
});

Deno.test('chatCompletion: errors are prefixed with the provider label', async () => {
  const { fetch } = stubFetch([new Response('rate limited', { status: 429 })]);
  const err = await assertRejects(() => chatCompletion({ ...base, label: 'Qwen', fetch }), Error);
  assertEquals(err.message, 'Qwen chat 429: rate limited');
});

Deno.test('chatCompletion: a 401 names the key and base URL as the likely cause', async () => {
  const { fetch } = stubFetch([new Response('{"code":"invalid_api_key"}', { status: 401 })]);
  const err = await assertRejects(() => chatCompletion({ ...base, label: 'Qwen', keyEnvVar: 'QWEN_API_KEY', baseUrlEnvVar: 'QWEN_BASE_URL', fetch }), Error);
  assertMatch(err.message, /check QWEN_API_KEY/);
  assertMatch(err.message, /QWEN_BASE_URL matches/);
  assertStringIncludes(err.message, 'https://api.openai.com/v1');
});

Deno.test('chatCompletion: a 404 points at the model name', async () => {
  const { fetch } = stubFetch([
    new Response('{"error":{"message":"The model `gpt-4o-mini` does not exist"}}', { status: 404 }),
  ]);
  const err = await assertRejects(() => chatCompletion({ ...base, modelEnvVar: 'OPENAI_MODEL', fetch }), Error);
  assertMatch(err.message, /OPENAI_MODEL/);
  assertStringIncludes(err.message, 'gpt-4o-mini');
});

Deno.test('chatCompletion: network failure surfaces with the label', async () => {
  const { fetch } = stubFetch(['throw']);
  const err = await assertRejects(() => chatCompletion({ ...base, fetch }), Error);
  assertMatch(err.message, /^OpenAI chat failed: .*network down/);
});

Deno.test('chatCompletion: rejects when the response carries no text', async () => {
  const { fetch } = stubFetch([jsonRes({ choices: [] })]);
  const err = await assertRejects(() => chatCompletion({ ...base, fetch }), Error);
  assertMatch(err.message, /OpenAI returned no text/);
});
