# Tests

## Unit (`npm run test:run`)

All logic that doesn't require a browser — auth helpers, activityLog client, etc.

## E2E smoke (`npm run e2e`)

Covers:
- unauthenticated route → redirect to `/login`
- login page UI renders

## Not yet covered (deferred to later plans)

- Full OAuth flow (requires a test-friendly Google OAuth app or a session-injection helper)
- Realtime subscription across sessions (needs 2 sessions; verify manually for now)
- Each module's full UI (covered by its own plan)
