# cf-mediashare

Self-hosted, **Cloudflare-native** photo & video sharing for small, trusted groups. Clone it, deploy it into **your own** Cloudflare account, invite your people. No central service, no shared backend.

> Status: **Phase 0 — Scaffold.** Deployable skeleton in place. Features land phase-by-phase per [`DEVELOPMENT.md`](./DEVELOPMENT.md). Product spec in [`PRD.md`](./PRD.md).

## Architecture

A **single Worker** hosts the API, media serving, access enforcement, **and** serves the built web app as static assets — one `wrangler deploy`, one binding set.

| Concern | Cloudflare service |
| --- | --- |
| Frontend + API + serving | Workers (+ static assets) |
| Auth gate | Access (Zero Trust) |
| Metadata | D1 |
| Blob storage | R2 (free egress) |

## Layout

```
apps/web         React + Vite frontend (built → served as static assets)
apps/worker      Worker: API, media serving, access enforcement (Hono)
packages/shared  Domain types + Zod API contracts (the web↔worker seam)
migrations       D1 schema
scripts/setup    Provisioning helper (R2 + D1 + migrations)
wrangler.jsonc   Bindings & vars (no secrets committed)
```

## Quick start

```bash
pnpm install          # install workspace deps
pnpm dev              # web build --watch + wrangler dev (one local origin)
```

Local dev uses an Access **stub** (`DEV_STUB_ACCESS`) so you don't need Zero Trust configured — copy `.dev.vars.example` → `.dev.vars` and adjust. Visit the URL wrangler prints; the page shows a live `/api/health` probe.

## Deploy to your account

```bash
wrangler login        # authenticate with your Cloudflare account
pnpm setup            # create R2 bucket + D1 db, write the D1 id, run migrations
pnpm deploy           # build the web app + wrangler deploy
```

Then configure Cloudflare Access in front of the deployment and seed your groups/members — see [`DEPLOY.md`](./DEPLOY.md).

## Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Local dev (web watch + `wrangler dev`) |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm lint` | Lint all packages |
| `pnpm format` | Prettier write |
| `pnpm setup` | Provision R2 + D1 + migrations |
| `pnpm deploy` | Build + `wrangler deploy` |

## License

[MIT](./LICENSE)
