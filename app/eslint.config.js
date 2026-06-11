import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Backlog #49 — tune React 19 strict rules so lint can re-enter CI as a green
// gate without forcing a multi-day refactor. We turn three categories of
// errors into warnings (or off) because the patterns they flag are either
// idiomatic for our codebase or fixed-cost to migrate away from:
//
//   react-hooks/set-state-in-effect — guard-clause setState() in our data
//     hooks is intentional (clear state on prop change before re-fetching).
//     The React 19 doc recommends derived state, but our hooks subscribe to
//     Supabase realtime and a cleanup-on-prop-change pattern is the right
//     shape. Downgrade to warn so we still see new occurrences.
//
//   react-hooks/purity — Date.now() in render is flagged as "impure". For
//     "what's old?" calculations (days-open, age in hours) this is the
//     idiomatic minimum-viable pattern; useMemo with no deps doesn't help
//     because we WANT it to recompute on re-render. Downgrade to warn.
//
//   react-refresh/only-export-components — exporting helpers alongside a
//     component breaks fast-refresh for that file only. We tolerate it where
//     splitting would create more files than it saves. Warn, not error.
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Backlog #49 tuning — see header comment for rationale
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-refresh/only-export-components': 'warn',
      // Honor the `_`-prefix convention for intentionally-unused args/vars
      // (e.g. callback signatures that ignore a param) — standard ts-eslint setting.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
])
