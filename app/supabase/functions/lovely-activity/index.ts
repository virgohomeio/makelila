// lovely-activity — Supabase Edge Function
//
// ⚠️ DEPLOYS TO THE **LOVELY** PROJECT (ref arfdopgbvlfmhmcfghhl), *NOT* makelila.
// The source lives in the makelila repo for cohesion, but any deploy
// (`supabase functions deploy` or the Supabase MCP) MUST target arfdopgbvlfmhmcfghhl.
//
// Per-user engagement aggregates for the makelila Lovely → Activity tab.
// `users.last_login_at` alone badly undercounts real use, because Lovely is a
// PWA and a session survives for weeks — a daily user can look dormant. This
// function aggregates every *other* timestamped thing the app writes so the
// makelila side can composite a real "last activity".
//
// Auth: any signed-in makelila operator on the org domain. Unlike
// lovely-verify-user / lovely-ota there is deliberately no leadership role
// check — this is a read-only surface and the whole team uses it.
//
// Deploy with verify_jwt = FALSE: the incoming token is a makelila JWT (not a
// Lovely JWT), so the gateway must not pre-verify it — auth is enforced in-body.
//
// Fault tolerance: each source table is read independently and a failure is
// reported in `warnings[]` rather than failing the request. A schema surprise in
// one table should cost one column in the UI, not the entire roster.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Public (non-secret) makelila project values — they already ship in the makelila
// frontend bundle. Used only to validate operator tokens against makelila auth.
const MAKELILA_URL = 'https://txeftbbzeflequvrmjjr.supabase.co';
const MAKELILA_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw';

const ALLOWED_EMAIL_DOMAIN = '@virgohome.io';

// Guard rail on the unbounded tables. `notifications` is the one that grows
// without limit (one row per push per user); past this the right fix is a
// server-side aggregate view, not a bigger number here.
const MAX_ROWS = 100_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

type Row = Record<string, unknown>;

type Agg = {
  user_id: string;
  serial_number: string | null;
  last_notification_read_at: string | null;
  notifications_unread: number;
  ota_last_accepted_at: string | null;
  ota_accept_count: number;
  last_batch_started_at: string | null;
  last_batch_completed_at: string | null;
  active_batch_side: 'L' | 'R' | null;
  batch_count: number;
  last_feedback_at: string | null;
  feedback_count: number;
  push_device_count: number;
  pwa_install_state: 'installed' | 'accepted' | 'dismissed' | 'prompted' | 'none';
  pwa_platform: string | null;
  pwa_last_event_at: string | null;
  damage_report_count: number;
  last_damage_at: string | null;
};

function newAgg(user_id: string, serial_number: string | null): Agg {
  return {
    user_id,
    serial_number,
    last_notification_read_at: null,
    notifications_unread: 0,
    ota_last_accepted_at: null,
    ota_accept_count: 0,
    last_batch_started_at: null,
    last_batch_completed_at: null,
    active_batch_side: null,
    batch_count: 0,
    last_feedback_at: null,
    feedback_count: 0,
    push_device_count: 0,
    pwa_install_state: 'none',
    pwa_platform: null,
    pwa_last_event_at: null,
    damage_report_count: 0,
    last_damage_at: null,
  };
}

