// Qwen (Alibaba Cloud Model Studio / DashScope) configuration for the
// resume-parsing fallback. The HTTP call itself lives in
// _shared/openaiCompat.ts — Model Studio's "compatible mode" is the same
// wire format as OpenAI's, so both providers share one client.
//
// Secrets (supabase secrets set):
//   QWEN_API_KEY   — Model Studio API key (sk-… or the newer sk-ws-…).
//                    Keys are region-bound: Alibaba's docs state Singapore,
//                    US and Beijing keys "are not interchangeable".
//   QWEN_BASE_URL  — optional; defaults to the international (Singapore)
//                    shared host. Beijing keys use
//                    https://dashscope.aliyuncs.com/compatible-mode/v1.
//                    Workspace-dedicated hosts
//                    (https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1)
//                    also work here.
//   QWEN_MODEL     — optional; defaults to qwen-plus.

export const QWEN_DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export const QWEN_DEFAULT_MODEL = 'qwen-plus';

export type ProviderConfig = { apiKey: string; baseUrl: string; model: string };

/** Reads the Qwen env vars. Returns null when QWEN_API_KEY is unset or empty,
 *  so a `secrets set QWEN_API_KEY=` typo can't half-enable the provider. */
export function qwenConfigFromEnv(): ProviderConfig | null {
  const apiKey = Deno.env.get('QWEN_API_KEY');
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: Deno.env.get('QWEN_BASE_URL') || QWEN_DEFAULT_BASE_URL,
    model: Deno.env.get('QWEN_MODEL') || QWEN_DEFAULT_MODEL,
  };
}
