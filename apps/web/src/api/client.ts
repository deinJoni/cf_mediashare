/**
 * Typed API client — one wrapper per endpoint in the contract map
 * (packages/shared/src/contracts.ts). Every response body is parsed with the
 * shared Zod schema so a drifting worker fails loudly here, at the seam,
 * instead of as a confusing render bug deeper in the tree.
 */
import {
  ApiErrorSchema,
  HealthResponseSchema,
  ListMediaResponseSchema,
  MediaSchema,
  MeResponseSchema,
  OkResponseSchema,
  PresignUploadResponseSchema,
  type ApiError,
  type CreateMediaRequest,
  type HealthResponse,
  type ListMediaResponse,
  type Media,
  type MeResponse,
  type OkResponse,
  type PresignUploadRequest,
  type PresignUploadResponse,
  type UpdateMediaRequest,
  type UploadTarget,
} from '@cf-mediashare/shared'

/** Non-2xx API response, carrying the status and the parsed error envelope. */
export class ApiClientError extends Error {
  readonly status: number
  readonly body: ApiError

  constructor(status: number, body: ApiError) {
    super(body.message ?? body.error)
    this.name = 'ApiClientError'
    this.status = status
    this.body = body
  }
}

/**
 * Minimal structural schema type so this module doesn't import zod directly —
 * the web app's only contract dependency stays @cf-mediashare/shared.
 */
interface Schema<T> {
  parse(data: unknown): T
}

async function readErrorBody(res: Response): Promise<ApiError> {
  try {
    const parsed = ApiErrorSchema.safeParse(await res.json())
    if (parsed.success) return parsed.data
  } catch {
    // Non-JSON error body (e.g. an HTML error page from Access) — fall through.
  }
  return { error: `http_${res.status}`, message: `Request failed (HTTP ${res.status})` }
}

async function request<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  // credentials: 'same-origin' so the Cloudflare Access cookie rides along.
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (!res.ok) throw new ApiClientError(res.status, await readErrorBody(res))
  return schema.parse(await res.json())
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** `GET /api/health` — public liveness probe. */
export function getHealth(): Promise<HealthResponse> {
  return request('/api/health', HealthResponseSchema)
}

/** `GET /api/me` — identity + resolved groups (F1, F2). */
export function getMe(): Promise<MeResponse> {
  return request('/api/me', MeResponseSchema)
}

/** `GET /api/groups/:groupId/media` — newest-first page of a group (F4). */
export function listMedia(
  groupId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<ListMediaResponse> {
  const params = new URLSearchParams()
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  const qs = params.toString()
  return request(
    `/api/groups/${encodeURIComponent(groupId)}/media${qs ? `?${qs}` : ''}`,
    ListMediaResponseSchema,
  )
}

/** `POST /api/uploads/presign` — allocate a media id + upload targets (F3). */
export function presignUpload(req: PresignUploadRequest): Promise<PresignUploadResponse> {
  return request('/api/uploads/presign', PresignUploadResponseSchema, jsonInit('POST', req))
}

/** `POST /api/media` — finalize after all three PUTs succeeded (F3). */
export function createMedia(req: CreateMediaRequest): Promise<Media> {
  return request('/api/media', MediaSchema, jsonInit('POST', req))
}

/** `PATCH /api/media/:id` — caption edit, uploader or admin only (F7). */
export function updateMedia(id: string, req: UpdateMediaRequest): Promise<Media> {
  return request(`/api/media/${encodeURIComponent(id)}`, MediaSchema, jsonInit('PATCH', req))
}

/** `DELETE /api/media/:id` — remove row + all R2 objects (F7). */
export function deleteMedia(id: string): Promise<OkResponse> {
  return request(`/api/media/${encodeURIComponent(id)}`, OkResponseSchema, { method: 'DELETE' })
}

/**
 * Headers for an UploadTarget PUT. The contract requires the target's headers
 * verbatim plus Content-Type; when the worker already pinned Content-Type
 * (it can be part of the S3 signature), keep its value rather than overriding.
 */
function targetHeaders(target: UploadTarget, contentType: string): Headers {
  const headers = new Headers(target.headers)
  if (!headers.has('content-type')) headers.set('content-type', contentType)
  return headers
}

/**
 * PUT a derivative (small blob) to an upload target. Works for both absolute
 * presigned R2 URLs and relative `/api/upload-proxy/...` URLs: with
 * 'same-origin' credentials the Access cookie is sent only on the latter.
 */
export async function putBlob(
  target: UploadTarget,
  body: Blob,
  contentType: string,
): Promise<void> {
  const res = await fetch(target.url, {
    method: target.method,
    headers: targetHeaders(target, contentType),
    body,
    credentials: 'same-origin',
  })
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`)
}

/**
 * PUT with real upload progress. fetch() cannot report request-body progress
 * (streaming uploads aren't broadly supported), so the original — the only
 * large payload — goes via XMLHttpRequest. Cookie behavior matches putBlob:
 * same-origin requests carry them, cross-origin R2 PUTs don't.
 */
export function putBlobWithProgress(
  target: UploadTarget,
  body: Blob,
  contentType: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(target.method, target.url)
    for (const [name, value] of targetHeaders(target, contentType)) {
      xhr.setRequestHeader(name, value)
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Network error while uploading'))
    xhr.onabort = () => reject(new Error('Upload was aborted'))
    xhr.send(body)
  })
}
