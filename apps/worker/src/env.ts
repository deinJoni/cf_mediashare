/**
 * Worker runtime environment: bindings + vars declared in wrangler.jsonc.
 * Keep this in sync with wrangler.jsonc. (You can also run `wrangler types`.)
 */
import type { User } from '@cf-mediashare/shared'

export interface Env {
  // --- Bindings ---
  /** Static assets: the built web app (apps/web/dist). */
  ASSETS: Fetcher
  /** R2 bucket for originals + derived sizes. */
  MEDIA_BUCKET: R2Bucket
  /** D1 metadata database. */
  DB: D1Database

  // --- Vars (non-secret) ---
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  MAX_UPLOAD_BYTES: string
  ALLOWED_MIME_PREFIXES: string
  /** Cloudflare account id — needed to build the R2 S3 endpoint for presigning. */
  CF_ACCOUNT_ID: string
  /** Must match the `bucket_name` of the MEDIA_BUCKET binding. */
  R2_BUCKET_NAME: string

  // --- Secrets (`wrangler secret put` / .dev.vars) ---
  /**
   * R2 API token credentials used ONLY to presign direct-to-R2 PUT URLs (F3).
   * Optional: when absent, presign falls back to same-origin proxy-upload URLs
   * through the Worker (always the case in local dev).
   */
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string

  // --- Local dev stubs (.dev.vars; never set in production) ---
  DEV_STUB_ACCESS?: string
  DEV_STUB_EMAIL?: string
}

/** Hono context variables set by middleware. */
export interface Variables {
  /** Verified member email, set by the Access middleware. */
  email: string
  /** Resolved member (D1 row), set by the membership middleware after `email`. */
  user: User
}

export type AppBindings = { Bindings: Env; Variables: Variables }
