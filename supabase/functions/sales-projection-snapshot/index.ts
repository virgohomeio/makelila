import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.headers.get('Authorization') !== `Bearer ${Deno.env.get('CRON_SECRET') ?? ''}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();

  const [{ data: orders }, { data: seasonalityRow }] = await Promise.all([
    supabase.from('orders')
      .select('id, currency, total_usd, line_items, placed_at, kind')
      .eq('kind', 'sale')
      .gte('placed_at', ninetyDaysAgo),
    supabase.from('finance_config').select('value').eq('config_key', 'seasonality').maybeSingle(),
  ]);

  const seasonality = (seasonalityRow?.value ?? {}) as Record<string, number>;
  const rows = [];

  for (const horizon of [30, 60, 90] as const) {
    for (const currency of ['CAD', 'USD']) {
      const currencyOrders = (orders ?? []).filter((o: { currency: string }) => o.currency === currency);
      const weeks = 90 / 7;
      const weeklyVelocity = currencyOrders.length / weeks;
      const revenues = currencyOrders.map((o: { total_usd: number }) => o.total_usd);
      const aov = revenues.length > 0 ? revenues.reduce((a: number, b: number) => a + b, 0) / revenues.length : 0;

      const avgMultiplier = (() => {
        let total = 0;
        const todayDate = new Date(today + 'T00:00:00Z');
        for (let d = 0; d < horizon; d++) {
          const day = new Date(todayDate);
          day.setUTCDate(day.getUTCDate() + d);
          const month = String(day.getUTCMonth() + 1);
          total += (seasonality[month] ?? 1.0);
        }
        return total / horizon;
      })();

      const projected = weeklyVelocity * aov * (horizon / 7) * avgMultiplier;
      const isCAD = currency === 'CAD';

      rows.push({
        as_of: new Date().toISOString(),
        horizon_days: horizon,
        model: 'rolling_average',
        projected_revenue_cad: isCAD ? projected : 0,
        projected_revenue_usd: isCAD ? 0 : projected,
        lower_bound_cad: isCAD ? projected * 0.85 : 0,
        upper_bound_cad: isCAD ? projected * 1.15 : 0,
        breakdown: [],
        inputs: { weeklyVelocity, aov, avgMultiplier, currency, horizon, ordersCount: currencyOrders.length },
      });
    }
  }

  if (rows.length > 0) {
    await supabase.from('sales_projection_snapshots').insert(rows);
  }

  return new Response(JSON.stringify({ ok: true, rows: rows.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
