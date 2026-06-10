# CLAUDE.md

Guidance for working in this repo. Product spec: `PRD.md`. Build plan & phases: `DEVELOPMENT.md`.

## What this is

Self-hosted, Cloudflare-native photo/video sharing for small trusted groups. OSS, clone-and-deploy into your own Cloudflare account. Currently at **v1 — working MVP** (Phases 0–3 complete, plus single-file download, delete, captions, metadata from Phases 4–5). Deferred: bulk ZIP download, multipart upload for >5 GiB files, admin UI (see `DEVELOPMENT.md`).

## Non-obvious conventions

- **One Worker, not two deploys.** `apps/web` builds to static assets served by the _same_ Worker that runs the API (`apps/worker`). `wrangler.jsonc` lives at the repo root; `apps/worker` runs wrangler via `--config ../../wrangler.jsonc`. Don't add a second deploy target.
- **Contracts first.** Shared domain types + Zod API contracts live in `packages/shared` and are the single seam between web and worker. Define/lock contracts there before implementing either side. Phase 2 _locks_ the upload/serve contracts.
- **Access is the only gate.** All `/api/*` requests carry a verified Cloudflare Access JWT (`apps/worker/src/middleware/access.ts`, jose + team JWKS); per-group filtering is enforced explicitly in the Worker (D1 has no row-level security). Local dev uses a stub (`DEV_STUB_ACCESS` in `.dev.vars`); in stub mode an `X-Dev-Stub-Email` request header switches identity per-request for permission testing.
- **Two upload modes, one contract.** `POST /api/uploads/presign` returns direct-to-R2 presigned PUTs when the `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secrets + `CF_ACCOUNT_ID` are set; otherwise it falls back to same-origin `/api/upload-proxy/...` URLs through the Worker (always the case in local dev — miniflare R2 has no S3 endpoint). Clients treat the URLs as opaque.
- **R2 keys never cross the wire.** The client only sees `/api/media/:id/:tier` serve URLs; keys live in D1 rows and `apps/worker/src/lib/keys.ts`.
- **Every phase ships.** Keep PRs phase-scoped (see `DEVELOPMENT.md`); main stays demoable. No long-lived feature branches.
- **No secrets committed.** Config is non-secret `vars` in `wrangler.jsonc`; secrets go via `wrangler secret put` / `.dev.vars` (gitignored).

## Commands

`pnpm dev` (web watch + wrangler dev) · `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm setup` (provision R2+D1+CORS) · `pnpm deploy` · `pnpm migrate:local` + `pnpm seed:local` (local D1; seed pairs with `DEV_STUB_EMAIL=alice@example.com`).
