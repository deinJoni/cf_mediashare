# DEVELOPMENT

How this project is built: monorepo layout, tooling, working principles, and the phased plan. Phases are ordered by dependency; each is independently mergeable and demoable.

---

## Tooling

- **Monorepo:** pnpm workspaces + Turborepo
- **Language:** TypeScript end-to-end
- **Platform:** Cloudflare (Workers, D1, R2, Access, Pages/static assets)
- **Deploy:** Wrangler

### Structural decision: one Worker, not two deploys

The frontend build is served as **static assets from the same Worker** that hosts the API and serving logic. This keeps deployment to a single `wrangler deploy`, one binding set, and one thing for adopters to configure — important for a clone-and-go OSS project. Keep web and worker as separate workspace packages for clean boundaries, but ship them as one Worker.

## Layout

```
/apps/web        # frontend (built and served as static assets by the worker)
/apps/worker     # Worker: API, media serving, access enforcement
/packages/shared # domain types + API contracts (the seam between web and worker)
/migrations      # D1 schema + seed
/scripts/setup   # provisioning: create R2 bucket + D1, run migrations
wrangler.jsonc   # bindings & vars (no secrets committed)
```

## Working principles

1. **Contracts first.** Define domain types and API request/response shapes in `packages/shared` before building either side. Web and worker develop in parallel against the same types.
2. **Vertical slice before breadth.** Prove the risky integration (Access JWT → presigned upload → R2 serve) end-to-end in Phase 2 before layering features on top.
3. **Every phase ships.** Each phase merges to main in a demoable state. No long-lived feature branches.
4. **Access is the only gate.** All API/serving requests assume a verified Access JWT; group filtering is enforced in the Worker (D1 has no row-level security).

## Local development

- `pnpm install`
- `pnpm setup` → provisions R2 + D1 in your Cloudflare account, runs migrations + seed
- `pnpm dev` → Turborepo runs web build + `wrangler dev` for the worker
- `pnpm deploy` → single `wrangler deploy`

Cloudflare Access is configured once in the dashboard (or via API) and documented in `DEPLOY.md`; local dev can stub the identity header.

---

## Phase plan

Milestone tags: **M1** = personal MVP, **M2** = OSS-ready, **M3** = optional layers.

### Phase 0 — Scaffold · M1

**Goal:** an empty but deployable skeleton.

- [x] Init pnpm workspaces + Turborepo pipeline (build / typecheck / lint)
- [x] Shared `tsconfig`, eslint, prettier
- [x] `apps/web`, `apps/worker`, `packages/shared` workspaces
- [x] `wrangler.jsonc` with R2 + D1 bindings; worker serves a placeholder page
- [x] `scripts/setup` provisioning script
- [x] CI: typecheck + lint + build on PR

**Accept:** `wrangler deploy` works and serves a placeholder; CI green.

### Phase 1 — Identity & data foundation · M1

**Goal:** the app knows who you are and your groups. _(F1, F2)_
**Depends on:** Phase 0.

- [x] D1 schema + migrations: `users`, `groups`, `memberships`, `media`
- [x] Seed script for initial groups + memberships
- [x] Access configured; Worker JWT-verify middleware (validates against account keys)
- [x] `GET /me` → identity + resolved group memberships
- [x] Web shell: auth-aware, shows current user + their groups

**Accept:** an invited user loads the app and sees their identity/groups; an un-invited email is blocked before any handler.

### Phase 2 — Vertical slice: upload + view one item · M1

**Goal:** upload a photo, see it — architecture proven end-to-end. _(thin F3, F5)_
**Depends on:** Phase 1. **Locks the shared contracts.**

- [x] `POST /uploads/presign` → presigned PUT URLs (group-checked)
- [x] `POST /media` → insert media row after upload
- [x] Web upload component: client-side `thumb` + `display` + video poster generation
- [x] Direct PUT to R2 from the browser
- [x] `GET /media/:id/:size` serve endpoint: JWT + group filter + R2 stream with range support
- [x] Web: render the uploaded image via the serve URL

**Accept:** a photo uploads directly to R2 (bytes do not proxy through the Worker) and renders back through the serve endpoint; cross-group access returns 403.

### Phase 3 — Gallery & viewing · M1

**Goal:** browse and view a real library. _(F4, F5)_
**Depends on:** Phase 2.

- [x] `GET /groups/:id/media` → group-filtered, paginated, newest-first
- [x] Web: per-group thumbnail grid, lazy-loaded, with group switcher
- [x] Lightbox at `display` size; explicit fetch of `original`
- [x] Video player with range-based seeking
- [x] Edge-cache `thumb` + `display` responses

**Accept:** grid loads only thumbnails; lightbox loads display; video seeks without full download.

### Phase 4 — Download · M1

**Goal:** single + bulk download on desktop and mobile. _(F6)_
**Depends on:** Phase 3.

- [x] Single-file download (`Content-Disposition: attachment`)
- [ ] Desktop bulk: client-side streaming ZIP (File System Access API)
- [ ] Mobile bulk: Worker-generated streaming ZIP (store mode) → single URL for the OS download manager
- [ ] Bound archives into chunks for resumability

**Accept:** bulk download incurs no egress charge and does not exhaust Worker memory; mobile download lands in the OS download manager.

### Phase 5 — Manage & robustness · M1 (completes MVP)

**Goal:** full basic feature set. _(F7, F8, full F3)_
**Depends on:** Phase 3.

- [x] Delete: remove D1 row + all R2 keys (original/display/thumb)
- [x] Edit caption
- [ ] Multipart upload for large videos (progress + retry shipped; single PUT covers ≤5 GiB)
- [x] Metadata display (uploader, date, dimensions/duration)
- [x] Empty/error states; mobile responsiveness pass

**Accept:** deletion removes all R2 keys for the item; a 500 MB video uploads with progress and is retryable.

### Phase 6 — OSS readiness · M2

**Goal:** someone else can clone and deploy.
**Depends on:** Phase 5.

- [ ] `README` + `DEPLOY.md` (clone → provision → configure Access → deploy)
- [ ] Scripted, idempotent provisioning with config validation
- [ ] Sensible default vars (size tiers, file types/limits)
- [x] Admin UI for invites + group assignment (members/groups CRUD + membership matrix; optional Cloudflare Access allow-list sync)
- [ ] `LICENSE` (MIT or Apache-2.0) + `CONTRIBUTING.md`

**Accept:** a fresh Cloudflare account goes from clone to working deployment by following `DEPLOY.md` alone.

### Phase 7 — Optional layers · M3

**Goal:** opt-in enhancements; none required for core use.
**Depends on:** Phase 5+.

- [ ] Presence / live sync (Durable Objects via PartyServer): who's viewing, live new-item push
- [ ] Revocable outside-group share links (D1 share record + signed URL), kept separate from in-app viewing
- [ ] Search
- [ ] Cloudflare Images adapter (managed derivatives) / Stream adapter (adaptive video)

---

## Mapping to issues

Each phase is an epic; each checkbox is an issue sized for a single focused session. After Phase 1 locks the `packages/shared` contracts, the web and worker tasks within Phases 2–5 can proceed in parallel. Keep PRs phase-scoped so main stays demoable.
