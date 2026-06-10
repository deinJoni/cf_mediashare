# CLAUDE.md

Guidance for working in this repo. Product spec: `PRD.md`. Build plan & phases: `DEVELOPMENT.md`.

## What this is

Self-hosted, Cloudflare-native photo/video sharing for small trusted groups. OSS, clone-and-deploy into your own Cloudflare account. Currently at **Phase 0 — Scaffold**.

## Non-obvious conventions

- **One Worker, not two deploys.** `apps/web` builds to static assets served by the *same* Worker that runs the API (`apps/worker`). `wrangler.jsonc` lives at the repo root; `apps/worker` runs wrangler via `--config ../../wrangler.jsonc`. Don't add a second deploy target.
- **Contracts first.** Shared domain types + Zod API contracts live in `packages/shared` and are the single seam between web and worker. Define/lock contracts there before implementing either side. Phase 2 *locks* the upload/serve contracts.
- **Access is the only gate.** All `/api/*` requests assume a verified Cloudflare Access JWT; per-group filtering is enforced explicitly in the Worker (D1 has no row-level security). Local dev uses a stub (`DEV_STUB_ACCESS` in `.dev.vars`); real JWT verification lands in Phase 1 (`apps/worker/src/middleware/access.ts`).
- **Every phase ships.** Keep PRs phase-scoped (see `DEVELOPMENT.md`); main stays demoable. No long-lived feature branches.
- **No secrets committed.** Config is non-secret `vars` in `wrangler.jsonc`; secrets go via `wrangler secret put` / `.dev.vars` (gitignored).

## Commands

`pnpm dev` (web watch + wrangler dev) · `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm setup` (provision R2+D1) · `pnpm deploy`.
