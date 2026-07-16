// supabase-js collapses any non-2xx edge-function response into the opaque
// "Edge Function returned a non-2xx status code". The real { error } JSON lives
// on error.context (a Response). Pull it out so a Sync button can show the
// actual cause (e.g. "KLAVIYO_PRIVATE_KEY not configured", "Meta 400: …").
export async function fnErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    try { const b = await ctx.clone().json() as { error?: string }; if (b?.error) return b.error; } catch { /* not json */ }
    try { const t = await ctx.text(); if (t) return t.slice(0, 400); } catch { /* ignore */ }
  }
  return (error as Error)?.message ?? 'Edge function call failed';
}
