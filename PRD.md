# PRD — Self-Hosted Photo & Video Sharing (OSS, Cloudflare-native)

_Working name: `<project>` (rename on adoption). Status: draft. Target v1 platform: Cloudflare. Last updated: June 2026._

---

## 1. Overview

An open-source, self-deployable photo and video sharing app for small, trusted groups. Anyone can clone the repo and deploy it into **their own Cloudflare account** — no central service, no shared backend, no vendor lock-in beyond Cloudflare itself. Each deployment is fully owned by the person who runs it; they bring their own account and credentials ("bring your own key").

The first release targets the author's personal usage: a single all-Cloudflare deployment serving ~10 known users across 2 groups, ~100 GB of media. OSS polish (one-command setup, docs, optional UI for admin) follows once the core works.

This is **not** a hosted SaaS. There is no multi-tenant operator; every user is also their own operator.

## 2. Goals & Non-Goals

### Goals

- Clone → deploy to your own Cloudflare account in well under an hour.
- Private media sharing within groups, gated to known identities.
- Zero egress cost on media (R2), low flat monthly cost per deployment.
- Single platform (Cloudflare) with native service bindings — no cross-vendor credentials.
- Sensible, documented configuration; secrets stay in the deployer's account.

### Non-Goals (v1)

- No public/anonymous sharing or unauthenticated links.
- No multi-tenant hosting / no central operator.
- No social features (likes/follows), no AI search/faces.
- No mobile-native app (responsive web only).
- No non-Cloudflare deployment target (may come later via adapters).

## 3. Personas

- **Operator/Deployer** — technical; clones the repo, owns a Cloudflare account, provisions resources, invites users. (v1: the author.)
- **Member** — invited end user; uploads, browses, views, downloads media within their group(s). Non-technical.

## 4. Deployment Model (BYO Cloudflare account)

A deployer needs only a **Cloudflare account**. Provisioning is the standard Cloudflare set:

