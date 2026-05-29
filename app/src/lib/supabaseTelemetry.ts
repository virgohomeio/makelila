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

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_TELEMETRY_SUPABASE_URL or VITE_TELEMETRY_SUPABASE_ANON_KEY. ' +
    'These point the Dashboard at the device-telemetry project. ' +
    'Copy .env.example to .env and fill in values.',
  );
}

export const supabaseTelemetry = createClient(url, anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    storageKey: 'sb-telemetry-auth',
  },
});
