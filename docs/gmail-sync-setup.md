# Gmail Sync — Workspace Admin Setup

> **The two support addresses are on two different platforms.** Verified
> 2026-09-10 from public DNS:
>
> | Address | Platform | Evidence |
> |---|---|---|
> | `support@virgohome.io` | Google Workspace | `MX = aspmx.l.google.com` |
> | `support@lilacomposter.com` | **Microsoft 365** (GoDaddy-federated, Proofpoint filtering) | `MX = *.ppe-hosted.com`; `TXT NETORGFT19578930.onmicrosoft.com`; `autodiscover → autodiscover.outlook.com`; `getuserrealm → Federated, sso.godaddy.com` |
>
> This runbook connects **`support@virgohome.io` only**. Gmail domain-wide
> delegation cannot read a Microsoft mailbox, and the repo has no Microsoft
> Graph integration — connecting `support@lilacomposter.com` is a separate
> build (a `sync-outlook-tickets` function against Graph, plus an Entra app
> registration with `Mail.Read` application permission scoped to that one
> mailbox by an Application Access Policy). Until that exists, the Sales
> communication indicator reads Quo + `support@virgohome.io`, and says so on
> each card.

The [`sync-gmail-tickets`](../supabase/functions/sync-gmail-tickets/index.ts) edge function reads delegated mailboxes via a Google Workspace service account with domain-wide delegation. This runbook captures the one-time setup. The pg_cron job (`sync-gmail-tickets-5min`) calls the function every 5 minutes; until the secrets below are set, the function returns a `skipped` response and does not error.

## Prerequisites

- Google Workspace super-admin access on `virgohome.io`.
- Google Cloud project with billing enabled (or an existing one; you only need the Gmail API enabled and the ability to create a service account).
- Supabase project admin (to add secrets).

## 1. Create the service account

1. Open <https://console.cloud.google.com/> and pick (or create) a project. Note the project ID.
2. **Enable Gmail API:** *APIs & Services → Library → Gmail API → Enable.*
3. **Create service account:** *IAM & Admin → Service Accounts → Create.*
   - Name: `makelila-gmail-sync`
   - Description: `Reads delegated Workspace inboxes for the makelila ticket pipeline`
   - Skip role assignment (this account only acts via delegated user impersonation; no project IAM role needed).
4. **Generate JSON key:** open the service account → *Keys → Add Key → Create new key → JSON*. Save the file securely; you'll base64-encode it in step 4.
5. **Copy the service account's Client ID** (it's a numeric ID on the service account detail page) — you'll need it for step 2.

## 2. Grant domain-wide delegation

1. Open <https://admin.google.com/> as a Workspace super-admin.
2. *Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new.*
3. **Client ID:** the numeric Client ID from step 1.5.
4. **OAuth scopes** (comma-separated, single line):
   ```
   https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify
   ```
   The `gmail.modify` scope is required for applying the `makelila/synced` label. If you want to strictly forbid any write, drop it — labelling will silently fail but reads continue to work.
5. Authorize.

## 3. Pick the delegated mailboxes

For the Sales communication indicator the mailbox that matters is the shared
support inbox:

- `support@virgohome.io`

The original pipeline also listed `huayi@virgohome.io` and `reina@virgohome.io`.
Add them only if you want personal inboxes ingested too — they carry a lot of
non-customer mail, and the indicator does not need them.

The service account will be able to read ANY mailbox in the domain once DWD is
granted; the env var below is what restricts the sync.

**`support@virgohome.io` must be a real mailbox, not a Google Group.** Gmail API
impersonation needs a mailbox; a Group has an archive instead and will fail with
`Precondition check failed` / 404. Check in Admin Console → Directory → Users
(a mailbox) vs Directory → Groups (not usable here). If it is a Group, either
convert it to a shared mailbox or delegate whichever real mailbox receives the
mail.

## 4. Configure Supabase secrets

In the Supabase project dashboard → *Edge Functions → Secrets* (or via CLI), add:

