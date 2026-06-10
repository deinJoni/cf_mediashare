import { Hono } from 'hono'
import {
  CreateMediaRequestSchema,
  DERIVED_CONTENT_TYPE,
  LIST_DEFAULT_LIMIT,
  ListMediaQuerySchema,
  SizeTierSchema,
  UpdateMediaRequestSchema,
} from '@cf-mediashare/shared'
import type { ListMediaResponse, OkResponse, User } from '@cf-mediashare/shared'
import type { AppBindings } from '../env.js'
import { decodeCursor, encodeCursor } from '../lib/cursor.js'
import {
  deleteMediaRow,
  getMediaById,
  insertMedia,
  isMember,
  listGroupMedia,
  rowToMedia,
  updateMediaCaption,
} from '../lib/db.js'
import type { MediaRow } from '../lib/db.js'
import { apiError, zodMessage } from '../lib/errors.js'
import { attachmentDisposition, resolveRange } from '../lib/http.js'
import { mediaKeys } from '../lib/keys.js'
import { kindMatchesContentType } from '../lib/validate.js'

/**
 * F7 permission gate shared by PATCH and DELETE: admins (operators) manage any
 * item; uploaders manage their own, provided they are still members of the
 * item's group. Everyone else — including other group members — gets 403.
 */
async function canManage(db: D1Database, user: User, row: MediaRow): Promise<boolean> {
  if (user.isAdmin) return true
  if (user.id !== row.uploader_id) return false
  return isMember(db, user.id, row.group_id)
}

