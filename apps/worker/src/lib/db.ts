/**
 * D1 access layer — every SQL statement and the snake_case ↔ camelCase seam
 * live here, so route handlers only ever see typed rows and wire-shaped
 * objects. All values go through `.bind()`; the only string-built SQL is the
 * static cursor predicate, never user data.
 */
import type { Group, Media, MediaKind } from '@cf-mediashare/shared'
import type { CursorPosition } from './cursor.js'
import type { MediaKeys } from './keys.js'

/** `users` row. */
export interface UserRow {
  id: string
  email: string
  /** SQLite boolean: 0 | 1. */
  is_admin: number
}

/** `media` row joined with the uploader's email (the wire shape needs it). */
export interface MediaRow {
  id: string
  group_id: string
  uploader_id: string
  uploader_email: string
  /** Narrowed by the CHECK constraint in 0001_init.sql. */
  kind: MediaKind
  r2_key_original: string
  r2_key_display: string
  r2_key_thumb: string
  width: number | null
  height: number | null
  duration: number | null
  caption: string | null
  file_name: string
  content_type: string
  size_bytes: number
  created_at: string
}

/** One shared projection for every media read so the row type can't drift per query. */
const MEDIA_SELECT = `
  SELECT
    m.id, m.group_id, m.uploader_id, u.email AS uploader_email, m.kind,
    m.r2_key_original, m.r2_key_display, m.r2_key_thumb,
    m.width, m.height, m.duration, m.caption,
    m.file_name, m.content_type, m.size_bytes, m.created_at
  FROM media m
  JOIN users u ON u.id = m.uploader_id`

/** D1 row → wire Media. R2 keys deliberately do not cross this boundary. */
export function rowToMedia(row: MediaRow): Media {
  return {
    id: row.id,
    groupId: row.group_id,
    uploaderId: row.uploader_id,
    uploaderEmail: row.uploader_email,
    kind: row.kind,
    width: row.width,
    height: row.height,
    duration: row.duration,
    caption: row.caption,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  }
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db
    .prepare('SELECT id, email, is_admin FROM users WHERE email = ?')
    .bind(email)
    .first<UserRow>()
}

/**
 * The per-group enforcement primitive (PRD §6): D1 has no row-level security,
 * so every group-scoped route asks this question explicitly. A nonexistent
 * group is indistinguishable from a group you're not in — both answer "no",
 * which is what lets routes return 403 without leaking group existence.
 */
export async function isMember(db: D1Database, userId: string, groupId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM memberships WHERE user_id = ? AND group_id = ?')
    .bind(userId, groupId)
    .first()
  return row !== null
}

export async function listGroupsForUser(db: D1Database, userId: string): Promise<Group[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.name
       FROM groups g
       JOIN memberships ms ON ms.group_id = g.id
       WHERE ms.user_id = ?
       ORDER BY g.name`,
    )
    .bind(userId)
    .all<Group>()
  return results
}

export async function getMediaById(db: D1Database, id: string): Promise<MediaRow | null> {
  return db.prepare(`${MEDIA_SELECT} WHERE m.id = ?`).bind(id).first<MediaRow>()
}

/**
 * Keyset pagination, newest first, riding the (group_id, created_at DESC,
 * id DESC) index. Callers pass limit+1 so "is there another page?" needs no
 * COUNT round-trip.
 */
export async function listGroupMedia(
  db: D1Database,
  groupId: string,
  limitPlusOne: number,
  cursor: CursorPosition | null,
): Promise<MediaRow[]> {
  const order = ' ORDER BY m.created_at DESC, m.id DESC LIMIT ?'
  const stmt = cursor
    ? db
        .prepare(
          `${MEDIA_SELECT} WHERE m.group_id = ? AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))${order}`,
        )
        .bind(groupId, cursor.createdAt, cursor.createdAt, cursor.id, limitPlusOne)
    : db.prepare(`${MEDIA_SELECT} WHERE m.group_id = ?${order}`).bind(groupId, limitPlusOne)
  const { results } = await stmt.all<MediaRow>()
  return results
}

export interface InsertMediaParams {
  id: string
  groupId: string
  uploaderId: string
  kind: MediaKind
  keys: MediaKeys
  width: number | null
  height: number | null
  duration: number | null
  caption: string | null
  fileName: string
  contentType: string
  /** Server-measured via R2 head(), never the client's claim. */
  sizeBytes: number
}

/**
 * `created_at` is intentionally omitted: the column DEFAULT timestamps
 * server-side, so callers read the row back for the wire response.
 */
export async function insertMedia(db: D1Database, p: InsertMediaParams): Promise<void> {
  await db
    .prepare(
      `INSERT INTO media (
         id, group_id, uploader_id, kind,
         r2_key_original, r2_key_display, r2_key_thumb,
         width, height, duration, caption,
         file_name, content_type, size_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.groupId,
      p.uploaderId,
      p.kind,
      p.keys.original,
      p.keys.display,
      p.keys.thumb,
      p.width,
      p.height,
      p.duration,
      p.caption,
      p.fileName,
      p.contentType,
      p.sizeBytes,
    )
    .run()
}

