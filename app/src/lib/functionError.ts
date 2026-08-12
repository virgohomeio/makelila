/** supabase-js collapses any non-2xx edge-function response into a generic
 *  "Edge Function returned a non-2xx status code"; the real `{ error }` JSON the
 *  function returned is on error.context (a Response). Pull it out so operators
 *  see the actual cause instead of the opaque default. */
export async function functionErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch { /* body wasn't JSON — fall through to text */ }
    try {
      const text = await ctx.text();
      if (text) return text.slice(0, 400);
    } catch { /* ignore */ }
  }
  return (error as Error)?.message ?? 'Edge function call failed';
}