export const mediaRoutes = new Hono<AppBindings>()
  /**
   * `POST /api/media` (F3 finalize) — after all three PUTs succeed. Keys are
   * re-derived (never trusted from the client) and verified to exist in R2
   * before the row lands in D1, so the gallery can't reference missing bytes.
   */
  .post('/media', async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined)
    const parsed = CreateMediaRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(apiError('bad_request', zodMessage(parsed.error)), 400)
    }
    const body = parsed.data

    const user = c.get('user')
    if (!(await isMember(c.env.DB, user.id, body.groupId))) {
      return c.json(apiError('forbidden'), 403)
    }
    if (!kindMatchesContentType(body.kind, body.originalContentType)) {
      return c.json(
        apiError(
          'bad_request',
          `Content type ${body.originalContentType} does not match kind ${body.kind}`,
        ),
        400,
      )
    }

    // Idempotent retry: if the client's first finalize succeeded but the
    // response was lost, the retry must return the row, not a dead-end 409.
    const already = await getMediaById(c.env.DB, body.mediaId)
    if (already) {
      if (already.uploader_id === user.id) return c.json(rowToMedia(already))
      return c.json(apiError('conflict', 'Media id already finalized'), 409)
    }

    const keys = mediaKeys(body.groupId, body.mediaId, body.originalExt)
    const [original, display, thumb] = await Promise.all([
      c.env.MEDIA_BUCKET.head(keys.original),
      c.env.MEDIA_BUCKET.head(keys.display),
      c.env.MEDIA_BUCKET.head(keys.thumb),
    ])
    if (!original || !display || !thumb) {
      return c.json(apiError('upload_incomplete', 'Not all objects were uploaded'), 400)
    }

    // Presign checks the *claimed* size; this checks what actually landed in
    // R2 — the only enforcement point on the direct-to-R2 path.
    if (original.size > Number(c.env.MAX_UPLOAD_BYTES)) {
      await c.env.MEDIA_BUCKET.delete([keys.original, keys.display, keys.thumb])
      return c.json(
        apiError('payload_too_large', `Original exceeds the ${c.env.MAX_UPLOAD_BYTES} byte limit`),
        413,
      )
    }

    try {
      await insertMedia(c.env.DB, {
        id: body.mediaId,
        groupId: body.groupId,
        uploaderId: user.id,
        kind: body.kind,
        keys,
        width: body.width,
        height: body.height,
        duration: body.duration,
        caption: body.caption ?? null,
        fileName: body.fileName,
        contentType: body.originalContentType,
        // What actually landed in R2, not what the client claimed at presign.
        sizeBytes: original.size,
      })
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        // Lost the race with a concurrent retry of the same finalize — same
        // idempotency rule as the pre-check above.
        const winner = await getMediaById(c.env.DB, body.mediaId)
        if (winner && winner.uploader_id === user.id) return c.json(rowToMedia(winner))
        return c.json(apiError('conflict', 'Media id already finalized'), 409)
      }
      throw err
    }

    // Read back for the server-assigned created_at (column DEFAULT).
    const row = await getMediaById(c.env.DB, body.mediaId)
    if (!row) {
      throw new Error('media row missing immediately after insert')
    }
    return c.json(rowToMedia(row))
  })
  /**
   * `GET /api/groups/:groupId/media` (F4) — group gallery, newest first,
   * keyset-paginated. Membership first: a nonexistent group answers the same
   * 403 as a real one you're not in, so group ids can't be probed.
   */
  .get('/groups/:groupId/media', async (c) => {
    const groupId = c.req.param('groupId')
    const user = c.get('user')
    if (!(await isMember(c.env.DB, user.id, groupId))) {
      return c.json(apiError('forbidden'), 403)
    }

    const parsed = ListMediaQuerySchema.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    })
    if (!parsed.success) {
      return c.json(apiError('bad_request', zodMessage(parsed.error)), 400)
    }
    const limit = parsed.data.limit ?? LIST_DEFAULT_LIMIT

    let cursor = null
    if (parsed.data.cursor !== undefined) {
      cursor = decodeCursor(parsed.data.cursor)
      if (!cursor) {
        return c.json(apiError('bad_request', 'Malformed cursor'), 400)
      }
    }

    const rows = await listGroupMedia(c.env.DB, groupId, limit + 1, cursor)
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const body: ListMediaResponse = {
      items: page.map(rowToMedia),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    }
    return c.json(body)
  })
  /**
   * `GET /api/media/:id/download` (F6) — the original as an attachment.
   * Registered before `:tier` so "download" is never parsed as a tier.
   */
  .get('/media/:id/download', async (c) => {
    const row = await getMediaById(c.env.DB, c.req.param('id'))
    if (!row) {
      return c.json(apiError('not_found'), 404)
    }
    const user = c.get('user')
    if (!(await isMember(c.env.DB, user.id, row.group_id))) {
      return c.json(apiError('forbidden'), 403)
    }

    const object = await c.env.MEDIA_BUCKET.get(row.r2_key_original)
    if (!object) {
      return c.json(apiError('not_found', 'Object missing from storage'), 404)
    }

    return new Response(object.body, {
      headers: {
        'content-type': row.content_type,
        'content-length': String(object.size),
        etag: object.httpEtag,
        'content-disposition': attachmentDisposition(row.file_name),
        'cache-control': 'private, max-age=3600',
      },
    })
  })
  /**
   * `GET /api/media/:id/:tier` (F5) — THE serve path. Auth → media row →
   * membership on its group (cross-group access is a 403 per the PRD), then
   * stream from R2 with full Range/conditional support so videos can seek
   * without downloading the whole file.
   */
  .get('/media/:id/:tier', async (c) => {
    const tierParse = SizeTierSchema.safeParse(c.req.param('tier'))
    if (!tierParse.success) {
      return c.json(apiError('not_found'), 404)
    }
    const tier = tierParse.data

    const row = await getMediaById(c.env.DB, c.req.param('id'))
    if (!row) {
      return c.json(apiError('not_found'), 404)
    }
    const user = c.get('user')
    if (!(await isMember(c.env.DB, user.id, row.group_id))) {
      return c.json(apiError('forbidden'), 403)
    }

    const key =
      tier === 'original'
        ? row.r2_key_original
        : tier === 'display'
          ? row.r2_key_display
          : row.r2_key_thumb
    const contentType = tier === 'original' ? row.content_type : DERIVED_CONTENT_TYPE
    // Derivatives are immutable per media id, so a year-long public cache is
    // safe; originals stay private to the browser cache only.
    const cacheControl =
      tier === 'original' ? 'private, max-age=3600' : 'public, max-age=31536000, immutable'

    // Edge cache, derivatives only, whole-object requests only. The cache key
    // is the bare URL with no auth headers — safe because every requester has
    // already passed Access + membership checks above, so a cache hit can only
    // be served to someone independently authorized for this exact object.
    const cacheable = tier !== 'original' && !c.req.raw.headers.has('range')
    const cacheKey = new Request(c.req.url)
    if (cacheable) {
      const cached = await caches.default.match(cacheKey)
      if (cached) return cached
    }

    // Let R2 interpret Range and the conditional (If-*) headers natively — but
    // only hand it the Range when the request actually carries one: R2/miniflare
    // report an `object.range` for any get() that was *offered* headers, which
    // would turn plain GETs into 206s.
    const hasRange = c.req.raw.headers.has('range')
    let object: R2Object | R2ObjectBody | null
    try {
      object = await c.env.MEDIA_BUCKET.get(key, {
        ...(hasRange ? { range: c.req.raw.headers } : {}),
        onlyIf: c.req.raw.headers,
      })
    } catch {
      // R2 throws on unsatisfiable Range headers.
      return c.json(apiError('range_not_satisfiable'), 416)
    }
    if (!object) {
      return c.json(apiError('not_found', 'Object missing from storage'), 404)
    }

    const headers = new Headers({
      etag: object.httpEtag,
      'accept-ranges': 'bytes',
      'content-type': contentType,
      'cache-control': cacheControl,
    })

    if (!('body' in object)) {
      // Precondition hit (e.g. If-None-Match matched): no body to send.
      return new Response(null, { status: 304, headers })
    }

    let status = 200
    if (hasRange && object.range) {
      const { offset, length } = resolveRange(object.range, object.size)
      // Production R2 throws on unsatisfiable ranges (caught above → 416), but
      // local R2 silently clamps them to the full object — detect that by
      // comparing the requested first byte against the object size.
      const firstByte = /^bytes=(\d+)-/.exec(c.req.raw.headers.get('range') ?? '')
      const unsatisfiable =
        length <= 0 ||
        offset < 0 ||
        offset >= object.size ||
        (firstByte !== null && Number(firstByte[1]) >= object.size)
      if (unsatisfiable) {
        return c.json(apiError('range_not_satisfiable'), 416, {
          'content-range': `bytes */${object.size}`,
        })
      }
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
      headers.set('content-length', String(length))
      status = 206
    } else {
      headers.set('content-length', String(object.size))
    }

    const response = new Response(object.body, { status, headers })
    if (cacheable && status === 200) {
      c.executionCtx.waitUntil(caches.default.put(cacheKey, response.clone()))
    }
    return response
  })
  /** `PATCH /api/media/:id` (F7) — caption edit, uploader or admin only. */
  .patch('/media/:id', async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined)
    const parsed = UpdateMediaRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(apiError('bad_request', zodMessage(parsed.error)), 400)
    }

    const row = await getMediaById(c.env.DB, c.req.param('id'))
    if (!row) {
      return c.json(apiError('not_found'), 404)
    }
    if (!(await canManage(c.env.DB, c.get('user'), row))) {
      return c.json(apiError('forbidden'), 403)
    }

    await updateMediaCaption(c.env.DB, row.id, parsed.data.caption)
    // Caption is the only mutable field, so the loaded row + new caption *is*
    // the post-update state — no second read needed.
    return c.json(rowToMedia({ ...row, caption: parsed.data.caption }))
  })
  /** `DELETE /api/media/:id` (F7) — remove all three R2 objects and the row. */
  .delete('/media/:id', async (c) => {
    const row = await getMediaById(c.env.DB, c.req.param('id'))
    if (!row) {
      return c.json(apiError('not_found'), 404)
    }
    if (!(await canManage(c.env.DB, c.get('user'), row))) {
      return c.json(apiError('forbidden'), 403)
    }

    // R2 first, row second: if the blob delete fails midway the row survives,
    // so the operation stays visible and can simply be retried.
    await c.env.MEDIA_BUCKET.delete([row.r2_key_original, row.r2_key_display, row.r2_key_thumb])
    await deleteMediaRow(c.env.DB, row.id)

    const body: OkResponse = { ok: true }
    return c.json(body)
  })
