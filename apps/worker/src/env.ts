/**
 * Worker runtime environment: bindings + vars declared in wrangler.jsonc.
 * Keep this in sync with wrangler.jsonc. (You can also run `wrangler types`.)
 */
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

  // --- Local dev stubs (.dev.vars; never set in production) ---
  DEV_STUB_ACCESS?: string
  DEV_STUB_EMAIL?: string
}

/** Hono context variables set by middleware. */
export interface Variables {
  /** Verified member email, set by the Access middleware. */
  email: string
}

export type AppBindings = { Bindings: Env; Variables: Variables }
