// OpenAI configuration for the resume-parsing fallback. The HTTP call lives
// in _shared/openaiCompat.ts, shared with Qwen.
//
// Secrets (supabase secrets set):
//   OPENAI_API_KEY  — standard OpenAI key (sk-… / sk-proj-…).
//   OPENAI_BASE_URL — optional; defaults to OpenAI's own API. Point it at
//                     Azure OpenAI, an internal gateway, or any other
//                     OpenAI-compatible host to use that instead.
//   OPENAI_MODEL    — optional. The default below is a cheap, long-lived,
//                     widely-available chat model; OpenAI retires model names
//                     over time, so if the call comes back 404 set this to a
//                     model the account actually has. The error message says
//                     so explicitly.

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

export type ProviderConfig = { apiKey: string; baseUrl: string; model: string };

/** Reads the OpenAI env vars. Returns null when OPENAI_API_KEY is unset or
 *  empty, so an empty secret can't half-enable the provider. */
export function openaiConfigFromEnv(): ProviderConfig | null {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: Deno.env.get('OPENAI_BASE_URL') || OPENAI_DEFAULT_BASE_URL,
    model: Deno.env.get('OPENAI_MODEL') || OPENAI_DEFAULT_MODEL,
  };
}
