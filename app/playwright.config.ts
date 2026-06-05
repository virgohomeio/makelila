import { defineConfig } from '@playwright/test';

// Backlog #50 — placeholder env vars for the webServer so Playwright can
// boot the app locally without .env.local configured (and in CI without
// every secret wired up). The unauth redirect specs don't exercise
// Supabase at runtime; the placeholder is only needed because supabase.ts
// throws at import time if VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// are missing. Real specs (e.g. the seeded #55 replacement workflow) need
// real values from process.env.
const placeholderUrl = 'https://placeholder.supabase.co';
const placeholderKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder.placeholder';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173/',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173/',
    reuseExistingServer: !process.env.CI,
    env: {
      // Pass real env vars through if set; fall back to placeholders.
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? placeholderUrl,
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY ?? placeholderKey,
      VITE_TELEMETRY_SUPABASE_URL: process.env.VITE_TELEMETRY_SUPABASE_URL ?? '',
      VITE_TELEMETRY_SUPABASE_ANON_KEY: process.env.VITE_TELEMETRY_SUPABASE_ANON_KEY ?? '',
    },
  },
});