| Name | Required | Value |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | yes | base64 of the JSON file from step 1.4 — `base64 < makelila-gmail-sync.json \| tr -d '\n'` |
| `GMAIL_DELEGATED_MAILBOXES`  | yes | `support@virgohome.io` (comma-separated, no spaces, to add more) |
| `INTERNAL_EMAIL_DOMAINS`     | optional | CSV of domains the team replies from. Defaults to `virgohome.io,lilacomposter.com`. Anything not on this list is treated as the customer speaking — see the warning below. |
| `ANTHROPIC_API_KEY`          | optional | Anthropic API key for the LLM fallback on tickets where rules fall through to `other`. Capped at 20 calls per sync run. If unset, those tickets remain `topic='other'`. |
| `SLACK_TICKET_WEBHOOK_URL`   | optional | Slack incoming webhook URL. Posts a notification when the classifier promotes a ticket to `priority='urgent'` (no notification on manual edits). If unset, no Slack traffic. |

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY` are already available in the edge function environment by default — no action needed.

### Why `INTERNAL_EMAIL_DOMAINS` matters

Message `direction` (inbound = the customer, outbound = us) is what the Sales
communication indicator reads to tell *"the customer asked for a refund"* from
*"we offered a refund"*. Staff answer customers from **both** virgohome.io and
lilacomposter.com addresses, frequently in the same thread. Until 2026-09-10
this check was hardcoded to `@virgohome.io`, so every reply sent from a
lilacomposter.com address was stored as though the customer had written it.
Both domains are now in the default. Add any third domain here before the team
starts replying from it.

## 5. Smoke test

Invoke the function manually:

```sh
curl -X POST \
  -H "Authorization: Bearer <SUPABASE_ANON_KEY>" \
  -H "Content-Type: application/json" \
  https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/sync-gmail-tickets
```

Note the cron path calls this with `X-Cron-Secret`; the curl above uses an
operator JWT. Either is accepted.

Expected response (first run after configuration):

```json
{
  "ok": true,
  "results": [
    { "mailbox": "support@virgohome.io", "bootstrap": true, "threads_processed": 42, ... }
  ]
}
```

If `GOOGLE_SERVICE_ACCOUNT_KEY` or `GMAIL_DELEGATED_MAILBOXES` is unset, you'll get `{ "skipped": true, "reason": "..." }` and a 200 status — the cron job will keep firing harmlessly until you finish setup.

Common errors:

- `unauthorized_client` in the Google token response → the service account's client ID is not authorized for the requested scopes in Admin Console (step 2). Double-check scope spelling.
- `Precondition check failed` from Gmail → DWD propagation can take a few minutes after step 2. Retry after 5 minutes.
- `history.list failed (likely expired startHistoryId)` after >7 days of stalled sync → manually clear the affected row in `gmail_sync_state` (set `last_history_id` to null) and the next run will re-bootstrap.

## 6. Verify in Supabase

After a successful first run, query:

```sql
select mailbox, last_history_id, last_run_at, last_run_status, threads_seen_total
from gmail_sync_state;

select count(*) from service_tickets where source = 'gmail';
select count(*) from ticket_messages;

-- Direction sanity: any of OUR addresses recorded as 'inbound' means
-- INTERNAL_EMAIL_DOMAINS is wrong, and every verdict built on those threads
-- is reading our words as the customer's.
select direction, count(*)
from ticket_messages
where sender ilike '%@virgohome.io%' or sender ilike '%@lilacomposter.com%'
group by 1;
```

Once tickets exist, re-run the communication indicator so the Sales cards pick
the email up (it is otherwise fingerprint-cached):

```sql
select net.http_post(
  url := 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/assess-order-communication',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'X-Cron-Secret', coalesce(private.get_app_secret('cron_shared_secret'), '')),
  body := '{"scope":"pending"}'::jsonb,
  timeout_milliseconds := 240000);
```

The cards' footnote flips from `Support email not connected` to
`Support email (to <date>)` on the next assessment.

Then open the existing Support Tickets tab — gmail tickets appear alongside HubSpot / manual / Calendly ones, with `Source = Gmail` (the UI label may need a one-line addition in PR2/PR3 to display this; see the spec).

## What this does NOT do (yet)

- Classifier / priority / category / summary — landing in **PR2**.
- Dedicated `/tickets` admin page — landing in **PR3**.
- Slack notification on urgent — landing in **PR3**.

See [docs/superpowers/specs/2026-05-19-gmail-ticket-pipeline-design.md](superpowers/specs/2026-05-19-gmail-ticket-pipeline-design.md) for full scope.
