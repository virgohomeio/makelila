# Supabase Google OAuth Setup

Supabase doesn't natively restrict OAuth sign-ins to a single Google Workspace
domain. This setup gets Google OAuth working end-to-end; the domain restriction
to `@virgohome.io` is enforced client-side in `app/src/lib/auth.tsx` via
`requireInternalDomain()`.

## Credentials reference

| Value | Where it lives | Committed? |
|---|---|---|
| **GCP project** | `lila-api-393822` | yes (below) |
| **Client ID** | `493068277113-90u9btifn2fv045m10knegb268helkmv.apps.googleusercontent.com` | yes (below) |
| **Client Secret** | Local: `GOOGLE_CLIENT_SECRET` env var · Remote: Supabase dashboard · CI: not needed | **no — never commit** |

## 1. Google Cloud OAuth client

Already configured in the `lila-api-393822` GCP project. Client ID above.

**Authorized JavaScript origins** (configured):
- `http://localhost:5173` — Vite dev server
- `https://virgohomeio.github.io` — GitHub Pages
- `https://lila.vip` — legacy (kept for earlier tool)

**Authorized redirect URIs** (configured):
- `http://localhost:54321/auth/v1/callback` — local Supabase auth
- `https://txeftbbzeflequvrmjjr.supabase.co/auth/v1/callback` — remote Supabase auth

Console: https://console.cloud.google.com/apis/credentials?project=lila-api-393822

## 2. Supabase Auth (remote)

1. Go to https://app.supabase.com/project/txeftbbzeflequvrmjjr/auth/providers
2. Enable **Google** provider.
3. Paste the **Client ID** above and the **Client Secret** from your password manager.
4. Under **URL Configuration → Site URL**: `https://lila.vip/`.
5. Under **Redirect URLs**: add the same URL.
6. Save.

## 3. Supabase Auth (local)

The local CLI reads OAuth credentials from env vars. The relevant block in
`supabase/config.toml` is already in place:

```toml
[auth.external.google]
enabled = true
client_id = "env(GOOGLE_CLIENT_ID)"
secret = "env(GOOGLE_CLIENT_SECRET)"
redirect_uri = "http://localhost:54321/auth/v1/callback"
skip_nonce_check = true
```

Set both env vars (bash) and restart the stack:

```bash
export GOOGLE_CLIENT_ID=493068277113-90u9btifn2fv045m10knegb268helkmv.apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET=<paste from password manager>
./app/node_modules/.bin/supabase stop
./app/node_modules/.bin/supabase start
```

`env()` substitution is read at stack-start time, not at runtime — restart is
required after changing the secrets.

## Domain restriction

Supabase does not natively restrict OAuth to a single Google Workspace domain.
We enforce the restriction client-side in `app/src/lib/auth.tsx` by rejecting
sign-ins where `user.email` does not end with `@virgohome.io`. The `hd` query
parameter passed in `signInWithOAuth()` is only a *hint* to Google — it can be
bypassed by an attacker, so client-side verification is still required.

## Rotation

To rotate the Client Secret (do this any time the secret leaks — including if
it was pasted into a chat or ticket):

1. Generate a new secret in Google Cloud Console → Credentials → Make Lila client.
2. Paste into Supabase dashboard → Auth → Providers → Google.
3. Update local `GOOGLE_CLIENT_SECRET` env var and restart the local stack.
4. Delete the old secret in Google Cloud Console.

No downtime required; Supabase uses the newest secret.

## GitHub deployment secrets

Add these repository secrets at **Settings → Secrets and variables → Actions**:

- `VITE_SUPABASE_URL` — `https://txeftbbzeflequvrmjjr.supabase.co`.
- `VITE_SUPABASE_ANON_KEY` — production Supabase publishable/anon key.

The Google Client Secret does **not** need to be in GitHub — auth happens
through the remote Supabase project, which already holds the secret.
