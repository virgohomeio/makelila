// confirm-address: public edge function called when a customer clicks the
// address confirmation link from their order email. No auth required —
// the order_id UUID is hard to guess, and confirming is a low-stakes action.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const supabaseUrl  = Deno.env.get('SUPABASE_URL');
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return j({ error: 'Server misconfigured' }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let body: { order_id?: string };
  try { body = await req.json(); }
  catch { return j({ error: 'Invalid JSON' }, 400); }

  const orderId = body.order_id?.trim();
  if (!orderId) return j({ error: 'order_id required' }, 400);

  const { data: order, error: fetchErr } = await admin
    .from('orders')
    .select('id, order_ref, address_confirmed_at')
    .eq('id', orderId)
    .maybeSingle();

  if (fetchErr) return j({ error: fetchErr.message }, 500);
  if (!order)   return j({ error: 'Order not found' }, 404);

  // Already confirmed — idempotent, return success.
  if (order.address_confirmed_at) {
    return j({ order_ref: order.order_ref, already_confirmed: true });
  }

  const { error: upErr } = await admin
    .from('orders')
    .update({ address_confirmed_at: new Date().toISOString() })
    .eq('id', orderId);

  if (upErr) return j({ error: upErr.message }, 500);

  return j({ order_ref: order.order_ref, already_confirmed: false });
});
