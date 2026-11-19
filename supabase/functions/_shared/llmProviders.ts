// Which LLM provider to try, and in what order, for any function that reads a
// document with a model.
//
// Extracted from parse-resume-batch when match-invoice needed the same thing:
// the Anthropic account running out of credit took resume parsing down (fixed
// 2026-08-26) and, unnoticed for two weeks, invoice matching with it — every
// upload silently extracted nothing. One provider chain, shared, so the next
// function to read a PDF inherits the fallback instead of re-learning this.
//
// Claude goes first because it reads a PDF/DOCX directly as a document block;
// the OpenAI-compatible providers need the text extracted locally first
// (_shared/documentText.ts) and share one client (_shared/openaiCompat.ts).

export type LlmProvider = 'claude' | 'qwen' | 'openai';

export const DEFAULT_PROVIDER_ORDER: LlmProvider[] = ['claude', 'qwen', 'openai'];

export const PROVIDER_LABELS: Record<LlmProvider, string> =
  { claude: 'Claude', qwen: 'Qwen', openai: 'OpenAI' };

/** Parses a provider-order CSV (e.g. "openai,claude") into a try-order.
 *  Unrecognised names are ignored and any provider the operator didn't name
 *  is appended in default order — reordering should never silently disable a
 *  provider whose key is configured, and a typo should degrade to the
 *  default rather than to nothing. */
export function parseProviderOrder(csv: string | undefined): LlmProvider[] {
  const named = (csv ?? '').split(',')
    .map(s => s.trim().toLowerCase())
    .filter((s): s is LlmProvider => (DEFAULT_PROVIDER_ORDER as string[]).includes(s));
  const deduped = [...new Set(named)];
  return [...deduped, ...DEFAULT_PROVIDER_ORDER.filter(p => !deduped.includes(p))];
}

/** Which providers to actually try, in order: the configured order filtered
 *  down to the ones that have a key. Empty string counts as unset so a
 *  `supabase secrets set QWEN_API_KEY=` typo can't half-enable one. */
export function pickProviders(
  keys: Partial<Record<LlmProvider, string | undefined>>,
  orderCsv?: string,
): LlmProvider[] {
  return parseProviderOrder(orderCsv).filter(p => !!keys[p]);
}

/** Chains the failures from a whole provider run into one message. Each
 *  message already names its own provider, so joining them tells the operator
 *  which key(s) need attention without any extra labelling. */
export function chainFailures(failures: string[]): string {
  const [primary, ...rest] = failures;
  return rest.length ? `${primary}; then ${rest.join('; then ')}` : (primary ?? 'no provider configured');
}

/** Strips an optional ```json / ``` fence and returns the first JSON object in
 *  a model reply. Every provider here is told "JSON only" and every one of
 *  them occasionally wraps it in a fence or a sentence anyway. */
export function jsonFromModelText(text: string): Record<string, unknown> {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const m = stripped.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Model returned non-JSON: ${stripped.slice(0, 200)}`);
  return JSON.parse(m[0]) as Record<string, unknown>;
}
