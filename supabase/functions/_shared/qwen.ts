// Qwen (Alibaba Cloud Model Studio / DashScope) chat client. Fallback
// provider for parse-resume-batch when the Anthropic account is out of
// credit or otherwise erroring — see
// docs/superpowers/specs/2026-08-26-hiring-resume-qwen-fallback-design.md.
//
// Uses the OpenAI-compatible /chat/completions endpoint with plain text
// only. Qwen has no document content block the way Anthropic does, so the
// caller extracts PDF/DOCX text locally first (_shared/documentText.ts).
// That keeps the fallback independent of which models / file features a
// given Model Studio workspace or region has enabled, and means no resume
// is ever uploaded to a third-party file store.
//
// Secrets (supabase secrets set):
//   QWEN_API_KEY   — Model Studio API key (sk-… or the newer sk-ws-…).
//                    Keys are region-bound: a Singapore key only works
//                    against the international host and vice versa.
//   QWEN_BASE_URL  — optional; defaults to the international (Singapore)
//                    shared host. Beijing keys use
//                    https://dashscope.aliyuncs.com/compatible-mode/v1.
//                    Workspace-dedicated hosts
//                    (https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1)
//                    also work here.
//   QWEN_MODEL     — optional; defaults to qwen-plus.
//
// `fetch` is injectable so the call can be unit-tested with a stub.

export const QWEN_DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export const QWEN_DEFAULT_MODEL = 'qwen-plus';

export type QwenChatRequest = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  system?: string;
  user: string;
  maxTokens?: number;
  fetch?: typeof fetch;
};

/** Reads the Qwen env vars. Returns null when QWEN_API_KEY is unset so callers
 *  can decide whether the fallback is available at all. */
export function qwenConfigFromEnv(): { apiKey: string; baseUrl: string; model: string } | null {
  const apiKey = Deno.env.get('QWEN_API_KEY');
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: Deno.env.get('QWEN_BASE_URL') || QWEN_DEFAULT_BASE_URL,
    model: Deno.env.get('QWEN_MODEL') || QWEN_DEFAULT_MODEL,
  };
}

/** One chat completion; returns the assistant's text. Throws an Error whose
 *  message starts with "Qwen …" (with the HTTP status when there is one) so
 *  the caller can surface it next to the primary provider's error. */
export async function chatCompletion(req: QwenChatRequest): Promise<string> {
  const doFetch = req.fetch ?? fetch;
  const base = (req.baseUrl ?? QWEN_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const messages = [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    { role: 'user', content: req.user },
  ];

  let res: Response;
  try {
    res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${req.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: req.model ?? QWEN_DEFAULT_MODEL, max_tokens: req.maxTokens ?? 1024, messages }),
    });
  } catch (e) {
    throw new Error(`Qwen chat failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!res.ok) {
    // A wrong-region key is the most likely 401 here (Alibaba's Singapore,
    // US and Beijing keys are not interchangeable) and the raw message
    // ("Incorrect API key provided") doesn't hint at that — so say it.
    const hint = res.status === 401
      ? ` — check QWEN_API_KEY, and that QWEN_BASE_URL matches the key's region (currently ${base})`
      : '';
    throw new Error(`Qwen chat ${res.status}: ${(await res.text()).slice(0, 300)}${hint}`);
  }
  const json = await res.json().catch(() => null) as
    { choices?: { message?: { content?: string | null } }[] } | null;
  const text = json?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('Qwen returned no text');
  return text;
}
