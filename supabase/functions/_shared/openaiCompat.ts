// Minimal client for OpenAI-compatible /chat/completions endpoints.
//
// Shared by the resume-parsing fallback providers — see
// docs/superpowers/specs/2026-08-26-hiring-resume-qwen-fallback-design.md.
// OpenAI itself and Alibaba's Model Studio "compatible mode" speak the same
// wire format, so one client covers both; only the base URL, key, model and
// display label differ. Anything else OpenAI-compatible (Azure, an internal
// gateway, OpenRouter) works too by pointing *_BASE_URL at it.
//
// Text only, deliberately: neither provider takes a DOCX, and OpenAI's PDF
// input needs a different request shape per model generation. The caller
// extracts the text locally (_shared/documentText.ts) and passes it in, so
// this stays one code path that works on every model.
//
// `fetch` is injectable so calls can be unit-tested with a stub.

export type ChatRequest = {
  /** Provider name used to prefix errors, e.g. "OpenAI" / "Qwen". */
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  system?: string;
  user: string;
  /** Omitted from the request when unset — reasoning models reject
   *  `max_tokens` outright (they want `max_completion_tokens`), so sending
   *  nothing is the portable choice. */
  maxTokens?: number;
  /** Names of the env vars backing this provider, used to make errors
   *  self-diagnosing. Optional. */
  keyEnvVar?: string;
  baseUrlEnvVar?: string;
  modelEnvVar?: string;
  fetch?: typeof fetch;
};

/** One chat completion; returns the assistant's text. Throws an Error whose
 *  message starts with "<label> …" (including the HTTP status when there is
 *  one) so a caller trying several providers can report exactly which failed
 *  and why. */
export async function chatCompletion(req: ChatRequest): Promise<string> {
  const doFetch = req.fetch ?? fetch;
  const base = req.baseUrl.replace(/\/+$/, '');
  const messages = [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    { role: 'user', content: req.user },
  ];
  const body: Record<string, unknown> = { model: req.model, messages };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

  let res: Response;
  try {
    res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${req.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`${req.label} chat failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!res.ok) throw new Error(`${req.label} chat ${res.status}: ${(await res.text()).slice(0, 300)}${hintFor(res.status, req, base)}`);

  const json = await res.json().catch(() => null) as
    { choices?: { message?: { content?: string | null } }[] } | null;
  const text = json?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error(`${req.label} returned no text`);
  return text;
}

/** The raw provider messages ("Incorrect API key provided", "The model … does
 *  not exist") don't say which secret to look at, and for Qwen a wrong-region
 *  key looks identical to a wrong key. Name the knob. */
function hintFor(status: number, req: ChatRequest, base: string): string {
  if (status === 401 || status === 403) {
    const parts = [req.keyEnvVar && `check ${req.keyEnvVar}`,
      req.baseUrlEnvVar && `that ${req.baseUrlEnvVar} matches the key's account/region (currently ${base})`]
      .filter(Boolean);
    return parts.length ? ` — ${parts.join(', and ')}` : '';
  }
  if (status === 404 && req.modelEnvVar) return ` — check ${req.modelEnvVar} (currently ${req.model})`;
  return '';
}
