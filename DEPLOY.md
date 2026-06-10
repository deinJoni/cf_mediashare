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

## 4. Seed groups & members

```bash
cp scripts/setup/seed.example.sql scripts/setup/seed.sql
# edit seed.sql: your groups, member emails, and is_admin = 1 for yourself (the operator)
pnpm exec wrangler d1 execute cf-mediashare-db --remote --file scripts/setup/seed.sql
```

Emails must match what members sign in to Access with (matching is case-insensitive). `is_admin = 1` users can delete/recaption anyone's media; everyone else manages only their own uploads.

## 5. Deploy

```bash
pnpm deploy
```

Visit the Worker URL — Access should challenge you, and after signing in you'll land in your gallery.

## Costs

~$5–7/month per deployment (Workers Paid). Can run ~$1.35/month on Workers Free if server-side bulk-zip and presence aren't used. See PRD §9.
