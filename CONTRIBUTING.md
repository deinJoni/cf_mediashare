# Contributing

Thanks for helping improve cf-mediashare. This file covers the dev loop and the conventions that keep the codebase coherent — for the full build plan see `DEVELOPMENT.md`, for product intent see `PRD.md`.

## Dev loop

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm migrate:local && pnpm seed:local
pnpm dev          # → http://localhost:8787 (web watch-build + wrangler dev, one origin)
```

Local identity is stubbed (`DEV_STUB_ACCESS`), so no Zero Trust setup is needed: you browse as `DEV_STUB_EMAIL` (`alice@example.com` matches the example seed). Sending `X-Dev-Stub-Email: <email>` on a request switches identity per-request — handy for exercising the permission matrix (alice is an admin in both groups; bob is a plain member of `family` only).

## Conventions

- **Contracts first.** API request/response shapes live in `packages/shared` as Zod schemas; both web and worker consume them. Adding or changing an endpoint means updating the schema and the endpoint-map comment first. The Phase-2 upload/serve contracts are locked — additive changes only.
- **Access is the only gate.** Every `/api/*` route runs the Access middleware + member middleware; per-group authorization uses `isMember()` explicitly, and a nonexistent group must answer identically to one you're not in (403 — group existence is not probeable).
- **R2 keys never cross the wire.** Clients see `/api/media/:id/:tier` URLs only; keys live in D1 rows and `apps/worker/src/lib/keys.ts`.
- **One Worker.** The web build is served as static assets by the same Worker that runs the API — never add a second deploy target.
- **Explicit cascades.** Delete dependent D1 rows via `db.batch()` yourself; D1 doesn't reliably enforce `ON DELETE CASCADE`. Purge R2 blobs too (`lib/r2.ts` chunks the 1000-key delete limit).
- **No secrets in the repo.** `wrangler.jsonc` `vars` are non-secret config only; secrets go through `wrangler secret put` / `.dev.vars` (gitignored).

## Verifying changes

`pnpm typecheck && pnpm lint && pnpm build` — the same three gates CI runs. For API behavior, the local loop above plus `curl` against the stub identity covers most of it; seed extra rows and objects with `wrangler d1 execute cf-mediashare-db --local --command ...` and `wrangler r2 object put <bucket>/<key> --local --file ...`.

## PRs

Phase-scoped and each independently mergeable — main stays deployable at all times. See `DEVELOPMENT.md` for the phase plan and milestone tags.
