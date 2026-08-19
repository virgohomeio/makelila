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
    css: {
      // Vitest mocks every CSS import to an empty string by default (a
      // perf optimisation — most tests don't care what's inside a
      // stylesheet). tokens.test.ts is the one exception: it pulls in
      // tokens.css via a `?raw` import and parses the real bytes through
      // jsdom's getComputedStyle to assert the token contract, so an
      // empty string would make every assertion in that file pass or
      // fail against nothing. Anchored to src/styles/tokens.css, with an
      // optional trailing `?...` query string since the module id carries
      // one — a bare /tokens\.css/ substring match would also catch
      // node_modules/**/tokens.css or a future design-tokens.css. Scoped to
      // just this one file so the other 100+ test files keep the fast
      // default.
      include: [/src\/styles\/tokens\.css(\?|$)/],
    },
  },
});
