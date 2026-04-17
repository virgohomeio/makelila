# Supabase Google OAuth Setup

Supabase doesn't natively restrict OAuth sign-ins to a single Google Workspace
domain. This setup gets Google OAuth working end-to-end; the domain restriction
to `@virgohome.io` is enforced client-side in `app/src/lib/auth.tsx` via
`requireInternalDomain()`.

## 1. Create the Google Cloud OAuth client

1. Visit https://console.cloud.google.com/apis/credentials
2. Select (or create) the virgohome.io organization project.
3. **Create Credentials → OAuth client ID**.
4. Application type: **Web application**.
5. Name: `Make Lila — Supabase`.
6. **Authorized redirect URIs** (add both):
   - `https://txeftbbzeflequvrmjjr.supabase.co/auth/v1/callback` — production.
   - `http://localhost:54321/auth/v1/callback` — local dev.
7. Save. Copy the **Client ID** and **Client Secret**.

## 2. Configure Supabase Auth (remote)

1. Go to https://app.supabase.com/project/txeftbbzeflequvrmjjr/auth/providers
2. Enable **Google** provider.
3. Paste Client ID and Client Secret.
4. Under **URL Configuration → Site URL**, set it to the production GitHub Pages
   URL once available (e.g., `https://<owner>.github.io/makelila/`).
5. Under **Redirect URLs**, add the same GitHub Pages URL.
6. Save.

## 3. Configure Supabase Auth (local)

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

Set the env vars and restart the stack:

```bash
export GOOGLE_CLIENT_ID=<your id>
export GOOGLE_CLIENT_SECRET=<your secret>
./app/node_modules/.bin/supabase stop
./app/node_modules/.bin/supabase start
```

(The `env()` substitution is read at stack-start time, not at runtime — restart
is required after changing the secrets.)

## Domain restriction

Supabase does not natively restrict OAuth to a single Google Workspace domain.
We enforce the restriction client-side in `app/src/lib/auth.tsx` by rejecting
sign-ins where `user.email` does not end with `@virgohome.io`. The `hd` query
parameter passed in `signInWithOAuth()` is only a *hint* to Google — it can be
bypassed by an attacker, so client-side verification is still required.

## Rotation

The Client Secret lives in the Supabase dashboard (remote) and in the local env
var (`GOOGLE_CLIENT_SECRET`). To rotate:

1. Generate a new secret in Google Cloud Console.
2. Paste into Supabase dashboard → Auth → Providers → Google.
3. Update local `GOOGLE_CLIENT_SECRET` env var and restart the local stack.
4. Delete the old secret in Google Cloud Console.

No downtime required; Supabase uses the newest secret.

## GitHub deployment secrets

Add these repository secrets at **Settings → Secrets and variables → Actions**:

- `VITE_SUPABASE_URL` — production Supabase project URL (`https://txeftbbzeflequvrmjjr.supabase.co`).
- `VITE_SUPABASE_ANON_KEY` — production Supabase publishable/anon key.

After the first deploy, add the production GitHub Pages URL
(`https://<owner>.github.io/makelila/`) to the Supabase redirect allowlist
(Auth → URL Configuration).
