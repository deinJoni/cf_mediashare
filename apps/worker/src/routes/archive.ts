import { Hono } from 'hono'
import {
  ARCHIVE_MAX_SELECTION_IDS,
  partitionArchive,
  zipPlannedSize,
  zipStore,
} from '@cf-mediashare/shared'
import type { ArchiveInfoResponse, ArchivePart, ZipEntryInput } from '@cf-mediashare/shared'
import type { AppBindings } from '../env.js'
import {
  getGroupById,
  isMember,
  listGroupMediaByIds,
  listGroupMediaForArchive,
} from '../lib/db.js'
import type { ArchiveMediaRow } from '../lib/db.js'
import { apiError } from '../lib/errors.js'
import { attachmentDisposition } from '../lib/http.js'
import { UUID_RE } from '../lib/validate.js'

/**
 * Sum a part's originals and compute the exact emitted zip size (same
 * name-resolution the writer uses, so Content-Length can't drift).
 */
function partInfo(items: ArchiveMediaRow[], part: number): ArchivePart {
  return {
    part,
    itemCount: items.length,
    bytes: items.reduce((sum, r) => sum + r.size_bytes, 0),
    zipBytes: zipPlannedSize(items.map((r) => ({ name: r.file_name, sizeBytes: r.size_bytes }))),
  }
}

/**
 * The streaming zip response shared by `?part=` and `?ids=`. Objects are
 * fetched lazily as the archive drains — memory stays O(1). `size_bytes` is
 * trusted as the entry size: it was recorded from the R2 head at finalize and
 * the keys are immutable, so it can only diverge if a delete raced the
 * listing — in which case the stream honestly fails and the user retries.
 */
function archiveResponse(
  rows: ArchiveMediaRow[],
  fileName: string,
  bucket: R2Bucket,
): Response {
  async function* entries(): AsyncIterable<ZipEntryInput> {
    for (const row of rows) {
      const object = await bucket.get(row.r2_key_original)
      if (!object) {
        throw new Error(`Object missing from storage mid-archive: ${row.id}`)
      }
      yield {
        name: row.file_name,
        sizeBytes: row.size_bytes,
        modifiedAt: new Date(row.created_at),
        body: object.body,
      }
    }
  }

  return new Response(zipStore(entries()), {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(
        zipPlannedSize(rows.map((r) => ({ name: r.file_name, sizeBytes: r.size_bytes }))),
      ),
      'content-disposition': attachmentDisposition(fileName),
      // Every response is personalized by membership state — never cacheable.
      'cache-control': 'private, no-store',
    },
  })
}

/** Zip file names carry the group name for recognizability, ASCII-fallback'd. */
function archiveFileName(groupName: string, suffix: string): string {
  const base = groupName.trim().replace(/[/\\]/g, '-') || 'archive'
  return `${base}-${suffix}.zip`
}

export const archiveRoutes = new Hono<AppBindings>()
  /**
   * `GET /api/groups/:groupId/archive/info` (F6) — the download-all plan:
   * total items/bytes and the bounded parts the client offers the member.
   * Same membership gate as the gallery; a group you're not in answers 403
   * exactly like a nonexistent one.
   */
  .get('/groups/:groupId/archive/info', async (c) => {
    const groupId = c.req.param('groupId')
    const user = c.get('user')
    if (!(await isMember(c.env.DB, user.id, groupId))) {
      return c.json(apiError('forbidden'), 403)
    }

    const rows = await listGroupMediaForArchive(c.env.DB, groupId)
    const parts = partitionArchive(rows)
    const body: ArchiveInfoResponse = {
      itemCount: rows.length,
      totalBytes: rows.reduce((sum, r) => sum + r.size_bytes, 0),
      parts: parts.map((items, i) => partInfo(items, i + 1)),
    }
    return c.json(body)
  })
  /**
   * `GET /api/groups/:groupId/archive` (F6) — the streaming zip itself.
   *   ?part=N   whole-group download, part N of the plan (1-based)
   *   ?ids=a,b  bounded selection (≤ ARCHIVE_MAX_SELECTION_IDS), gallery order
   *
   * Media uploaded between the info call and this request simply isn't in the
   * derived part — the download is a consistent-by-construction slice of what
   * the member browsed, not a live feed.
   */
  .get('/groups/:groupId/archive', async (c) => {
    const groupId = c.req.param('groupId')
    const user = c.get('user')
    if (!(await isMember(c.env.DB, user.id, groupId))) {
      return c.json(apiError('forbidden'), 403)
    }

    const group = await getGroupById(c.env.DB, groupId)
    const groupName = group?.name ?? 'archive'

    const idsParam = c.req.query('ids')
    if (idsParam !== undefined) {
      const ids = idsParam.split(',').filter((s) => s.length > 0)
      if (ids.length === 0) {
        return c.json(apiError('bad_request', 'No media ids given'), 400)
      }
      if (ids.length > ARCHIVE_MAX_SELECTION_IDS) {
        return c.json(
          apiError('bad_request', `Selections are capped at ${ARCHIVE_MAX_SELECTION_IDS} items`),
          400,
        )
      }
      if (ids.some((id) => !UUID_RE.test(id))) {
        return c.json(apiError('bad_request', 'Malformed media id'), 400)
      }
      // Rows not in this group simply don't come back — a member can't probe
      // other groups' media ids through which ones the archive contains.
      const rows = await listGroupMediaByIds(c.env.DB, groupId, ids)
      if (rows.length === 0) {
        return c.json(apiError('not_found'), 404)
      }
      return archiveResponse(rows, archiveFileName(groupName, 'selection'), c.env.MEDIA_BUCKET)
    }

    const partRaw = c.req.query('part') ?? '1'
    const part = Number(partRaw)
    if (!Number.isInteger(part) || part < 1) {
      return c.json(apiError('bad_request', 'part must be a positive integer'), 400)
    }

    const rows = await listGroupMediaForArchive(c.env.DB, groupId)
    const parts = partitionArchive(rows)
    const items = parts[part - 1]
    if (!items) {
      return c.json(apiError('not_found', `No part ${part}`), 404)
    }
    return archiveResponse(
      items,
      archiveFileName(groupName, `part-${part}-of-${parts.length}`),
      c.env.MEDIA_BUCKET,
    )
  })
