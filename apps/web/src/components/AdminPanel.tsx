/**
 * Operator console (F2): manage members, groups, and their assignments. Reached
 * from the topbar only by `isAdmin` users; every action is re-checked in the
 * Worker, so this UI is a convenience over the admin API, not the gate.
 *
 * Members × groups is rendered as a checkbox matrix — the clearest shape for the
 * small-trusted-group scale this app targets. After each mutation the overview
 * is refetched so counts and Access-sync state stay authoritative.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { AdminOverviewResponse } from '@cf-mediashare/shared'
import {
  assignGroup,
  createGroup,
  deleteGroup,
  deleteUser,
  getAdminOverview,
  inviteUser,
  renameGroup,
  unassignGroup,
  updateUser,
} from '../api/client.js'
import { formatDate } from '../lib/format.js'

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AdminOverviewResponse }

export function AdminPanel({
  currentUserId,
  onClose,
  pushToast,
}: {
  currentUserId: string
  onClose: () => void
  pushToast: (text: string) => void
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteAdmin, setInviteAdmin] = useState(false)
  const [newGroup, setNewGroup] = useState('')
  const [editGroup, setEditGroup] = useState<{ id: string; name: string } | null>(null)

  const refetch = useCallback(async () => {
    const data = await getAdminOverview()
    setLoad({ status: 'ready', data })
  }, [])

  useEffect(() => {
    refetch().catch((err: unknown) => {
      setLoad({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not load the admin data',
      })
    })
  }, [refetch])

  /**
   * Run a mutation guarded by a per-control busy flag, then reconcile by
   * refetching. Errors surface as a toast and leave the UI on the last good
   * state. Returns whether it succeeded so callers can clear their own inputs.
   */
  const run = useCallback(
    async (key: string, fn: () => Promise<void>): Promise<boolean> => {
      if (busy[key]) return false
      setBusy((b) => ({ ...b, [key]: true }))
      try {
        await fn()
        await refetch()
        return true
      } catch (err) {
        pushToast(err instanceof Error ? err.message : 'Something went wrong')
        return false
      } finally {
        setBusy((b) => ({ ...b, [key]: false }))
      }
    },
    [busy, refetch, pushToast],
  )

  if (load.status === 'loading') {
    return (
      <AdminFrame onClose={onClose}>
        <p className="muted admin-pad">Loading…</p>
      </AdminFrame>
    )
  }
  if (load.status === 'error') {
    return (
      <AdminFrame onClose={onClose}>
        <div className="admin-pad">
          <p>Couldn't load the admin data — {load.message}</p>
          <button className="btn" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      </AdminFrame>
    )
  }

  const { users, groups, access } = load.data
  const adminCount = users.filter((u) => u.isAdmin).length

  const onInvite = async (e: FormEvent) => {
    e.preventDefault()
    const email = inviteEmail.trim()
    if (email === '') return
    await run('invite', async () => {
      const res = await inviteUser({ email, isAdmin: inviteAdmin })
      setInviteEmail('')
      setInviteAdmin(false)
      if (res.accessSync === 'failed' || res.accessSync === 'skipped') {
        pushToast(res.accessMessage ?? 'Access allow-list was not updated.')
      }
    })
  }

  const onToggleAdmin = (userId: string, isAdmin: boolean) =>
    void run(`admin:${userId}`, async () => {
      await updateUser(userId, { isAdmin })
    })

  const onToggleMembership = (userId: string, groupId: string, assign: boolean) =>
    void run(`cell:${userId}:${groupId}`, async () => {
      if (assign) await assignGroup(userId, groupId)
      else await unassignGroup(userId, groupId)
    })

  const onRemoveUser = (userId: string, email: string, mediaCount: number) => {
    const media = mediaCount > 0 ? ` This also deletes ${mediaCount} item(s) they uploaded.` : ''
    if (!window.confirm(`Remove ${email}?${media} This can't be undone.`)) return
    void run(`del-user:${userId}`, async () => {
      const res = await deleteUser(userId)
      if (res.accessSync === 'failed' || res.accessSync === 'skipped') {
        pushToast(res.accessMessage ?? 'Access allow-list was not updated.')
      }
    })
  }

  const onCreateGroup = async (e: FormEvent) => {
    e.preventDefault()
    const name = newGroup.trim()
    if (name === '') return
    const ok = await run('create-group', async () => {
      await createGroup({ name })
    })
    if (ok) setNewGroup('')
  }

  const onRenameGroup = async (e: FormEvent) => {
    e.preventDefault()
    if (!editGroup) return
    const name = editGroup.name.trim()
    if (name === '') return
    const ok = await run(`group:${editGroup.id}`, async () => {
      await renameGroup(editGroup.id, { name })
    })
    if (ok) setEditGroup(null)
  }

  const onDeleteGroup = (id: string, name: string, mediaCount: number) => {
    const media = mediaCount > 0 ? ` This permanently deletes ${mediaCount} item(s) in it.` : ''
    if (!window.confirm(`Delete the group "${name}"?${media} This can't be undone.`)) return
    void run(`group:${id}`, async () => {
      await deleteGroup(id)
    })
  }

  return (
    <AdminFrame onClose={onClose}>
      {access.message && (
        <div className={`admin-banner${access.syncEnabled ? ' warn' : ''}`} role="note">
          {access.message}
        </div>
      )}

      <section className="admin-section">
        <h2>Invite a member</h2>
        <form className="admin-invite" onSubmit={onInvite}>
          <input
            type="email"
            required
            placeholder="email@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            aria-label="New member email"
          />
          <label className="admin-check">
            <input
              type="checkbox"
              checked={inviteAdmin}
              onChange={(e) => setInviteAdmin(e.target.checked)}
            />
            Admin
          </label>
          <button className="btn" type="submit" disabled={busy['invite']}>
            Invite
          </button>
        </form>
        <p className="muted admin-hint">
          Adds them to this deployment. Assign groups in the table below — a member sees nothing
          until they're in a group.
        </p>
      </section>

      <section className="admin-section">
        <h2>Members</h2>
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th className="admin-col-member">Member</th>
                <th>Admin</th>
                {groups.map((g) => (
                  <th key={g.id} className="admin-col-group" title={g.name}>
                    {g.name}
                  </th>
                ))}
                <th>Uploads</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const lastAdmin = u.isAdmin && adminCount <= 1
                // No self-mutation from the panel: demoting/removing yourself
                // would drop you off the admin surface (or out of the app) mid-
                // session. Hand admin to someone else, then have them do it.
                const isSelf = u.id === currentUserId
                return (
                  <tr key={u.id}>
                    <td className="admin-col-member">
                      <div className="admin-member-email">
                        {u.email}
                        {u.id === currentUserId && <span className="admin-tag">you</span>}
                        {access.syncEnabled && u.inAccessList === false && (
                          <span
                            className="admin-tag warn"
                            title="Not in the Cloudflare Access allow-list"
                          >
                            ⚠ not in Access
                          </span>
                        )}
                      </div>
                      <div className="muted admin-member-sub">added {formatDate(u.createdAt)}</div>
                    </td>
                    <td className="admin-cell-center">
                      <input
                        type="checkbox"
                        checked={u.isAdmin}
                        disabled={lastAdmin || isSelf || busy[`admin:${u.id}`]}
                        title={
                          isSelf
                            ? "You can't change your own admin status"
                            : lastAdmin
                              ? 'Cannot remove the last admin'
                              : 'Toggle admin'
                        }
                        onChange={(e) => onToggleAdmin(u.id, e.target.checked)}
                        aria-label={`Admin: ${u.email}`}
                      />
                    </td>
                    {groups.map((g) => {
                      const member = u.groupIds.includes(g.id)
                      return (
                        <td key={g.id} className="admin-cell-center">
                          <input
                            type="checkbox"
                            checked={member}
                            disabled={busy[`cell:${u.id}:${g.id}`]}
                            onChange={(e) => onToggleMembership(u.id, g.id, e.target.checked)}
                            aria-label={`${u.email} in ${g.name}`}
                          />
                        </td>
                      )
                    })}
                    <td className="admin-cell-center muted">{u.mediaCount}</td>
                    <td className="admin-cell-center">
                      <button
                        className="link-btn danger"
                        disabled={lastAdmin || isSelf || busy[`del-user:${u.id}`]}
                        title={
                          isSelf
                            ? "You can't remove your own account"
                            : lastAdmin
                              ? 'Cannot remove the last admin'
                              : 'Remove member'
                        }
                        onClick={() => onRemoveUser(u.id, u.email, u.mediaCount)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })}
              {groups.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted admin-pad">
                    No groups yet — create one below, then assign members.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-section">
        <h2>Groups</h2>
        <ul className="admin-group-list">
          {groups.map((g) => (
            <li key={g.id} className="admin-group-row">
              {editGroup?.id === g.id ? (
                <form className="admin-group-edit" onSubmit={onRenameGroup}>
                  <input
                    value={editGroup.name}
                    autoFocus
                    aria-label="Group name"
                    onChange={(e) => setEditGroup({ id: g.id, name: e.target.value })}
                  />
                  <button className="btn" type="submit" disabled={busy[`group:${g.id}`]}>
                    Save
                  </button>
                  <button className="link-btn" type="button" onClick={() => setEditGroup(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="admin-group-name">{g.name}</span>
                  <span className="muted admin-group-meta">
                    {g.memberCount} member{g.memberCount === 1 ? '' : 's'} · {g.mediaCount} item
                    {g.mediaCount === 1 ? '' : 's'}
                  </span>
                  <span className="admin-group-actions">
                    <button
                      className="link-btn"
                      onClick={() => setEditGroup({ id: g.id, name: g.name })}
                    >
                      Rename
                    </button>
                    <button
                      className="link-btn danger"
                      disabled={busy[`group:${g.id}`]}
                      onClick={() => onDeleteGroup(g.id, g.name, g.mediaCount)}
                    >
                      Delete
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
          {groups.length === 0 && <li className="muted">No groups yet.</li>}
        </ul>
        <form className="admin-invite" onSubmit={onCreateGroup}>
          <input
            placeholder="New group name"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            aria-label="New group name"
          />
          <button className="btn" type="submit" disabled={busy['create-group']}>
            Create group
          </button>
        </form>
      </section>
    </AdminFrame>
  )
}

function AdminFrame({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <main className="admin">
      <header className="admin-head">
        <button className="link-btn" onClick={onClose}>
          ← Gallery
        </button>
        <h1>Manage members &amp; groups</h1>
      </header>
      {children}
    </main>
  )
}