export async function updateMediaCaption(
  db: D1Database,
  id: string,
  caption: string | null,
): Promise<void> {
  await db.prepare('UPDATE media SET caption = ? WHERE id = ?').bind(caption, id).run()
}

export async function deleteMediaRow(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM media WHERE id = ?').bind(id).run()
}

// --- Admin (F2) -------------------------------------------------------------
//
// The admin surface reads the whole member/group list and mutates it. Deletes
// here are written as EXPLICIT multi-table batches rather than leaning on the
// schema's ON DELETE CASCADE: D1 does not reliably enforce foreign keys at
// runtime, so cascading the dependent rows ourselves is the only guarantee
// that removing a user/group leaves no dangling media or membership rows.

/** `users` row with the columns the admin list needs (adds `created_at`). */
export interface AdminUserRow {
  id: string
  email: string
  is_admin: number
  created_at: string
}

/** Just the three R2 keys of a media row — used to purge blobs before a cascade delete. */
export interface MediaKeyRow {
  r2_key_original: string
  r2_key_display: string
  r2_key_thumb: string
}

/** Flatten media key rows into a flat R2 key list for a batched bucket delete. */
export function mediaKeysFromRows(rows: MediaKeyRow[]): string[] {
  return rows.flatMap((r) => [r.r2_key_original, r.r2_key_display, r.r2_key_thumb])
}

export async function listAllUsers(db: D1Database): Promise<AdminUserRow[]> {
  const { results } = await db
    .prepare('SELECT id, email, is_admin, created_at FROM users ORDER BY created_at, email')
    .all<AdminUserRow>()
  return results
}

export async function listAllGroups(db: D1Database): Promise<Group[]> {
  const { results } = await db.prepare('SELECT id, name FROM groups ORDER BY name').all<Group>()
  return results
}

export async function listAllMemberships(
  db: D1Database,
): Promise<{ user_id: string; group_id: string }[]> {
  const { results } = await db
    .prepare('SELECT user_id, group_id FROM memberships')
    .all<{ user_id: string; group_id: string }>()
  return results
}

/** media counts keyed by group id (groups absent from the map have zero). */
export async function mediaCountsByGroup(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare('SELECT group_id, COUNT(*) AS c FROM media GROUP BY group_id')
    .all<{ group_id: string; c: number }>()
  return new Map(results.map((r) => [r.group_id, r.c]))
}

/** media counts keyed by uploader id. */
export async function mediaCountsByUploader(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare('SELECT uploader_id, COUNT(*) AS c FROM media GROUP BY uploader_id')
    .all<{ uploader_id: string; c: number }>()
  return new Map(results.map((r) => [r.uploader_id, r.c]))
}

/**
 * Demote a member to non-admin, but never the last admin. The count re-check
 * lives *inside* the UPDATE's WHERE so the read and the write can't interleave
 * with a concurrent demote/delete (D1 serializes a single statement); a separate
 * `SELECT COUNT` then `UPDATE` would let two simultaneous demotes both pass and
 * reach zero admins. Returns false (nothing changed) only when the target is the
 * sole remaining admin — demoting an already-non-admin member is a no-op success.
 */
