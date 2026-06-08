# Hand-off: lilalovely → makelila customer-events integration

**To:** Ryan Yuan
**From:** Huayi
**Date:** 2026-06-07
**Repo:** `virgohomeio/beta-lovely`
**Companion spec:** [docs/integration-lilalovely-2026-06-07.md](integration-lilalovely-2026-06-07.md) (lives in makelila repo)

## What's already shipped on the makelila side

1. **DB tables** in makelila Supabase project (`txeftbbzeflequvrmjjr`):
   - `public.customer_app_links` — maps your `users.id` (lovely auth UUID) to a makelila `customers.id`. Resolution via serial → email → unresolved.
   - `public.customer_events` — append-only event stream. Indexed by `(customer_id, occurred_at desc)` for fast per-customer timeline reads.
   - `public.customer_engagement_summary` — view that rolls up dormancy_days, events_7d, events_30d, etc.
2. **Edge function** `ingest-lovely-event` deployed at:
   ```
   POST https://txeftbbzeflequvrmjjr.functions.supabase.co/ingest-lovely-event
   ```
3. **UI** — every customer detail panel in makelila Customers module shows a "Lila app activity" section (engagement summary + timeline of last 8 events + dormancy badge in the title). JourneyTab cards show a small dormancy pill (active / Nd quiet / Nd dormant).

Nothing has flowed yet — the section says "Not yet signed up for the lilalovely app" until the first event arrives.

## What I need from you

### 1. Shared secret

We use `X-Lovely-Secret` header auth on the ingest endpoint (no JWT — makes cross-project calls simpler). George needs to generate a strong random secret and set it as an env var on BOTH Supabase projects:

```bash
# Generate (any 64-char hex is fine)
openssl rand -hex 32

# Set on makelila (recipient) — George does this via Supabase CLI or dashboard
npx supabase secrets set --project-ref txeftbbzeflequvrmjjr \
  LOVELY_INGEST_SECRET=<the-secret>

# Set on lovely (sender) — you do this:
npx supabase secrets set --project-ref arfdopgbvlfmhmcfghhl \
  MAKELILA_INGEST_SECRET=<the-same-secret>
```

Don't paste the secret value in chat / commit messages / docs. Pass it via clipboard or 1Password.

### 2. Webhook payload contract

POST to `https://txeftbbzeflequvrmjjr.functions.supabase.co/ingest-lovely-event` with:

```http
POST /ingest-lovely-event
Content-Type: application/json
X-Lovely-Secret: <the-shared-secret>

{
  "event_type": "lovely.onboarding_step",
  "lovely_user_id": "auth-users-uuid-here",
  "lovely_email": "ryan@example.com",     // optional but always send if you have it
  "serial_number": "LL01-00000000123",    // optional; sent post-pairing
  "occurred_at": "2026-06-08T01:23:45Z",  // optional; defaults to now()
  "payload": {                             // optional event-specific data
    "from": "welcome_done",
    "to": "quiz_done"
  }
}
```

The ingest function responds with:
```json
{ "ok": true, "resolution": "serial" | "email" | "unresolved",
  "customer_id": "uuid-or-null", "event_type": "lovely.onboarding_step" }
```

`200` = accepted (even if `resolution: "unresolved"` — those events are still saved and can be back-resolved when the user pairs).
`400` = bad payload (missing event_type or lovely_user_id).
`401` = bad secret.
`500` = transient DB error — safe to retry.

### 3. Event types to emit (V1)

| Event | When | Payload | Owner |
|---|---|---|---|
| `lovely.signup` | new `users` row created | `{ first_name, last_name }` | trigger on `public.users` insert |
| `lovely.serial_paired` | `users.serial_number` first becomes non-null | `{ serial_number }` | trigger on `public.users` update |
| `lovely.onboarding_step` | `users.onboarding_step` changes | `{ from, to }` | trigger on `public.users` update |
| `lovely.onboarding_done` | `onboarding_step` becomes `tour_done` | `{ first_use_ms_after_signup }` | same trigger above |
| `lovely.damage_report` | new `damage_reports` row | `{ notes_present, photo_count }` | trigger on `damage_reports` |
| `lovely.ota_accepted` | new `ota_acceptances` row | `{ ota_version }` | trigger on `ota_acceptances` |
| `lovely.push_opt_in` | new `push_subscriptions` row | `{}` | trigger on `push_subscriptions` |
| `lovely.push_opt_out` | `push_subscriptions` row deleted | `{}` | trigger on `push_subscriptions` delete |
| `lovely.dashboard_open` | `/dashboard` rendered (debounce ≥ 10min) | `{}` | client-side `fetch` from a `useEffect` |
| `lovely.batch_complete_seen` | user opens `/chambers` after `compost_batches.completed_at` | `{ batch_id }` | client-side, on chamber view if active batch completed but not yet acknowledged |
| `lovely.dormancy_30d` | scheduled scan: no login for 30+ days | `{ days_since_last_login }` | nightly pg_cron on `users.last_login_at` |
| `lovely.dormancy_60d` | scheduled scan: no login for 60+ days | `{}` | same nightly pg_cron |

### 4. Recommended emit mechanism

**Postgres trigger + edge function (preferred for DB-mutated events).** Cleanest pattern:

