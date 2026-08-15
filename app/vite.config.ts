// vite.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    fs: {
      // The Deno edge functions live outside this Vite root. Reading them is
      // what lets edgeFunctionColumns.test.ts assert that their hand-written
      // PostgREST selects name columns that actually exist — a class of bug
      // nothing else in the toolchain can catch.
      allow: ['.', '../supabase/functions'],
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['node_modules', 'dist', 'tests/e2e/**'],
  },
});
