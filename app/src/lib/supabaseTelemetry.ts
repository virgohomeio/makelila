import { createClient } from '@supabase/supabase-js';

// Second Supabase client, pointed at the "Lovely" device-telemetry project
// (arfdopgbvlfmhmcfghhl). The main `supabase` client talks to the operations
// project (LILA-Pro-Inventory); telemetry tables (events, ac_current,
// bme_sensors, temperature_sensors, machine_health, lila) live only here.
//
// Read-only: all six tables expose `anon read` SELECT policies, so we never
// authenticate on this client. Session persistence is disabled so it can't
// collide with the main client's auth state in localStorage.

const url = import.meta.env.VITE_TELEMETRY_SUPABASE_URL;
const anonKey = import.meta.env.VITE_TELEMETRY_SUPABASE_ANON_KEY;

// Exported as a flag so callers (mainly the Dashboard route) can render a
// "Telemetry not configured" state instead of crashing the module at import.
// Previously this file threw at module load, which propagated through
// dashboard.ts and broke unrelated routes like /login when the telemetry
// env vars were absent.
export const isTelemetryConfigured = !!(url && anonKey);

export const supabaseTelemetry = isTelemetryConfigured
  ? createClient(url!, anonKey!, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        storageKey: 'sb-telemetry-auth',
      },
    })
  : null;

// Exposed for callers that need to hit the telemetry project's edge functions
// with a direct `fetch` (e.g. lib/lovely.ts, which passes a makelila operator
// token as Authorization while using this anon key as the gateway `apikey`).
// `undefined` when telemetry isn't configured — guard on isTelemetryConfigured.
export const TELEMETRY_URL = url;
export const TELEMETRY_ANON_KEY = anonKey;
