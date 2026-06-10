# Deploy guide

Clone → working deployment in your own Cloudflare account. (Filled out further in Phase 6 — OSS readiness.)

## Prerequisites

- A Cloudflare account.
- Node 20+ and pnpm 10+.
- `wrangler login` completed (or `CLOUDFLARE_API_TOKEN` exported).

## 1. Provision resources

```bash
pnpm install
pnpm setup        # creates the R2 bucket + D1 db, writes the D1 id into wrangler.jsonc, runs migrations
```

`pnpm setup` is idempotent — re-run it safely. Add `--local` to also set up the local dev D1.

## 2. Configure Cloudflare Access

In the Zero Trust dashboard:

1. **Access → Applications → Add a self-hosted application** pointing at your Worker's URL/route.
2. Choose a login method:
   - **Email one-time PIN** — no external key needed.
   - **Google / GitHub** — needs your own OAuth app credentials.
3. Add a policy allowing your members' emails.
4. Note the application's **Audience (AUD) tag** and your **team domain**, and set them in `wrangler.jsonc` (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`).

The Worker verifies the per-request Access JWT against your team's public keys — this is the only gate. (JWT verification lands in Phase 1; until then the dev stub is used.)

## 3. Seed groups & members

```bash
cp scripts/setup/seed.example.sql scripts/setup/seed.sql
# edit seed.sql with your real groups + member emails
wrangler d1 execute cf-mediashare-db --remote --file scripts/setup/seed.sql
```

## 4. Deploy

```bash
pnpm deploy
```

## Costs

~$5–7/month per deployment (Workers Paid). Can run ~$1.35/month on Workers Free if server-side bulk-zip and presence aren't used. See PRD §9.