```sql
-- In lovely's Supabase project (arfdopgbvlfmhmcfghhl):
-- 1. Create a helper that fires the webhook async.
create or replace function fire_makelila_event(
  p_user_id uuid,
  p_event_type text,
  p_serial text,
  p_email text,
  p_payload jsonb
) returns void
language plpgsql
security definer
as $$
declare
  v_secret text := current_setting('app.makelila_ingest_secret', true);
begin
  perform net.http_post(
    url := 'https://txeftbbzeflequvrmjjr.functions.supabase.co/ingest-lovely-event',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Lovely-Secret', v_secret
    ),
    body := jsonb_build_object(
      'event_type', p_event_type,
      'lovely_user_id', p_user_id,
      'lovely_email', p_email,
      'serial_number', p_serial,
      'occurred_at', now(),
      'payload', coalesce(p_payload, '{}'::jsonb)
    )
  );
exception when others then
  raise warning 'fire_makelila_event failed: %', sqlerrm;
end;
$$;

-- 2. Trigger on users signup.
create or replace function on_lovely_user_signup() returns trigger
language plpgsql security definer as $$
begin
  perform fire_makelila_event(
    new.id, 'lovely.signup', new.serial_number, new.email,
    jsonb_build_object('first_name', new.first_name, 'last_name', new.last_name)
  );
  return new;
end;
$$;

drop trigger if exists trg_lovely_signup on public.users;
create trigger trg_lovely_signup
  after insert on public.users
  for each row execute function on_lovely_user_signup();

-- 3. Trigger on onboarding_step + serial_number changes.
create or replace function on_lovely_user_update() returns trigger
language plpgsql security definer as $$
begin
  if (old.serial_number is null and new.serial_number is not null) then
    perform fire_makelila_event(
      new.id, 'lovely.serial_paired', new.serial_number, new.email,
      jsonb_build_object('serial_number', new.serial_number)
    );
  end if;
  if (coalesce(old.onboarding_step,'') <> coalesce(new.onboarding_step,'')) then
    perform fire_makelila_event(
      new.id, 'lovely.onboarding_step', new.serial_number, new.email,
      jsonb_build_object('from', old.onboarding_step, 'to', new.onboarding_step)
    );
    if (new.onboarding_step = 'tour_done') then
      perform fire_makelila_event(
        new.id, 'lovely.onboarding_done', new.serial_number, new.email,
        jsonb_build_object()
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_lovely_user_update on public.users;
create trigger trg_lovely_user_update
  after update on public.users
  for each row execute function on_lovely_user_update();
```

Same pattern for `damage_reports`, `ota_acceptances`, `push_subscriptions`.

Requires the `pg_net` extension to be enabled in lovely's project (Dashboard → Database → Extensions → search `pg_net` → enable).

The secret is read via `current_setting('app.makelila_ingest_secret', true)` — set it once at the project level:
```sql
alter database postgres set app.makelila_ingest_secret = '<the-secret>';
```

**Client-side POST (for engagement-only events).** For `lovely.dashboard_open` and `lovely.batch_complete_seen`, the client fetches:

```ts
// in app/dashboard/page.tsx (or a layout)
useEffect(() => {
  const last = localStorage.getItem('mk_dashboard_open_at');
  const now = Date.now();
  if (last && now - Number(last) < 10 * 60 * 1000) return; // debounce 10min
  localStorage.setItem('mk_dashboard_open_at', String(now));
  fetch('/api/lovely-event', {
    method: 'POST',
    body: JSON.stringify({ event_type: 'lovely.dashboard_open' }),
  });
}, []);
```

Then a thin `/api/lovely-event` Next.js route reads the user session, attaches `lovely_user_id` + `email` + `serial_number`, and POSTs to the makelila ingest endpoint with the secret (which lives server-side in lovely's env).

### 5. Testing

After setting the secret on both projects + deploying one trigger:

```bash
# Smoke test: create a fake user signup or call the helper directly:
psql "$LOVELY_DB_URL" -c "select fire_makelila_event(
  '00000000-0000-0000-0000-000000000001'::uuid,
  'lovely.test',
  'LL01-00000000999',
  'test@example.com',
  '{\"hello\": \"world\"}'::jsonb
);"

# Then on makelila side (Supabase MCP / SQL editor):
select * from public.customer_events order by ingested_at desc limit 5;
```

Should see your test event. If `customer_id` is null, the serial/email didn't resolve to a known makelila customer — expected for the fake UUID. Once you run the test with a real existing makelila customer's serial (e.g. one of Junaid's units), `resolution` should come back as `'serial'`.

### 6. Open V2 thread — operator-fires-push

Confirmed scope for the next ship. We want makelila operators to be able to send a push notification through your app — e.g. Junaid clicks "Send push" on a ticket and Cheryl gets "Your replacement chamber shipped".

Endpoint shape we'd hit (your side):
```http
POST /api/admin/push
Content-Type: application/json
X-Lovely-Secret: <same shared secret>

{ "serial_number": "LL01-...", "title": "...", "body": "...", "url": "/chambers" }
```

You'd authenticate the secret, look up the user(s) for that serial via `users.serial_number`, fan-out to their `push_subscriptions` using your existing `web-push` infra, return `{ ok: true, recipients: N }`.

makelila side will get a "Send push" button on Service ticket details + Customer detail panel in a follow-up commit once we agree on the shape.

### 7. Anything to flag

- Privacy posture: low concern (covered by standard "we use usage data to operate and improve the service" policy language). George should give the privacy policy a 5-min read to confirm that line exists.
- Email reliability: confirmed by Huayi that lovely emails = Shopify customer emails, so the email-fallback resolver is deterministic.
- Once events are flowing, we can collaborate on adding `lovely.churn_signal` heuristics (damage report + unresolved + dormant for 60d) and a `OperatorContactCard` widget that shows your push opt-in status + last engagement on every Service ticket.

Ping me on Slack or in this repo when you've enabled `pg_net` + landed the signup trigger; I'll send a fake signup to verify the chain end-to-end.
