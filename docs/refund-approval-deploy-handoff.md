# Refund & Return Approval — Deploy & Validation Handoff

Implements the [Refund & Return Approval Workflow PRD (v0.2)](https://app.notion.com/p/3a0ffbba4c3881da9f80d22ddc427227).
Branch: `feat/refund-approval-manager-gate`. This doc lists the **manual steps** that
can't be done from the app build (DB migrations, edge deploy, secrets) plus the
per-feature validation criteria.

## Commits (on top of `main` @ `e85e336`)

| Commit | PRD |
|---|---|
| `d11c03f` | FR-2 manager-review return gate + BUG-5 inspected/picked_up dropdown |
| `4ef253a` | FR-6 Customer(purchaser)/User(submitter) model + Customers-tab linking |
| `0312ed3` | FR-3 Submit-to-Manager action + Completeness column |
| `774c219` | FR-11/BR-15 purchaser-linkage gate + manager override |
| `a96ff0f` | FR-9a/b queue-entry + completion email notifications |
| `7fb384e` | FR-9c reminder-digest cron |
| `4f85dea` | FR-12 restocking + return-shipping fee breakdown |
| `4f615ff` | fix: FR-6 test-fixture build break |

Already-built (verified, no code): FR-4 editable amount, FR-5 persistent notes,
FR-1 journey fields, FR-11 form attestation, FR-8/FR-10 columns.

## 1. Apply migrations (manual DB workflow — not auto-applied)

Apply against LILA-Pro-Inventory in filename order:

1. `20260722140000_customers_purchaser_link.sql` — `customers.purchaser_id` self-FK (FR-6)
2. `20260722150000_returns_purchaser_linkage_confirm.sql` — linkage-confirm columns (FR-11)
3. `20260723120000_refund_notification_templates.sql` — 2 email templates (FR-9a/b)
4. `20260723130000_refund_reminder_digest.sql` — `last_reminded_at` + template + **pg_cron** (FR-9c)
5. `20260723140000_refund_fee_breakdown.sql` — restocking/return-shipping fee columns (FR-12)

Until applied, the UI is live-safe (new columns read as `null`) but linking,
fees, and reminders won't persist.

## 2. Deploy the edge function

- Deploy `supabase/functions/send-refund-reminders` (FR-9c). `send-template-email`
  (used by FR-9a/b) is already deployed.
- **Could not be type-checked locally** (no Deno in the build env); it mirrors the
  working `send-assignment-digests` line-for-line. **Smoke-test before trusting:**
  invoke with `{"dry_run": true}` and confirm the routing plan (which cards →
  which recipient) before any live send.

## 3. Secrets / env

Already present: `RESEND_API_KEY`, `CRON_SHARED_SECRET`, `SUPABASE_*`.
Optional overrides for role→holder routing (defaults in parens):

- `REFUND_MANAGER_EMAIL` (george@virgohome.io) — manager_review reminders
- `REFUND_FINANCE_EMAIL` (yueli@virgohome.io) — finance_review + non-Shopify executor
- `REFUND_PAYMENTS_EMAIL` (pedrum@virgohome.io) — Shopify/Sezzle executor
- `EMAIL_TEST_RECIPIENT` — reroutes all mail for testing (subject prefixed `[TEST → …]`)

The app-side executor addresses (FR-9a/b) live in `REFUND_EXECUTORS` in
`app/src/lib/postShipment.ts` — one-line change to swap holders.

## 4. Open decisions to confirm

- **OQ-2 (return-shipping deduction):** shipped as **operator-entered actual cost**
  (Finance types it, default 0), *not* a fixed number — this was not explicitly
  decided. If the team wants a fixed deduction, change the default in
  `defaultRefundFees()` / the FinanceApproveModal. No schema change needed.
- **BR-9/BR-12 sign-off:** the internal-only defect-exception wording still needs
  Huayi + George's explicit confirmation (per the PRD).

## 5. Per-feature validation (run the backlog cases through)

- **FR-2:** submit a card whose linked return isn't received → manager approve is
  blocked; a `discarded` defect case passes.
- **BUG-5:** the return-status dropdown offers "Unit inspected".
- **FR-6:** link Lily Xu → Annie Wu in the Customers tab; the refund card resolves
  accounting to Annie; search finds both.
- **FR-3:** a new refund lands in "Completeness"; "Submit to manager →" promotes it;
  George's column only shows submitted cards.
- **FR-11:** a gift filer with no receipt is blocked at manager approval until
  "⚠ Confirm purchaser linkage" is clicked.
- **FR-9a/b:** finance-approve a Shopify refund → Pedrum gets mail; execute it →
  the submitter (AM) gets mail. Check `email_messages` rows.
- **FR-9c:** `dry_run` shows overdue cards grouped by recipient.
- **FR-12:** finance modal shows "gross − restocking − shipping = net"; defect case
  waives both; "Apply net →" fills the amount.

## 6. Known issue (not from this branch)

`app/src/lib/auth.provider.test.tsx` (from `main` commit `e85e336`) is
**timing-flaky** — it intermittently fails in isolation but passes in the full
suite. It will cause occasional red CI until the auth-fix owner stabilises it.