// ISO timestamps sort lexicographically, so max is a string compare.
function later(a: string | null, b: unknown): string | null {
  if (typeof b !== 'string' || !b) return a;
  return !a || b > a ? b : a;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // 1. Require + validate the makelila operator token (domain only, no role gate).
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization header' }, 401);
  }
  const token = authHeader.replace('Bearer ', '');

  const makelila = createClient(MAKELILA_URL, MAKELILA_ANON_KEY);
  const { data: userData, error: authErr } = await makelila.auth.getUser(token);
  const email = userData?.user?.email ?? '';
  if (authErr || !email.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // 2. Aggregate with the Lovely project's own service role.
  const lovely = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const warnings: string[] = [];

  // Each source is optional: a failure costs one column, not the request.
  async function read(table: string, columns: string): Promise<Row[]> {
    const { data, error } = await lovely.from(table).select(columns).limit(MAX_ROWS);
    if (error) {
      console.error(`lovely-activity: ${table} read failed:`, error);
      warnings.push(`${table}: ${error.message}`);
      return [];
    }
    return (data ?? []) as unknown as Row[];
  }

  const { data: users, error: usersErr } = await lovely
    .from('users')
    .select('id, serial_number')
    .limit(MAX_ROWS);

  if (usersErr) {
    console.error('lovely-activity users read failed:', usersErr);
    return json({ error: usersErr.message }, 500);
  }

  const aggs = new Map<string, Agg>();
  const userBySerial = new Map<string, string>();
  for (const u of (users ?? []) as Array<{ id: string; serial_number: string | null }>) {
    aggs.set(u.id, newAgg(u.id, u.serial_number));
    if (u.serial_number) userBySerial.set(u.serial_number, u.id);
  }

  const [notifications, otaAcceptances, batches, feedback, compostFeedback, pushSubs, pwaEvents, damage] =
    await Promise.all([
      read('notifications', 'user_id, read_at'),
      read('ota_acceptances', 'user_id, accepted_at'),
      read('compost_batches', 'serial_number, chamber_side, started_at, completed_at'),
      read('feedback', 'user_id, created_at'),
      read('compost_feedback', 'user_id, created_at'),
      read('push_subscriptions', 'user_id'),
      read('pwa_install_events', 'user_id, event, platform, created_at'),
      read('damage_reports', 'user_id, created_at'),
    ]);

  const at = (uid: unknown): Agg | null =>
    typeof uid === 'string' ? aggs.get(uid) ?? null : null;

  // Notifications: newest read_at is the strongest "they opened the app" proxy,
  // since it needs no fresh login.
  for (const r of notifications) {
    const a = at(r.user_id);
    if (!a) continue;
    if (r.read_at) a.last_notification_read_at = later(a.last_notification_read_at, r.read_at);
    else a.notifications_unread += 1;
  }

  for (const r of otaAcceptances) {
    const a = at(r.user_id);
    if (!a) continue;
    a.ota_accept_count += 1;
    a.ota_last_accepted_at = later(a.ota_last_accepted_at, r.accepted_at);
  }

  // Batches key on serial_number, so they resolve through the pairing.
  for (const r of batches) {
    const uid = typeof r.serial_number === 'string' ? userBySerial.get(r.serial_number) : undefined;
    const a = uid ? aggs.get(uid) : null;
    if (!a) continue;
    a.batch_count += 1;
    a.last_batch_started_at = later(a.last_batch_started_at, r.started_at);
    a.last_batch_completed_at = later(a.last_batch_completed_at, r.completed_at);
    if (!r.completed_at && (r.chamber_side === 'L' || r.chamber_side === 'R')) {
      a.active_batch_side = r.chamber_side;
    }
  }

  // Both feedback surfaces roll into one "sent feedback" signal.
  for (const r of [...feedback, ...compostFeedback]) {
    const a = at(r.user_id);
    if (!a) continue;
    a.feedback_count += 1;
    a.last_feedback_at = later(a.last_feedback_at, r.created_at);
  }

  // One row per device with notifications enabled; rows are deleted on
  // unsubscribe, so a row means that install is still live.
  for (const r of pushSubs) {
    const a = at(r.user_id);
    if (a) a.push_device_count += 1;
  }

  // Install funnel: keep the furthest state reached, and the newest event's
  // platform (a user can prompt on one device and install on another).
  const INSTALL_RANK: Record<string, number> = {
    none: 0, prompted: 1, dismissed: 2, accepted: 3, installed: 4,
  };
  const EVENT_TO_STATE: Record<string, Agg['pwa_install_state']> = {
    prompt_shown: 'prompted', dismissed: 'dismissed', accepted: 'accepted', installed: 'installed',
  };
  for (const r of pwaEvents) {
    const a = at(r.user_id);
    if (!a) continue;
    const state = EVENT_TO_STATE[String(r.event)];
    if (state && INSTALL_RANK[state] > INSTALL_RANK[a.pwa_install_state]) {
      a.pwa_install_state = state;
    }
    const prev = a.pwa_last_event_at;
    a.pwa_last_event_at = later(prev, r.created_at);
    if (a.pwa_last_event_at !== prev && typeof r.platform === 'string') {
      a.pwa_platform = r.platform;
    }
  }

  for (const r of damage) {
    const a = at(r.user_id);
    if (!a) continue;
    a.damage_report_count += 1;
    a.last_damage_at = later(a.last_damage_at, r.created_at);
  }

  return json({ activity: [...aggs.values()], warnings });
});
