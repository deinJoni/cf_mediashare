import { Hono } from 'hono'
import {
  CreateGroupRequestSchema,
  CreateUserRequestSchema,
  UpdateGroupRequestSchema,
  UpdateUserRequestSchema,
} from '@cf-mediashare/shared'
import type {
  AdminGroup,
  AdminOverviewResponse,
  AdminUser,
  CreateUserResponse,
  DeleteUserResponse,
  OkResponse,
} from '@cf-mediashare/shared'
import type { AppBindings } from '../env.js'
import {
  addEmailToAllowlist,
  accessSyncEnabled,
  getAllowlistEmails,
  removeEmailFromAllowlist,
} from '../lib/access-admin.js'
import {
  addMembership,
  countGroupMedia,
  countGroupMembers,
  countMediaByUploader,
  createGroup,
  createUser,
  deleteGroupCascade,
  deleteUserIfNotLastAdmin,
  demoteAdminIfNotLast,
  getGroupById,
  getUserByEmail,
  getUserById,
  listAllGroups,
  listAllMemberships,
  listAllUsers,
  listGroupsForUser,
  listMediaKeysByGroup,
  listMediaKeysByUploader,
  mediaCountsByGroup,
  mediaCountsByUploader,
  mediaKeysFromRows,
  removeMembership,
  renameGroup,
  setUserAdmin,
} from '../lib/db.js'
import type { AdminUserRow } from '../lib/db.js'
import { apiError, zodMessage } from '../lib/errors.js'
import { deleteR2Objects } from '../lib/r2.js'

/**
 * `inAccessList` for a single user: true/false against a read allow-list, or
 * null when sync is off (the set is unreadable). Shared by every endpoint that
 * returns one AdminUser.
 */
function inAccessList(email: string, allowlist: Set<string> | null): boolean | null {
  return allowlist === null ? null : allowlist.has(email.toLowerCase())
}

/** Build the AdminUser wire shape for one freshly-mutated member. */
async function buildAdminUser(
  db: D1Database,
  row: AdminUserRow,
  allowlist: Set<string> | null,
): Promise<AdminUser> {
  const [groups, mediaCount] = await Promise.all([
    listGroupsForUser(db, row.id),
    countMediaByUploader(db, row.id),
  ])
  return {
    id: row.id,
    email: row.email,
    isAdmin: !!row.is_admin,
    createdAt: row.created_at,
    groupIds: groups.map((g) => g.id),
    mediaCount,
    inAccessList: inAccessList(row.email, allowlist),
  }
}

