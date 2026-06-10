/**
 * Domain types — the shared vocabulary between web and worker.
 * Mirrors the D1 data model in PRD.md §6.
 */

/** Media kind. Photos and videos in v1. */
export type MediaKind = 'photo' | 'video'

/**
 * Derived size tiers stored in R2 alongside the original.
 * - `thumb`   — ~300px, grid
 * - `display` — ~1600px, lightbox / playback
 * - `original`— the uploaded file, fetched on explicit action
 */
export type SizeTier = 'thumb' | 'display' | 'original'

export interface User {
  id: string
  email: string
  createdAt: string
}

export interface Group {
  id: string
  name: string
}

export interface Membership {
  userId: string
  groupId: string
}

export interface Media {
  id: string
  groupId: string
  uploaderId: string
  kind: MediaKind
  r2KeyOriginal: string
  r2KeyDisplay: string
  r2KeyThumb: string
  width: number | null
  height: number | null
  /** Seconds, videos only. */
  duration: number | null
  caption: string | null
  createdAt: string
}
