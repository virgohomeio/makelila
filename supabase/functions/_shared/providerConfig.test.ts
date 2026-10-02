import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { qwenConfigFromEnv, QWEN_DEFAULT_BASE_URL, QWEN_DEFAULT_MODEL } from './qwen.ts';
import { openaiConfigFromEnv, OPENAI_DEFAULT_BASE_URL, OPENAI_DEFAULT_MODEL } from './openai.ts';

/** Runs `fn` with the given env vars set, restoring whatever was there before. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = Deno.env.get(k);
    if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
  }
}

Deno.test('qwenConfigFromEnv: null when the key is unset or empty', () => {
  withEnv({ QWEN_API_KEY: undefined }, () => assertEquals(qwenConfigFromEnv(), null));
  withEnv({ QWEN_API_KEY: '' }, () => assertEquals(qwenConfigFromEnv(), null));
});

Deno.test('qwenConfigFromEnv: defaults to the international host and qwen-plus', () => {
  withEnv({ QWEN_API_KEY: 'sk-ws-x', QWEN_BASE_URL: undefined, QWEN_MODEL: undefined }, () => {
    assertEquals(qwenConfigFromEnv(), {
      apiKey: 'sk-ws-x', baseUrl: QWEN_DEFAULT_BASE_URL, model: QWEN_DEFAULT_MODEL,
    });
  });
});

Deno.test('qwenConfigFromEnv: honours base URL and model overrides', () => {
  withEnv({ QWEN_API_KEY: 'k', QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', QWEN_MODEL: 'qwen-flash' }, () => {
    const cfg = qwenConfigFromEnv();
    assertEquals(cfg?.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    assertEquals(cfg?.model, 'qwen-flash');
  });
});

Deno.test('openaiConfigFromEnv: null when the key is unset or empty', () => {
  withEnv({ OPENAI_API_KEY: undefined }, () => assertEquals(openaiConfigFromEnv(), null));
  withEnv({ OPENAI_API_KEY: '' }, () => assertEquals(openaiConfigFromEnv(), null));
});

Deno.test('openaiConfigFromEnv: defaults to api.openai.com and the default model', () => {
  withEnv({ OPENAI_API_KEY: 'sk-proj-x', OPENAI_BASE_URL: undefined, OPENAI_MODEL: undefined }, () => {
    assertEquals(openaiConfigFromEnv(), {
      apiKey: 'sk-proj-x', baseUrl: OPENAI_DEFAULT_BASE_URL, model: OPENAI_DEFAULT_MODEL,
    });
  });
});

Deno.test('openaiConfigFromEnv: honours overrides (e.g. Azure or a gateway)', () => {
  withEnv({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://gateway.internal/v1', OPENAI_MODEL: 'gpt-4.1-mini' }, () => {
    const cfg = openaiConfigFromEnv();
    assertEquals(cfg?.baseUrl, 'https://gateway.internal/v1');
    assertEquals(cfg?.model, 'gpt-4.1-mini');
  });
});
