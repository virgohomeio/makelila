import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.headers.get('Authorization') !== `Bearer ${Deno.env.get('CRON_SECRET') ?? ''}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const asOf = new Date().toISOString();
  const twelveWeeksAgo = new Date(Date.now() - 84 * 24 * 3600_000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const [{ data: batches }, { data: units }, { data: replacements }] = await Promise.all([
    supabase.from('batches').select('id, version, manufacturer_short, manufacturer, unit_count, arrived_at, expected_arrival_date'),
    supabase.from('units').select('batch, status, shipped_at'),
    supabase.from('orders').select('awaiting_batch_id').eq('kind', 'replacement').not('awaiting_batch_id', 'is', null),
  ]);

  if (!batches || !units || !replacements) {
    return new Response(JSON.stringify({ error: 'data fetch failed' }), { status: 500 });
  }

  const snapshots = [];
  for (const batch of batches) {
    const batchUnits = (units as Array<{ batch: string; status: string; shipped_at: string | null }>)
      .filter(u => u.batch === batch.id);

    const readyCount = batchUnits.filter(u => u.status === 'ready').length;
    const reservedCount = batchUnits.filter(u => u.status === 'reserved').length;
    if (readyCount + reservedCount === 0 && batch.arrived_at !== null) continue;

    const shippedLast12w = batchUnits.filter(u => u.shipped_at && u.shipped_at >= twelveWeeksAgo).length;
    const weeklyVelocity = shippedLast12w / 12;

    const replacementQueueSize = (replacements as Array<{ awaiting_batch_id: string }>)
      .filter(r => r.awaiting_batch_id === batch.id).length;

    const inboundUnits = batch.arrived_at ? 0 : batch.unit_count;
    const inboundArrivalDate = batch.arrived_at ? null : (batch.expected_arrival_date ?? null);

    // Inline stockout projection (mirrors the pure function in lib/finance.ts)
    let projectedStockoutDate: string | null = null;
    if (weeklyVelocity > 0) {
      let stock = readyCount;
      if (replacementQueueSize >= stock && inboundUnits === 0) {
        projectedStockoutDate = today;
      } else {
        const todayMs = Date.parse(today);
        for (let w = 0; w < 104; w++) {
          const weekStartMs = todayMs + w * 7 * 24 * 3600_000;
          const weekEndMs = weekStartMs + 7 * 24 * 3600_000;
          if (inboundUnits > 0 && inboundArrivalDate) {
            const arrivalMs = Date.parse(inboundArrivalDate);
            if (arrivalMs >= weekStartMs && arrivalMs < weekEndMs) stock += inboundUnits;
          }
          stock -= weeklyVelocity;
          if (stock <= 0) {
            const stockoutMs = weekStartMs + ((stock + weeklyVelocity) / weeklyVelocity) * 7 * 24 * 3600_000;
            projectedStockoutDate = new Date(stockoutMs).toISOString().slice(0, 10);
            break;
          }
        }
      }
    }

    const daysUntil = projectedStockoutDate ? (Date.parse(projectedStockoutDate) - Date.parse(today)) / (24 * 3600_000) : Infinity;
    const riskLevel = daysUntil < 30 ? 'red' : daysUntil < 90 ? 'amber' : 'green';

    snapshots.push({
      as_of: asOf,
      batch_id: batch.id,
      ready_count: readyCount,
      reserved_count: reservedCount,
      weekly_velocity: weeklyVelocity,
      projected_stockout_date: projectedStockoutDate,
      inbound_units: inboundUnits,
      inbound_arrival_date: inboundArrivalDate,
      replacement_queue_size: replacementQueueSize,
      risk_level: riskLevel,
    });
  }

  if (snapshots.length > 0) {
    await supabase.from('production_projection_snapshots').insert(snapshots);
  }

  return new Response(JSON.stringify({ ok: true, snapshots: snapshots.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
