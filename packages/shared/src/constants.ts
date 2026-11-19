/**
 * Shared constants — size tiers, allowlists, limits, and URL helpers.
 * Single source of truth for both client-side derivative generation and
 * worker-side validation.
 */
import type { SizeTier } from './types.js'

/** Max edge (px) of the grid thumbnail derivative. */
export const THUMB_MAX_PX = 320
/** Max edge (px) of the lightbox display derivative / video poster. */
export const DISPLAY_MAX_PX = 1600
/** All derived sizes are encoded as JPEG. */
export const DERIVED_CONTENT_TYPE = 'image/jpeg'
export const DERIVED_JPEG_QUALITY = 0.85

/**
 * MIME allowlists for originals. v1 accepts what mainstream browsers can both
 * decode (for client-side derivative generation) and play back.
 */
export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const
export const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const

export const MAX_CAPTION_LENGTH = 1000
export const MAX_FILE_NAME_LENGTH = 255
/** Group display name (admin UI, F2). */
export const MAX_GROUP_NAME_LENGTH = 100

/** Gallery pagination (F4). */
export const LIST_DEFAULT_LIMIT = 50
export const LIST_MAX_LIMIT = 100

/** Presigned PUT URLs expire after this many seconds. */
export const PRESIGN_EXPIRY_SECONDS = 3600

/** Serve URL for a media item at a given tier (`GET /api/media/:id/:tier`). */
export function mediaUrl(id: string, tier: SizeTier): string {
  return `/api/media/${encodeURIComponent(id)}/${tier}`
}

/** Download URL for the original with Content-Disposition: attachment. */
export function mediaDownloadUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}/download`
}
