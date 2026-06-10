/**
 * Domain types — the shared vocabulary between web and worker.
 *
 * These are *wire* types: what the API returns to the client. Worker-internal
 * shapes (D1 rows, R2 keys) live in the worker; R2 keys never cross the wire —
 * the client only ever sees `/api/media/:id/:tier` serve URLs.
 */

/** Media kind. Photos and videos in v1. */
export type MediaKind = 'photo' | 'video'

/**
 * Derived size tiers stored in R2 alongside the original.
 * - `thumb`   — ~320px JPEG, grid (for videos: small poster frame)
 * - `display` — ~1600px JPEG, lightbox (for videos: full poster frame)
 * - `original`— the uploaded file, fetched on explicit action / video playback
 */
export type SizeTier = 'thumb' | 'display' | 'original'

export interface User {
  id: string
  email: string
  /** Operators can manage (delete/caption) any item, not just their own. */
  isAdmin: boolean
}

export interface Group {
  id: string
  name: string
}

export interface Media {
  id: string
  groupId: string
  uploaderId: string
  uploaderEmail: string
  kind: MediaKind
  /** Pixel dimensions of the original (photos and videos). */
  width: number | null
  height: number | null
  /** Seconds, videos only. */
  duration: number | null
  caption: string | null
  /** Original file name at upload time (used for download). */
  fileName: string
  /** MIME type of the original. */
  contentType: string
  /** Byte size of the original. */
  sizeBytes: number
  /** ISO 8601 UTC. */
  createdAt: string
}