export async function demoteAdminIfNotLast(db: D1Database, id: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE users SET is_admin = 0
       WHERE id = ? AND (is_admin = 0 OR (SELECT COUNT(*) FROM users WHERE is_admin = 1) > 1)`,
    )
    .bind(id)
    .run()
  return (res.meta.changes ?? 0) > 0
}

/** Media uploaded by one member — for the AdminUser response after a mutation. */
export async function countMediaByUploader(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS c FROM media WHERE uploader_id = ?')
    .bind(userId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

/** Members assigned to one group — for the AdminGroup response after a mutation. */
export async function countGroupMembers(db: D1Database, groupId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS c FROM memberships WHERE group_id = ?')
    .bind(groupId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

/** Media in one group — for the AdminGroup response after a mutation. */
export async function countGroupMedia(db: D1Database, groupId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS c FROM media WHERE group_id = ?')
    .bind(groupId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

export async function getUserById(db: D1Database, id: string): Promise<AdminUserRow | null> {
  return db
    .prepare('SELECT id, email, is_admin, created_at FROM users WHERE id = ?')
    .bind(id)
    .first<AdminUserRow>()
}

export async function createUser(
  db: D1Database,
  p: { id: string; email: string; isAdmin: boolean },
): Promise<void> {
  await db
    .prepare('INSERT INTO users (id, email, is_admin) VALUES (?, ?, ?)')
    .bind(p.id, p.email, p.isAdmin ? 1 : 0)
    .run()
}

export async function setUserAdmin(db: D1Database, id: string, isAdmin: boolean): Promise<void> {
  await db
    .prepare('UPDATE users SET is_admin = ? WHERE id = ?')
    .bind(isAdmin ? 1 : 0, id)
    .run()
}

export async function listMediaKeysByUploader(
  db: D1Database,
  userId: string,
): Promise<MediaKeyRow[]> {
  const { results } = await db
    .prepare(
      'SELECT r2_key_original, r2_key_display, r2_key_thumb FROM media WHERE uploader_id = ?',
    )
    .bind(userId)
    .all<MediaKeyRow>()
  return results
}

export async function listMediaKeysByGroup(
  db: D1Database,
  groupId: string,
): Promise<MediaKeyRow[]> {
  const { results } = await db
    .prepare('SELECT r2_key_original, r2_key_display, r2_key_thumb FROM media WHERE group_id = ?')
    .bind(groupId)
    .all<MediaKeyRow>()
  return results
}

/**
 * Remove a member and everything that hangs off them — their uploaded media
 * rows and all their memberships — but never the last admin. The user-row delete
 * is conditional (same in-statement count re-check as {@link demoteAdminIfNotLast})
 * so two concurrent deletes can't both pass and reach zero admins; only if it
 * actually removed the row do we cascade the dependents. Returns false (nothing
 * deleted) when the target is the sole remaining admin.
 *
 * The user row goes first on purpose: once it's gone, `memberMiddleware` 403s
 * that identity, so a racing upload can't finalize a new row mid-cascade. Caller
 * snapshots {@link listMediaKeysByUploader} BEFORE this and purges R2 after.
 */
export async function deleteUserIfNotLastAdmin(db: D1Database, id: string): Promise<boolean> {
  const res = await db
    .prepare(
      `DELETE FROM users
       WHERE id = ? AND (is_admin = 0 OR (SELECT COUNT(*) FROM users WHERE is_admin = 1) > 1)`,
    )
    .bind(id)
    .run()
  if ((res.meta.changes ?? 0) === 0) return false
  await db.batch([
    db.prepare('DELETE FROM media WHERE uploader_id = ?').bind(id),
    db.prepare('DELETE FROM memberships WHERE user_id = ?').bind(id),
  ])
  return true
}

export async function getGroupById(db: D1Database, id: string): Promise<Group | null> {
  return db.prepare('SELECT id, name FROM groups WHERE id = ?').bind(id).first<Group>()
}

export async function createGroup(db: D1Database, p: { id: string; name: string }): Promise<void> {
  await db.prepare('INSERT INTO groups (id, name) VALUES (?, ?)').bind(p.id, p.name).run()
}

export async function renameGroup(db: D1Database, id: string, name: string): Promise<void> {
  await db.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(name, id).run()
}

/**
 * Delete a group and everything scoped to it — all its media rows and all its
 * memberships — atomically. Call after the group's blobs (listMediaKeysByGroup)
 * have been removed from R2.
 */
export async function deleteGroupCascade(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM media WHERE group_id = ?').bind(id),
    db.prepare('DELETE FROM memberships WHERE group_id = ?').bind(id),
    db.prepare('DELETE FROM groups WHERE id = ?').bind(id),
  ])
}

/** Idempotent: assigning an already-assigned member is a no-op. */
export async function addMembership(
  db: D1Database,
  userId: string,
  groupId: string,
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO memberships (user_id, group_id) VALUES (?, ?)')
    .bind(userId, groupId)
    .run()
}

export async function removeMembership(
  db: D1Database,
  userId: string,
  groupId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM memberships WHERE user_id = ? AND group_id = ?')
    .bind(userId, groupId)
    .run()
}
