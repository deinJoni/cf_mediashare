# cf-mediashare

Self-hosted, **Cloudflare-native** photo & video sharing for small, trusted groups. Clone it, deploy it into **your own** Cloudflare account, invite your people. No central service, no shared backend.

> Status: **v1 — working MVP.** Upload, browse, view, download, caption, delete — photos and videos, per-group, behind Cloudflare Access. Remaining work (bulk ZIP download, multipart >5 GiB uploads, admin UI) lands phase-by-phase per [`DEVELOPMENT.md`](./DEVELOPMENT.md). Product spec in [`PRD.md`](./PRD.md).

## What you get

- **Private groups** — members only see media in groups they belong to; enforcement lives in the Worker, in front of every byte served.
- **Direct-to-R2 uploads** — the browser generates thumbnails/posters client-side and PUTs straight to R2 via presigned URLs; a 500 MB video never proxies through the Worker. (Without R2 API credentials, uploads transparently fall back to proxying — handy locally.)
- **Fast gallery** — thumbnail grid with infinite scroll, lightbox at display size, original on demand, video seeking via HTTP range requests, immutable edge caching for derivatives.
- **Zero egress cost** — media lives in R2; ~$5/month total (or ~$1.35 on the Workers free tier).

## Architecture

A **single Worker** hosts the API, media serving, access enforcement, **and** serves the built web app as static assets — one `wrangler deploy`, one binding set.

| Concern                  | Cloudflare service        |
| ------------------------ | ------------------------- |
| Frontend + API + serving | Workers (+ static assets) |
| Auth gate                | Access (Zero Trust)       |
| Metadata                 | D1                        |
| Blob storage             | R2 (free egress)          |

Per-group access control: Access verifies _who_ you are (JWT on every request, verified in the Worker against your team's public keys); the Worker resolves your groups from D1 and filters every query and every served byte. Media URLs are useless outside the deployment.

## Layout

```
apps/web         React + Vite frontend (built → served as static assets)
apps/worker      Worker: API, media serving, access enforcement (Hono)
packages/shared  Domain types + Zod API contracts (the web↔worker seam)
migrations       D1 schema
scripts/setup    Provisioning helper (R2 + D1 + CORS + migrations)
wrangler.jsonc   Bindings & vars (no secrets committed)
```

## Quick start (local)

```bash
pnpm install
pnpm migrate:local    # create the local D1 schema
pnpm seed:local       # example groups + members (alice@example.com / bob@example.com)
cp .dev.vars.example .dev.vars
pnpm dev              # web build --watch + wrangler dev (one local origin)
```

Local dev uses an Access **stub** (`DEV_STUB_ACCESS`) so you don't need Zero Trust configured — you browse as `DEV_STUB_EMAIL` (default `alice@example.com`, matching the example seed). In stub mode an `X-Dev-Stub-Email` header switches identity per request, which is handy for testing permissions. Uploads go through the Worker into the local R2 simulator automatically.

## Deploy to your account

The full walkthrough with every dashboard click lives in [`DEPLOY.md`](./DEPLOY.md); this is the shape of it.

**Prerequisites:** a Cloudflare account, Node 20+, pnpm 10+.

```bash
# 1. Provision — R2 bucket + CORS, D1 + migrations; writes the ids into wrangler.jsonc
wrangler login
pnpm install && pnpm setup

# 2. First deploy (gives you the <name>.<subdomain>.workers.dev URL)
pnpm deploy
```

Then three one-time configuration steps:

3. **Gate it with Access** — in [Zero Trust](https://one.dash.cloudflare.com/): add a self-hosted application for your Worker URL, pick a login method (email one-time PIN needs no external keys), allow your members' emails. Copy the app's **AUD tag** and your **team domain** into `wrangler.jsonc` (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`).
4. **R2 credentials for direct uploads** — create an R2 API token (Object Read & Write, scoped to the bucket) and store it: `wrangler secret put R2_ACCESS_KEY_ID` / `wrangler secret put R2_SECRET_ACCESS_KEY`. (Optional — without it, uploads proxy through the Worker.)
5. **Seed your groups & members** — edit a copy of `scripts/setup/seed.example.sql`, then `wrangler d1 execute cf-mediashare-db --remote --file <your-seed.sql>`.

Finish with `pnpm deploy` again to ship the Access config. Total cost: ~$5/month on Workers Paid, or ~$1.35/month on the free tier.

### Deploying with an AI agent

Everything above is CLI- or API-driven, so a coding agent (Claude Code, Cursor, etc.) can run the whole deployment unattended. The only thing you must create by hand is one **bootstrap API token** ([dashboard → API tokens](https://dash.cloudflare.com/profile/api-tokens)) with these account permissions: _Workers Scripts: Edit_, _Workers R2 Storage: Edit_, _D1: Edit_, _Access: Apps and Policies: Edit_ — plus _Account API Tokens: Edit_ if the agent should also mint the R2 upload credentials.

Hand the agent the token and this prompt:

```bash
export CLOUDFLARE_API_TOKEN=<bootstrap token>   # wrangler picks both up automatically —
export CLOUDFLARE_ACCOUNT_ID=<account id>       # no interactive `wrangler login` needed
# "Deploy this repo to my Cloudflare account following DEPLOY.md."
```

What the agent can do non-interactively:

- `pnpm setup` and `pnpm deploy` — wrangler authenticates from the env vars.
- **Access app via API**: `POST /accounts/{account_id}/access/apps` with `type: "self_hosted"`, `domain: "<worker>.workers.dev"`, and an inline policy allowing your member emails; the response carries the **AUD tag**, and `GET /accounts/{account_id}/access/organizations` returns the team domain — both go into `wrangler.jsonc`.
- **R2 S3 credentials via API**: create a bucket-scoped token at `POST /accounts/{account_id}/tokens` — the S3 _access key id_ is the token's `id` and the _secret_ is the SHA-256 hex of the token value — then pipe them into `wrangler secret put`.
- Seed members with `wrangler d1 execute … --remote --file seed.sql` and verify with `curl https://<worker-url>/api/health`.

### Deploy to Cloudflare button

Cloudflare's [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) (`https://deploy.workers.cloudflare.com/?url=<repo>`) can clone a public repo into your account and auto-provision the D1/R2 bindings straight from `wrangler.jsonc`. This repo keeps its wrangler config at the root specifically so that flow has a chance — but monorepo support is officially limited and we haven't certified it, and Access/R2-credentials setup still has to follow afterwards. Treat it as experimental; the wrangler path above is the supported one.

## Scripts

| Command                                  | Does                                   |
| ---------------------------------------- | -------------------------------------- |
| `pnpm dev`                               | Local dev (web watch + `wrangler dev`) |
| `pnpm build`                             | Build all packages                     |
| `pnpm typecheck`                         | Typecheck all packages                 |
| `pnpm lint`                              | Lint all packages                      |
| `pnpm format`                            | Prettier write                         |
| `pnpm setup`                             | Provision R2 + CORS + D1 + migrations  |
| `pnpm migrate:local` / `pnpm seed:local` | Local D1 schema / example data         |
| `pnpm deploy`                            | Build + `wrangler deploy`              |

## License

[MIT](./LICENSE)
