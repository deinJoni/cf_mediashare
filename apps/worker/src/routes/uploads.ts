import { Hono } from 'hono'
import { DERIVED_CONTENT_TYPE, PresignUploadRequestSchema } from '@cf-mediashare/shared'
import type { OkResponse, PresignUploadResponse, UploadTarget } from '@cf-mediashare/shared'
import type { AppBindings } from '../env.js'
import { getMediaById, isMember } from '../lib/db.js'
import { apiError, zodMessage } from '../lib/errors.js'
import { mediaKeys } from '../lib/keys.js'
import { presignPut, s3Credentials } from '../lib/presign.js'
import { kindMatchesContentType, UPLOAD_FILE_NAME_RE, UUID_RE } from '../lib/validate.js'

export const uploadRoutes = new Hono<AppBindings>()
  /**
   * `POST /api/uploads/presign` (F3) — allocate a media id and hand back three
   * PUT targets (original + the two client-generated derivatives). Targets are
   * direct S3-presigned R2 URLs when the deployer configured an R2 API token,
   * otherwise same-origin proxy URLs (always the case in local dev).
   */
  .post('/uploads/presign', async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined)
    const parsed = PresignUploadRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(apiError('bad_request', zodMessage(parsed.error)), 400)
    }
    const body = parsed.data

    const user = c.get('user')
    if (!(await isMember(c.env.DB, user.id, body.groupId))) {
      return c.json(apiError('forbidden'), 403)
    }
    if (body.originalSizeBytes > Number(c.env.MAX_UPLOAD_BYTES)) {
      return c.json(
        apiError('payload_too_large', `Original exceeds the ${c.env.MAX_UPLOAD_BYTES} byte limit`),
        413,
      )
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

    const mediaId = crypto.randomUUID()
    const keys = mediaKeys(body.groupId, mediaId, body.originalExt)

    const creds = s3Credentials(c.env)
    let uploads: PresignUploadResponse['uploads']
    if (creds) {
      const [original, display, thumb] = await Promise.all([
        presignPut(creds, keys.original, body.originalContentType),
        presignPut(creds, keys.display, DERIVED_CONTENT_TYPE),
        presignPut(creds, keys.thumb, DERIVED_CONTENT_TYPE),
      ])
      uploads = { original, display, thumb }
    } else {
      const proxyTarget = (fileName: string, contentType: string): UploadTarget => ({
        url: `/api/upload-proxy/${body.groupId}/${mediaId}/${fileName}`,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
      })
      uploads = {
        original: proxyTarget(`original.${body.originalExt}`, body.originalContentType),
        display: proxyTarget('display.jpg', DERIVED_CONTENT_TYPE),
        thumb: proxyTarget('thumb.jpg', DERIVED_CONTENT_TYPE),
      }
    }

    const response: PresignUploadResponse = { mediaId, uploads }
    return c.json(response)
  })
  /**
   * `PUT /api/upload-proxy/:groupId/:mediaId/:fileName` (F3 fallback) — the
   * only path where media bytes transit the Worker, and only when S3
   * credentials are not configured. The path is locked to the exact three
   * object names presign hands out, so this can't write arbitrary keys.
   */
  .put('/upload-proxy/:groupId/:mediaId/:fileName', async (c) => {
    const { groupId, mediaId, fileName } = c.req.param()
    if (!UUID_RE.test(mediaId) || !UPLOAD_FILE_NAME_RE.test(fileName)) {
      return c.json(apiError('bad_request', 'Invalid upload path'), 400)
    }

    const user = c.get('user')
    if (!(await isMember(c.env.DB, user.id, groupId))) {
      return c.json(apiError('forbidden'), 403)
    }

    // Finalized media is immutable: ids become visible to the whole group in
    // serve URLs, so without this check any member could overwrite another
    // member's bytes by re-PUTting to a known id — bypassing the F7 permission
    // gate that PATCH/DELETE enforce.
    if (await getMediaById(c.env.DB, mediaId)) {
      return c.json(apiError('conflict', 'Media already finalized'), 409)
    }

    // The limit must be enforced before any bytes are consumed — and R2 needs
    // a known length to accept a stream anyway, so a missing Content-Length is
    // its own client error.
    const contentLength = Number(c.req.header('content-length') ?? NaN)
    if (!Number.isFinite(contentLength)) {
      return c.json(apiError('length_required', 'Content-Length is required'), 411)
    }
    if (contentLength > Number(c.env.MAX_UPLOAD_BYTES)) {
      return c.json(
        apiError('payload_too_large', `Upload exceeds the ${c.env.MAX_UPLOAD_BYTES} byte limit`),
        413,
      )
    }

    // Stream straight into R2; the request Content-Type becomes the object's
    // httpMetadata, mirroring what a direct presigned PUT would store.
    await c.env.MEDIA_BUCKET.put(`${groupId}/${mediaId}/${fileName}`, c.req.raw.body, {
      httpMetadata: { contentType: c.req.header('content-type') },
    })

    const body: OkResponse = { ok: true }
    return c.json(body)
  })
