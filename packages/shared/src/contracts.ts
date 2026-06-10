/**
 * API contracts — request/response shapes shared by web and worker.
 *
 * Working principle (DEVELOPMENT.md): contracts first. Zod schemas are the single
 * source of truth; TS types are inferred from them so the wire format and the
 * compile-time types can never drift.
 *
 * Phase 2 LOCKS the upload/serve contracts below. Additive changes only.
 *
 * Endpoint map (all under `/api`, all behind Cloudflare Access except /health):
 *   GET    /health                     → HealthResponse        (public liveness)
 *   GET    /me                         → MeResponse            (F1, F2)
 *   POST   /uploads/presign            → PresignUploadResponse (F3)
 *   PUT    /upload-proxy/:groupId/:mediaId/:fileName            (F3 fallback —
 *            same-origin upload path used when R2 S3 credentials are not
 *            configured, e.g. local dev; body = raw bytes)
 *   POST   /media                      → Media                 (F3 finalize)
 *   GET    /groups/:groupId/media      → ListMediaResponse     (F4)
 *   GET    /media/:id/:tier            → bytes                 (F5; tier = thumb|display|original)
 *   GET    /media/:id/download         → bytes, attachment     (F6)
 *   PATCH  /media/:id                  → Media                 (F7 caption)
 *   DELETE /media/:id                  → OkResponse            (F7)
 */
import { z } from 'zod'
import type { Media } from './types.js'
import {
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
  LIST_MAX_LIMIT,
  MAX_CAPTION_LENGTH,
  MAX_FILE_NAME_LENGTH,
} from './constants.js'

/** Standard error envelope returned by every failing endpoint. */
export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

export const OkResponseSchema = z.object({ ok: z.literal(true) })
export type OkResponse = z.infer<typeof OkResponseSchema>

/** `GET /api/health` — liveness, used by CI and canary checks. */
export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>

// --- Identity (F1, F2) ------------------------------------------------------

export const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  isAdmin: z.boolean(),
})

/** `GET /api/me` — the signed-in member's identity and resolved groups. */
export const MeResponseSchema = z.object({
  user: UserSchema,
  groups: z.array(GroupSchema),
})
export type MeResponse = z.infer<typeof MeResponseSchema>

// --- Media (wire shape) -----------------------------------------------------

export const MediaKindSchema = z.enum(['photo', 'video'])
export const SizeTierSchema = z.enum(['thumb', 'display', 'original'])

export const MediaSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  uploaderId: z.string(),
  uploaderEmail: z.string(),
  kind: MediaKindSchema,
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Seconds, videos only. */
  duration: z.number().positive().nullable(),
  caption: z.string().max(MAX_CAPTION_LENGTH).nullable(),
  fileName: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
})

/** Compile-time drift guard: the Zod schema must produce exactly the `Media` wire type. */
type AssertExact<A, B> = A extends B ? (B extends A ? true : never) : never
const _mediaWireGuard: AssertExact<Media, z.infer<typeof MediaSchema>> = true
void _mediaWireGuard

// --- Upload (F3) — LOCKED in Phase 2 ----------------------------------------

const ORIGINAL_CONTENT_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES] as [
  string,
  ...string[],
]

/** File extension of the original, e.g. "jpg", "mp4". Lowercase, no dot. */
export const OriginalExtSchema = z.string().regex(/^[a-z0-9]{1,8}$/)

/**
 * `POST /api/uploads/presign` — request upload targets for one media item
 * (original + the two client-generated derivatives). Worker checks group
 * membership, validates type/size, and allocates the media id + R2 keys.
 */
export const PresignUploadRequestSchema = z.object({
  groupId: z.string().min(1),
  kind: MediaKindSchema,
  originalContentType: z.enum(ORIGINAL_CONTENT_TYPES),
  originalExt: OriginalExtSchema,
  originalSizeBytes: z.number().int().positive(),
})
export type PresignUploadRequest = z.infer<typeof PresignUploadRequestSchema>

/**
 * One upload target. `url` is either an absolute presigned R2 (S3 API) URL —
 * bytes go directly to R2, never through the Worker — or a relative
 * `/api/upload-proxy/...` URL when S3 credentials are not configured.
 * The client must PUT with exactly `headers` set (plus Content-Type).
 */
export const UploadTargetSchema = z.object({
  url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string()),
})
export type UploadTarget = z.infer<typeof UploadTargetSchema>

export const PresignUploadResponseSchema = z.object({
  mediaId: z.string(),
  uploads: z.object({
    original: UploadTargetSchema,
    display: UploadTargetSchema,
    thumb: UploadTargetSchema,
  }),
})
export type PresignUploadResponse = z.infer<typeof PresignUploadResponseSchema>

/**
 * `POST /api/media` — finalize after all three PUTs succeed. Worker re-derives
 * the R2 keys, verifies the objects exist, and inserts the media row.
 * Client-measured metadata (dimensions/duration) is trusted within the group.
 */
export const CreateMediaRequestSchema = z.object({
  mediaId: z.string().uuid(),
  groupId: z.string().min(1),
  kind: MediaKindSchema,
  originalExt: OriginalExtSchema,
  originalContentType: z.enum(ORIGINAL_CONTENT_TYPES),
  fileName: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  duration: z.number().positive().nullable(),
  caption: z.string().max(MAX_CAPTION_LENGTH).nullable().optional(),
})
export type CreateMediaRequest = z.infer<typeof CreateMediaRequestSchema>
// → responds with MediaSchema

// --- Browse (F4) -------------------------------------------------------------

/**
 * `GET /api/groups/:groupId/media?limit=&cursor=` — group-filtered, newest
 * first. `cursor` is an opaque token from a previous response.
 */
export const ListMediaQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(LIST_MAX_LIMIT).optional(),
  cursor: z.string().optional(),
})
export type ListMediaQuery = z.infer<typeof ListMediaQuerySchema>

export const ListMediaResponseSchema = z.object({
  items: z.array(MediaSchema),
  /** Pass as `cursor` to fetch the next page; null = no more items. */
  nextCursor: z.string().nullable(),
})
export type ListMediaResponse = z.infer<typeof ListMediaResponseSchema>

// --- Manage (F7) -------------------------------------------------------------

/** `PATCH /api/media/:id` — caption edit (uploader or admin). */
export const UpdateMediaRequestSchema = z.object({
  caption: z.string().max(MAX_CAPTION_LENGTH).nullable(),
})
export type UpdateMediaRequest = z.infer<typeof UpdateMediaRequestSchema>
// → responds with MediaSchema