1. Clone the repo.
2. Create the resources (scripted via Wrangler): an **R2 bucket**, a **D1 database**, a **Worker**, a **Pages** project.
3. Configure **Cloudflare Access** in front of the app: add the app, choose a login method (email one-time-PIN needs no external key; Google/GitHub login needs the deployer's own OAuth app), and add the allowed member emails.
4. Run D1 migrations and seed groups + memberships.
5. `wrangler deploy` the Worker and Pages build.

"Bring your own key" in practice means: **your own Cloudflare account**, and — only if you choose social login over email OTP — **your own OAuth app credentials**. Storage and DB use native Worker bindings, so there are no long-lived storage API keys to manage.

## 5. Functional Requirements (basic feature set)

### F1. Access & authentication

- App is gated by Cloudflare Access; only allowed identities can load it.
- Every request carries a verifiable Access JWT; the Worker derives the member's email from it.
- _Accept:_ an un-invited email cannot reach any media or API.

### F2. Users & groups

- Groups are data (D1 rows), not hardcoded; a deployment can have N groups.
- Members map to one or more groups via a `memberships` table.
- v1: seeded via migration/config. Later: minimal admin UI to invite + assign.
- _Accept:_ a member sees only media in groups they belong to.

### F3. Upload

- Upload photos and videos from desktop and mobile web.
- Client generates `thumb` (~300px) and `display` (~1600px) for images and a poster frame for videos before upload.
- Files go **directly to R2** via presigned PUT (multipart for large videos); only metadata round-trips through the Worker.
- Upload progress shown; failed uploads are retryable.
- _Accept:_ a 500 MB video uploads without proxying bytes through the Worker.

### F4. Browse / gallery

- Per-group grid of thumbnails, newest first, lazy-loaded.
- Switch between the groups the member belongs to.
- _Accept:_ grid loads only thumbnails, never originals.

### F5. View / playback

- Lightbox shows the `display` size; explicit action fetches the true `original`.
- Video plays with HTTP range support (seeking, progressive playback).
- _Accept:_ seeking a video does not download the whole file first.

### F6. Download

- Single-file download of the original.
- Bulk "download all / download selection":
  - Desktop: client-side streaming ZIP to disk.
  - Mobile: Worker-generated single streaming ZIP (store mode) handed to the OS download manager; archives bounded into chunks for resumability.
- _Accept:_ bulk download incurs no egress charge and does not exhaust Worker memory.

### F7. Manage / delete

- Uploader (and operator) can delete a media item; deletes the D1 row and all R2 keys for that item.
- Edit caption.
- _Accept:_ deletion removes original, display, and thumb from R2.

### F8. Metadata

- Per item: group, uploader, kind, dimensions/duration, caption, created date.

## 6. Architecture & Stack

| Concern                   | Cloudflare service            | Role                                                               |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| Frontend hosting          | Pages                         | Serves the web app                                                 |
| Auth                      | Access (Zero Trust)           | Gates app to invited identities; issues per-request JWT            |
| Compute / API             | Workers                       | Serving, access enforcement, metadata API; native R2 + D1 bindings |
| Metadata DB               | D1                            | Users, groups, memberships, media                                  |
| Blob storage              | R2                            | Originals + derived sizes; free egress                             |
| (Optional) thumbnails     | Images                        | On-the-fly resizing if client-side generation is dropped           |
| (Optional) video at scale | Stream                        | Adaptive bitrate if direct MP4 is outgrown                         |
| (Optional) presence       | Durable Objects / PartyServer | Live "who's viewing", live new-item push                           |

### Access-control model

1. **Org gate (Access):** only invited identities load the app.
2. **Per-group enforcement (Worker + D1):** Worker verifies the JWT, resolves the member's groups, and filters all queries/serving to those groups. D1 has no row-level security, so this filter lives explicitly in the Worker — the single trusted enforcement point.

Because all media is served through the Worker and the Worker sits behind Access, copied media URLs are useless outside the org. No presigned-URL leak window in the viewing path.

### Data model

**D1**

- `users` — id, email, created_at
- `groups` — id, name
- `memberships` — user_id, group_id
- `media` — id, group_id, uploader_id, kind, r2_key_original, r2_key_display, r2_key_thumb, width, height, duration, caption, created_at

**R2** (private bucket, prefix per group)

```
<group_id>/<media_id>/original.<ext>
<group_id>/<media_id>/display.jpg
<group_id>/<media_id>/thumb.jpg
```

### Key flows

- **Upload:** derive sizes client-side → request presigned PUTs (Worker checks group) → upload to R2 → insert media row.
- **View:** query media (Worker filters to member's groups) → `<img>/<video>` hit the Worker → stream from R2 with range support → edge-cache thumb/display.
- **Bulk download:** desktop client-side zip; mobile Worker-streamed zip to OS download manager.

## 7. Configuration & Secrets

All config lives in the deployer's account; nothing is committed to the repo.

- `wrangler` bindings: R2 bucket, D1 database, (optional) Durable Object namespace.
- Vars: bucket name, size-tier dimensions, allowed file types/limits.
- Access: application + policy (allowed emails) configured in the Cloudflare dashboard or via API; the Worker validates the Access JWT against the account's public keys.
- Optional secrets: OAuth client ID/secret only if using social login; Images/Stream tokens only if those optional services are enabled.
- D1 migrations + a seed step for initial groups and memberships.

## 8. Suggested Repo Structure

```
/apps/web        # frontend (Pages build)
/apps/worker     # Worker: API, serving, access enforcement
/packages/shared # shared types (media, group, member)
/migrations      # D1 schema + seed
/wrangler.jsonc  # bindings & vars (no secrets)
/scripts/setup   # provisioning helper (create R2/D1, run migrations)
README + DEPLOY  # clone-to-deploy guide
LICENSE          # MIT or Apache-2.0
```

## 9. Cost Model (per deployment, paid by the deployer)

_Point-in-time, mid-2026; deployers should verify current pricing._

| Service   | Plan / usage                                              | Est. monthly      |
| --------- | --------------------------------------------------------- | ----------------- |
| Access    | Free (≤50 users)                                          | $0                |
| Pages     | Free tier                                                 | $0                |
| D1        | Free tier                                                 | $0                |
| R2        | ~100 GB, free egress                                      | ~$1.35            |
| Workers   | Paid (CPU headroom for zip; required for Durable Objects) | $5.00             |
| **Total** |                                                           | **~$5–7 / month** |

Workers can stay free (100k req/day) if neither server-side bulk-zip nor presence is used, dropping to ~$1.35/month.

## 10. Milestones

- **M1 — Personal MVP (all-Cloudflare).** F1–F8 working for the author's own deployment. Config/seed-driven groups; functional UI; no admin screens.
- **M2 — OSS-ready.** Clean README + DEPLOY guide, scripted provisioning, sensible defaults, minimal admin UI for invites/groups, LICENSE + CONTRIBUTING.
- **M3 — Optional layers.** Presence/live sync (Durable Objects / PartyServer), revocable outside-group share links, search, Cloudflare Images/Stream adapters.

## 11. Open Questions / Future

- **Membership in the JWT?** Caching groups in the token avoids a D1 hit per request but delays membership changes until refresh — define TTL/refresh behavior.
- **Outside-group sharing:** explicit, revocable share-link mechanism (D1 share record + long-lived signed URL), kept separate from in-app viewing. (M3)
- **Managed derivatives:** switch to Cloudflare Images if client-side generation is inconsistent across devices.
- **Video at scale:** adopt Cloudflare Stream if adaptive bitrate becomes necessary.
- **Portability:** abstract the storage/DB/auth layer behind interfaces so non-Cloudflare adapters (e.g. S3 + Postgres + OIDC) become possible without rewriting the app.
- **License choice:** MIT (maximally permissive) vs Apache-2.0 (patent grant) — decide before first public push.
