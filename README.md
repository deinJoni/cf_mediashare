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

```bash
wrangler login        # authenticate with your Cloudflare account
pnpm setup            # R2 bucket + CORS + D1 + migrations; writes ids into wrangler.jsonc
pnpm deploy           # build the web app + wrangler deploy
```

Then configure Cloudflare Access in front of the deployment, add the R2 upload credentials, and seed your groups/members — the whole walkthrough is in [`DEPLOY.md`](./DEPLOY.md).

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
