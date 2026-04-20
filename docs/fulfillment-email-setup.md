# Fulfillment Email Setup (Resend)

The "Send email" button in Fulfillment Step 5 invokes a Supabase Edge Function
(`send-fulfillment-email`) that posts to Resend's API using a verified domain.
Sender: `Team Lila <support@lilacomposter.com>`. Reply-To: same.

## 1. Create the Resend account + API key

1. Sign up at https://resend.com (free tier: 3000 emails/month).
2. Go to **Domains → Add domain → lilacomposter.com**.
3. Resend shows 3 DNS records:
   - SPF (TXT)
   - DKIM (CNAME × 2)
4. Add them to GoDaddy DNS for `lilacomposter.com`:
   - GoDaddy admin → Domains → lilacomposter.com → DNS → Add record
   - Copy each record exactly; Resend's UI has a copy button next to each value
5. Wait for propagation (usually <5 min, sometimes up to 1 hour). Click **Verify**.
6. Go to **API Keys → Create API key**. Name it `make-lila`. Copy the `re_...` value (shown once).

## 2. Set Supabase secret + deploy the function

```powershell
cd E:\Claude\makelila
$env:SUPABASE_ACCESS_TOKEN = "<your sbp_ token>"
.\app\node_modules\.bin\supabase.cmd secrets set RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
.\app\node_modules\.bin\supabase.cmd functions deploy send-fulfillment-email --project-ref txeftbbzeflequvrmjjr
```

Expect `Deployed Functions on project ...: send-fulfillment-email`.

## 3. Test

Walk an order through Steps 1–4 locally (or on lila.vip), then click **Send
email** in Step 5. The test customer email (use your own `@virgohome.io`
address as the customer on a seeded order) should arrive within ~1 min.

## Troubleshooting

- **Resend 401**: API key wrong. Re-create and `supabase secrets set` again.
- **Resend 403 / "Domain not verified"**: DNS records haven't propagated or
  weren't added correctly. Re-check in Resend → Domains.
- **Resend 422 / "from address not allowed"**: using a sender that isn't on
  the verified domain. Must be `*@lilacomposter.com`.
- **Edge function 409 "email already sent"**: the queue row's `email_sent_at`
  is populated. Not retriable; the order is already in Step 6.
- **Edge function 409 "US orders require starter_tracking_num"**: Step 5's
  starter-kit field wasn't filled before clicking Send.

## Rotating the API key

Rotate in Resend → API Keys → Revoke + Create new. Then:
```powershell
.\app\node_modules\.bin\supabase.cmd secrets set RESEND_API_KEY=re_<new>
.\app\node_modules\.bin\supabase.cmd functions deploy send-fulfillment-email --project-ref txeftbbzeflequvrmjjr
```
