import { assertEquals, assertRejects, assertMatch, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { chatCompletion, QWEN_DEFAULT_BASE_URL, QWEN_DEFAULT_MODEL } from './qwen.ts';

type Call = { url: string; method: string; headers: Headers; body: unknown };

/** Builds a fetch stub that answers each call from `responses` in order and
 *  records what it was called with. A response entry of `'throw'` makes that
 *  call reject (network failure). */
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

const baseReq = { apiKey: 'sk-ws-test', user: 'Respond with JSON ONLY' };

Deno.test('chatCompletion: posts the messages with a bearer token and returns the assistant text', async () => {
  const { calls, fetch } = stubFetch([
    jsonRes({ choices: [{ message: { role: 'assistant', content: '{"full_name":"Ada"}' } }] }),
  ]);
  const text = await chatCompletion({ ...baseReq, system: 'Output strict JSON only.', fetch });
  assertEquals(text, '{"full_name":"Ada"}');

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[0].url, `${QWEN_DEFAULT_BASE_URL}/chat/completions`);
  assertEquals(calls[0].headers.get('authorization'), 'Bearer sk-ws-test');
  assertEquals(calls[0].headers.get('content-type'), 'application/json');
  const body = JSON.parse(calls[0].body as string);
  assertEquals(body.model, QWEN_DEFAULT_MODEL);
  assertEquals(body.messages, [
    { role: 'system', content: 'Output strict JSON only.' },
    { role: 'user', content: 'Respond with JSON ONLY' },
  ]);
});

Deno.test('chatCompletion: omits the system message when none is given', async () => {
  const { calls, fetch } = stubFetch([jsonRes({ choices: [{ message: { content: 'ok' } }] })]);
  await chatCompletion({ ...baseReq, fetch });
  assertEquals(JSON.parse(calls[0].body as string).messages, [{ role: 'user', content: 'Respond with JSON ONLY' }]);
});

Deno.test('chatCompletion: honours baseUrl (trailing slash stripped) and model overrides', async () => {
  const { calls, fetch } = stubFetch([jsonRes({ choices: [{ message: { content: 'ok' } }] })]);
  await chatCompletion({
    ...baseReq, fetch,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
    model: 'qwen-flash',
  });
  assertEquals(calls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assertEquals(JSON.parse(calls[0].body as string).model, 'qwen-flash');
});

Deno.test('chatCompletion: non-2xx throws with the status and response body', async () => {
  const { fetch } = stubFetch([
    new Response('{"error":{"message":"Incorrect API key provided.","code":"invalid_api_key"}}', { status: 401 }),
  ]);
  const err = await assertRejects(() => chatCompletion({ ...baseReq, fetch }), Error);
  assertMatch(err.message, /^Qwen chat 401: .*Incorrect API key/);
});

Deno.test('chatCompletion: a 401 names the region/base-url as the likely cause', async () => {
  const { fetch } = stubFetch([new Response('{"code":"invalid_api_key"}', { status: 401 })]);
  const err = await assertRejects(() => chatCompletion({ ...baseReq, fetch }), Error);
  assertMatch(err.message, /QWEN_BASE_URL matches the key's region/);
  assertStringIncludes(err.message, QWEN_DEFAULT_BASE_URL);
});

Deno.test('chatCompletion: non-401 errors carry no region hint', async () => {
  const { fetch } = stubFetch([new Response('rate limited', { status: 429 })]);
  const err = await assertRejects(() => chatCompletion({ ...baseReq, fetch }), Error);
  assertEquals(err.message, 'Qwen chat 429: rate limited');
});

Deno.test('chatCompletion: network failure surfaces as a Qwen error', async () => {
  const { fetch } = stubFetch(['throw']);
  const err = await assertRejects(() => chatCompletion({ ...baseReq, fetch }), Error);
  assertMatch(err.message, /^Qwen chat failed: .*network down/);
});

Deno.test('chatCompletion: rejects when the response carries no text', async () => {
  const { fetch } = stubFetch([jsonRes({ choices: [] })]);
  const err = await assertRejects(() => chatCompletion({ ...baseReq, fetch }), Error);
  assertMatch(err.message, /Qwen returned no text/);
});
