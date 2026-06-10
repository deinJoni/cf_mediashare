# Deploy guide

Clone → working deployment in your own Cloudflare account. (Polished further in Phase 6 — OSS readiness.)

## Prerequisites

- A Cloudflare account.
- Node 20+ and pnpm 10+.
- `wrangler login` completed (or `CLOUDFLARE_API_TOKEN` exported).

## 1. Provision resources

```bash
pnpm install
pnpm setup
```

This creates the R2 bucket and D1 database, applies the bucket CORS rules needed for direct browser→R2 uploads, writes the D1 `database_id` and your `CF_ACCOUNT_ID` into `wrangler.jsonc`, and runs migrations. Idempotent — re-run it safely. Add `--local` to also migrate the local dev D1, or `--origin https://your-app.example.com` to pin upload CORS to your app origin instead of `*`.

## 2. Configure Cloudflare Access

In the [Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. **Access → Applications → Add a self-hosted application** pointing at your Worker's URL (`<name>.<subdomain>.workers.dev` or your custom domain).
2. Choose a login method:
   - **Email one-time PIN** — no external key needed.
   - **Google / GitHub** — needs your own OAuth app credentials.
3. Add a policy allowing your members' emails.
4. Copy the application's **Audience (AUD) tag** and your **team domain** into `wrangler.jsonc`:

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
  "ACCESS_AUD": "<audience-tag>",
  ...
}
```

The Worker verifies the per-request Access JWT (issuer, audience, expiry) against your team's public keys — this is the only gate. An email that passes Access but isn't in the `users` table still gets a 403.

## 3. R2 credentials for direct uploads

Uploads go **directly from the browser to R2** via presigned URLs, so the Worker needs an R2 API token to sign them:

1. Dashboard → **R2 → Manage API tokens → Create API token** — permission **Object Read & Write**, scoped to the `cf-mediashare-media` bucket.
2. Store the credentials as Worker secrets:

```bash
pnpm exec wrangler secret put R2_ACCESS_KEY_ID
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
```

This step is technically optional: without the secrets, uploads transparently fall back to proxying through the Worker (group-checked either way). Set them so large videos never transit the Worker.

## 4. Seed your first admin (then manage members in-app)

You only need to seed enough to bootstrap **one admin** — after that, the in-app **Admin** screen handles invites, group assignment, and removals (see §6).

```bash
cp scripts/setup/seed.example.sql scripts/setup/seed.sql
# edit seed.sql: at minimum, one group and yourself with is_admin = 1 (the operator)
pnpm exec wrangler d1 execute cf-mediashare-db --remote --file scripts/setup/seed.sql
```

Emails must match what members sign in to Access with (matching is case-insensitive). `is_admin = 1` users can delete/recaption anyone's media **and** reach the Admin screen; everyone else manages only their own uploads.

## 5. Deploy

```bash
pnpm deploy
```

Visit the Worker URL — Access should challenge you, and after signing in you'll land in your gallery.

## 6. Manage members & groups (Admin UI)

Once an admin is signed in, an **Admin** link appears in the top bar (admins only). It manages everything that used to need a seed edit:

- **Invite / remove members**, toggle who's an admin.
- **Create / rename / delete groups.** Deleting a group or a member also deletes the media scoped to them (rows **and** R2 blobs).
- **Assign members to groups** via a members × groups checkbox matrix.

The app's two membership layers stay distinct: D1 (which the Worker enforces on every request — the authoritative gate) and the **Cloudflare Access allow-list** (the outer gate that decides who can load the app at all). By default the Admin UI edits D1 only and reminds you to keep the Access policy in step by hand.

### Optional: sync invites into Cloudflare Access automatically

Give the Worker a Cloudflare API token and the Admin UI will push invites/removals into your Access policy's allow-list too — one place to invite, and a per-member badge flags anyone whose D1 membership and Access entry have drifted apart.

1. Dashboard → **API tokens → Create token** with permission **Access: Apps and Policies: Edit** (account-scoped).
2. Store it as a Worker secret:

   ```bash
   pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN
   ```

The Worker finds your Access app by matching `ACCESS_AUD` and edits the first `allow` policy (the one `DEPLOY.md` provisions). If that app has **several** allow policies, pin the target by setting `ACCESS_APP_ID` / `ACCESS_POLICY_ID` in `wrangler.jsonc`. Sync only manages **individually-listed** emails — members allowed via a domain or "everyone" rule are left untouched. A sync failure never blocks the membership change (D1 is authoritative); the UI surfaces a warning so you can reconcile in the dashboard.

## Appendix: fully scripted deploys (CI or AI agents)

Every step above is CLI- or API-driven, so the whole deployment can run unattended — in CI, or by handing this guide to a coding agent. The single manual prerequisite is a **bootstrap API token** ([dashboard → API tokens](https://dash.cloudflare.com/profile/api-tokens)) with account permissions: _Workers Scripts: Edit_, _Workers R2 Storage: Edit_, _D1: Edit_, _Access: Apps and Policies: Edit_, and — only if step 3 should be automated too — _Account API Tokens: Edit_.

```bash
export CLOUDFLARE_API_TOKEN=<bootstrap token>
export CLOUDFLARE_ACCOUNT_ID=<account id>
```

Wrangler reads both [environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) automatically — `pnpm setup`, `pnpm deploy`, `wrangler d1 execute`, and `wrangler secret put` (which accepts the value on stdin) all work without `wrangler login`.

**Step 2 (Access) via API** — create the app with an inline allow-list policy; the response carries the `aud` tag:

```bash
# team domain for ACCESS_TEAM_DOMAIN:
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/organizations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" # → result.auth_domain

# the app; response → result.aud goes into ACCESS_AUD:
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{
    "type": "self_hosted",
    "name": "cf-mediashare",
    "domain": "<worker-name>.<subdomain>.workers.dev",
    "policies": [{
      "name": "members",
      "decision": "allow",
      "precedence": 1,
      "include": [{ "email": { "email": "alice@example.com" } },
                  { "email": { "email": "bob@example.com" } }]
    }]
  }'
```

**Step 3 (R2 credentials) via API** — [R2's S3 credentials are derived from an API token](https://developers.cloudflare.com/r2/api/tokens/): create a bucket-scoped token via `POST /accounts/{account_id}/tokens` (permission group _Workers R2 Storage Bucket Item Write_, scoped to `cf-mediashare-media`); then the S3 **access key id** is the token's `id` and the **secret access key** is the SHA-256 hex of the token's `value`:

```bash
printf '%s' "$TOKEN_ID"                                   | pnpm exec wrangler secret put R2_ACCESS_KEY_ID
printf '%s' "$TOKEN_VALUE" | shasum -a 256 | cut -d' ' -f1 | pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
```

Finish with `pnpm deploy` (ships the Access vars) and verify with `curl https://<worker-url>/api/health`.

> There is also a [Deploy to Cloudflare button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) flow that auto-provisions D1/R2 from `wrangler.jsonc` for public repos — monorepo support is limited and untested here, and Access/R2 setup still applies afterwards. Experimental.

## Costs

~$5–7/month per deployment (Workers Paid). Can run ~$1.35/month on Workers Free if server-side bulk-zip and presence aren't used. See PRD §9.
