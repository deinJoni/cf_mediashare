import { ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES } from '@cf-mediashare/shared'
import type { MediaKind } from '@cf-mediashare/shared'

/**
 * Kind ↔ MIME consistency. The locked contracts validate `originalContentType`
 * against the *combined* allowlist (one enum for both kinds), so the worker
 * still has to reject mismatched pairs like kind=photo + video/mp4.
 */
export function kindMatchesContentType(kind: MediaKind, contentType: string): boolean {
  const allowed: readonly string[] = kind === 'photo' ? ALLOWED_IMAGE_TYPES : ALLOWED_VIDEO_TYPES
  return allowed.includes(contentType)
}

/** Media ids are worker-allocated `crypto.randomUUID()`s — reject anything else. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The only file names the upload proxy will write: exactly the three objects
 * presign hands out. Anchored so the proxy can't be used to write arbitrary
 * keys into the bucket.
 */
export const UPLOAD_FILE_NAME_RE = /^(original\.[a-z0-9]{1,8}|display\.jpg|thumb\.jpg)$/