export const adminRoutes = new Hono<AppBindings>()
  /**
   * `GET /api/admin/overview` (F2) — the whole member/group picture in one
   * round-trip: members with their groups + upload counts, groups with member +
   * media counts, and the Access sync status (incl. per-member allow-list
   * presence so the operator can spot D1↔Access drift).
   */
  .get('/admin/overview', async (c) => {
    const db = c.env.DB
    const [users, groups, memberships, mediaByGroup, mediaByUploader, allowlist] =
      await Promise.all([
        listAllUsers(db),
        listAllGroups(db),
        listAllMemberships(db),
        mediaCountsByGroup(db),
        mediaCountsByUploader(db),
        getAllowlistEmails(c.env),
      ])

    const groupIdsByUser = new Map<string, string[]>()
    const memberCountByGroup = new Map<string, number>()
    for (const m of memberships) {
      const list = groupIdsByUser.get(m.user_id)
      if (list) list.push(m.group_id)
      else groupIdsByUser.set(m.user_id, [m.group_id])
      memberCountByGroup.set(m.group_id, (memberCountByGroup.get(m.group_id) ?? 0) + 1)
    }

    const groupOrder = new Map(groups.map((g) => [g.id, g.name] as const))
    const sortGroupIds = (ids: string[]) =>
      [...ids].sort((a, b) => (groupOrder.get(a) ?? '').localeCompare(groupOrder.get(b) ?? ''))

    const syncEnabled = accessSyncEnabled(c.env)
    const body: AdminOverviewResponse = {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        isAdmin: !!u.is_admin,
        createdAt: u.created_at,
        groupIds: sortGroupIds(groupIdsByUser.get(u.id) ?? []),
        mediaCount: mediaByUploader.get(u.id) ?? 0,
        inAccessList: inAccessList(u.email, allowlist),
      })),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        memberCount: memberCountByGroup.get(g.id) ?? 0,
        mediaCount: mediaByGroup.get(g.id) ?? 0,
      })),
      access: {
        syncEnabled,
        listAvailable: allowlist !== null,
        message: !syncEnabled
          ? 'Cloudflare Access sync is off. After inviting someone here, also add their email to your Access allow-list so they can sign in.'
          : allowlist === null
            ? 'Access sync is configured, but the allow-list could not be read — check the API token and Access app config.'
            : undefined,
      },
    }
    return c.json(body)
  })
  /**
   * `POST /api/admin/users` (F2) — invite a member: insert the D1 row (the
   * authoritative gate), assign any requested groups, then best-effort add the
   * email to the Access allow-list. A failed Access sync still returns 200 with
   * an `accessSync` status, because the member already exists in D1.
   */
  .post('/admin/users', async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined)
    const parsed = CreateUserRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(apiError('bad_request', zodMessage(parsed.error)), 400)
    }
    const email = parsed.data.email.trim().toLowerCase()
    const isAdmin = parsed.data.isAdmin ?? false
    const groupIds = parsed.data.groupIds ?? []

    if (await getUserByEmail(c.env.DB, email)) {
      return c.json(apiError('conflict', 'A member with that email already exists'), 409)
    }
    // Reject unknown group ids rather than silently dropping the assignment.
    if (groupIds.length > 0) {
      const known = new Set((await listAllGroups(c.env.DB)).map((g) => g.id))
      const unknown = groupIds.filter((id) => !known.has(id))
      if (unknown.length > 0) {
        return c.json(apiError('bad_request', `Unknown group(s): ${unknown.join(', ')}`), 400)
      }
    }

    const id = crypto.randomUUID()
    await createUser(c.env.DB, { id, email, isAdmin })
    for (const groupId of groupIds) {
      await addMembership(c.env.DB, id, groupId)
    }

    const sync = await addEmailToAllowlist(c.env, email)

    // inAccessList for the response: a synced add means the email is now present,
    // so infer it instead of a third CF round-trip (and to sidestep read-after-
    // write lag); only read the policy back when the add failed and the state is
    // genuinely unknown. `disabled` -> unknowable (null).
    const allowlist =
      sync.status === 'synced'
        ? new Set([email])
        : sync.status === 'disabled'
          ? null
          : await getAllowlistEmails(c.env)

    const row = await getUserById(c.env.DB, id)
    if (!row) throw new Error('user row missing immediately after insert')
    const body: CreateUserResponse = {
      user: await buildAdminUser(c.env.DB, row, allowlist),
      accessSync: sync.status,
      accessMessage: sync.message,
    }
    return c.json(body)
  })
  /**
   * `PATCH /api/admin/users/:id` (F2) — promote/demote an admin. Refuses to
   * remove the last admin, which would lock everyone out of this surface. The
   * demote guard is atomic (see {@link demoteAdminIfNotLast}) so concurrent
   * demotes can't both slip past and reach zero admins.
   */
  .patch('/admin/users/:id', async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined)
    const parsed = UpdateUserRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(apiError('bad_request', zodMessage(parsed.error)), 400)
    }
    const row = await getUserById(c.env.DB, c.req.param('id'))
    if (!row) {
      return c.json(apiError('not_found'), 404)
    }

    if (parsed.data.isAdmin) {
      await setUserAdmin(c.env.DB, row.id, true)
    } else if (!(await demoteAdminIfNotLast(c.env.DB, row.id))) {
      return c.json(apiError('last_admin', 'Cannot remove the last admin'), 409)
    }
    const updated: AdminUserRow = { ...row, is_admin: parsed.data.isAdmin ? 1 : 0 }
    return c.json(await buildAdminUser(c.env.DB, updated, await getAllowlistEmails(c.env)))
  })
  /**
   * `DELETE /api/admin/users/:id` (F2) — remove a member. Cascades their
   * uploaded media (rows + R2 blobs) and memberships, and pulls their email from
   * the Access allow-list. Refuses to delete the last admin, or the operator's
   * own account.
   */
  .delete('/admin/users/:id', async (c) => {
    const row = await getUserById(c.env.DB, c.req.param('id'))
    if (!row) {
      return c.json(apiError('not_found'), 404)
    }
    // Self-removal would 403 the operator out of the whole app (not just admin)
    // and cascade their own media — make them hand off to another admin first.
    if (row.id === c.get('user').id) {
      return c.json(apiError('self_delete', "You can't remove your own account"), 409)
    }

    // Snapshot the blob keys before the rows go. Delete D1 first: the user-row
    // delete is the atomic last-admin gate AND, once gone, memberMiddleware 403s
    // that identity so a racing upload can't finalize a new row mid-cascade.
    // Then purge R2 best-effort — D1 is authoritative, so a blob-cleanup hiccup
    // must not report the removal as failed (it would orphan blobs, never rows).
    const keys = mediaKeysFromRows(await listMediaKeysByUploader(c.env.DB, row.id))
    if (!(await deleteUserIfNotLastAdmin(c.env.DB, row.id))) {
      return c.json(apiError('last_admin', 'Cannot delete the last admin'), 409)
    }
    try {
      await deleteR2Objects(c.env.MEDIA_BUCKET, keys)
    } catch (err) {
      console.error('R2 cleanup after member delete failed', err)
    }

    const sync = await removeEmailFromAllowlist(c.env, row.email)
    const body: DeleteUserResponse = {
      ok: true,
      accessSync: sync.status,
      accessMessage: sync.message,
    }
    return c.json(body)
  })
  /** `PUT /api/admin/users/:id/groups/:groupId` (F2) — assign a member to a group. */
  .put('/admin/users/:id/groups/:groupId', async (c) => {
    const { id, groupId } = c.req.param()
    const [user, group] = await Promise.all([
      getUserById(c.env.DB, id),
      getGroupById(c.env.DB, groupId),
    ])
    if (!user || !group) {
      return c.json(apiError('not_found'), 404)
    }
    await addMembership(c.env.DB, id, groupId)
    const body: OkResponse = { ok: true }
    return c.json(body)
  })
  /** `DELETE /api/admin/users/:id/groups/:groupId` (F2) — unassign (idempotent). */
  .delete('/admin/users/:id/groups/:groupId', async (c) => {
    const { id, groupId } = c.req.param()
    await removeMembership(c.env.DB, id, groupId)
    const body: OkResponse = { ok: true }
    return c.json(body)
  })
  /** `POST /api/admin/groups` (F2) — create a group. */
  .post('/admin/groups', async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined)
    const parsed = CreateGroupRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(apiError('bad_request', zodMessage(parsed.error)), 400)
    }
    const id = crypto.randomUUID()
    await createGroup(c.env.DB, { id, name: parsed.data.name })
    const body: AdminGroup = { id, name: parsed.data.name, memberCount: 0, mediaCount: 0 }
    return c.json(body)
  })
  /** `PATCH /api/admin/groups/:id` (F2) — rename a group. */
  .patch('/admin/groups/:id', async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined)
    const parsed = UpdateGroupRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(apiError('bad_request', zodMessage(parsed.error)), 400)
    }
    const group = await getGroupById(c.env.DB, c.req.param('id'))
    if (!group) {
      return c.json(apiError('not_found'), 404)
    }
    await renameGroup(c.env.DB, group.id, parsed.data.name)
    const [memberCount, mediaCount] = await Promise.all([
      countGroupMembers(c.env.DB, group.id),
      countGroupMedia(c.env.DB, group.id),
    ])
    const body: AdminGroup = { id: group.id, name: parsed.data.name, memberCount, mediaCount }
    return c.json(body)
  })
  /**
   * `DELETE /api/admin/groups/:id` (F2) — delete a group and everything in it:
   * all its media (rows + R2 blobs) and all its memberships.
   */
  .delete('/admin/groups/:id', async (c) => {
    const group = await getGroupById(c.env.DB, c.req.param('id'))
    if (!group) {
      return c.json(apiError('not_found'), 404)
    }
    // Snapshot blob keys, drop the D1 rows first (deleting the memberships closes
    // the member gate so a racing upload to this group can't finalize a new row),
    // then purge R2 best-effort — D1 is authoritative, so a blob-cleanup hiccup
    // must not fail the delete (it would orphan blobs, never leave a dangling row).
    const keys = mediaKeysFromRows(await listMediaKeysByGroup(c.env.DB, group.id))
    await deleteGroupCascade(c.env.DB, group.id)
    try {
      await deleteR2Objects(c.env.MEDIA_BUCKET, keys)
    } catch (err) {
      console.error('R2 cleanup after group delete failed', err)
    }
    const body: OkResponse = { ok: true }
    return c.json(body)
  })
