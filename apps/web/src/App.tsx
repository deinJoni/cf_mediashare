import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ARCHIVE_MAX_SELECTION_IDS,
  groupArchiveSelectionUrl,
  groupArchiveUrl,
  type ArchiveInfoResponse,
  type Media,
  type MeResponse,
} from '@cf-mediashare/shared'
import {
  ApiClientError,
  deleteMedia,
  getArchiveInfo,
  getMe,
  listMedia,
  updateMedia,
} from './api/client.js'
import { AdminPanel } from './components/AdminPanel.js'
import { Gallery } from './components/Gallery.js'
import { Lightbox } from './components/Lightbox.js'
import { ToastShelf, useToasts } from './components/Toasts.js'
import { UploadPanel } from './components/UploadPanel.js'
import { canClientZip, downloadClientZip, isPickerAbort } from './lib/archive.js'
import { formatBytes } from './lib/format.js'
import { useUploader } from './lib/uploader.js'

/** Hand a same-origin URL to the browser's download manager (mobile worker-zip path). */
function triggerBrowserDownload(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

type Session =
  | { state: 'loading' }
  | { state: 'denied'; message: string }
  | { state: 'error'; message: string }
  | { state: 'ready'; me: MeResponse }

interface GalleryState {
  items: Media[]
  nextCursor: string | null
  /** idle = never fetched; ready = at least one page loaded. */
  status: 'idle' | 'loading' | 'ready' | 'error'
}

const EMPTY_GALLERY: GalleryState = { items: [], nextCursor: null, status: 'idle' }
const GROUP_STORAGE_KEY = 'cf-mediashare:group'

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' })
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [galleries, setGalleries] = useState<Record<string, GalleryState>>({})
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [view, setView] = useState<'gallery' | 'admin'>('gallery')
  // Bulk-download state (F6): selection mode, part menu, client-side zip progress.
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [zipProgress, setZipProgress] = useState<{ written: number; total: number } | null>(null)
  const [archiveMenu, setArchiveMenu] = useState<ArchiveInfoResponse | null>(null)
  const [archiveMenuBusy, setArchiveMenuBusy] = useState(false)
  const { toasts, pushToast, dismissToast } = useToasts()
  // Guards double-fetches: the observer sentinel and effects can fire together.
  const inFlight = useRef(new Set<string>())

  const loadSession = useCallback(() => {
    setSession({ state: 'loading' })
    getMe()
      .then((me) => {
        setSession({ state: 'ready', me })
        const stored = localStorage.getItem(GROUP_STORAGE_KEY)
        const fallback = me.groups[0]?.id ?? null
        setSelectedGroupId(me.groups.some((g) => g.id === stored) ? stored : fallback)
      })
      .catch((err: unknown) => {
        if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
          setSession({ state: 'denied', message: err.message })
        } else {
          setSession({
            state: 'error',
            message: err instanceof Error ? err.message : 'Could not reach the server',
          })
        }
      })
  }, [])

  useEffect(loadSession, [loadSession])

  // Leaving the admin screen: refresh identity so the topbar group tabs reflect
  // any membership/group changes the operator made to their own account — but
  // in place, without tearing the UI down to the full-screen loading state (and
  // keeping the current group selected if it's still valid).
  const closeAdmin = useCallback(() => {
    setView('gallery')
    getMe()
      .then((me) => {
        setSession({ state: 'ready', me })
        setSelectedGroupId((current) =>
          current && me.groups.some((g) => g.id === current) ? current : (me.groups[0]?.id ?? null),
        )
      })
      .catch(() => {
        // Couldn't refresh — fall back to the full reload (handles revoked access).
        loadSession()
      })
  }, [loadSession])

  const loadMore = useCallback(
    (groupId: string) => {
      if (inFlight.current.has(groupId)) return
      const current = galleries[groupId] ?? EMPTY_GALLERY
      if (current.status === 'ready' && current.nextCursor === null) return
      inFlight.current.add(groupId)
      setGalleries((prev) => ({
        ...prev,
        [groupId]: { ...(prev[groupId] ?? EMPTY_GALLERY), status: 'loading' },
      }))
      listMedia(groupId, current.nextCursor !== null ? { cursor: current.nextCursor } : {})
        .then((page) => {
          setGalleries((prev) => {
            const before = prev[groupId] ?? EMPTY_GALLERY
            return {
              ...prev,
              [groupId]: {
                items: [...before.items, ...page.items],
                nextCursor: page.nextCursor,
                status: 'ready',
              },
            }
          })
        })
        .catch((err: unknown) => {
          setGalleries((prev) => ({
            ...prev,
            [groupId]: { ...(prev[groupId] ?? EMPTY_GALLERY), status: 'error' },
          }))
          pushToast(err instanceof Error ? err.message : 'Failed to load media')
        })
        .finally(() => inFlight.current.delete(groupId))
    },
    [galleries, pushToast],
  )

  // First page whenever a never-loaded group is selected.
  useEffect(() => {
    if (selectedGroupId === null) return
    if ((galleries[selectedGroupId] ?? EMPTY_GALLERY).status === 'idle') loadMore(selectedGroupId)
  }, [selectedGroupId, galleries, loadMore])

  const onUploaded = useCallback((media: Media) => {
    setGalleries((prev) => {
      const gallery = prev[media.groupId]
      // Group never browsed yet — it will fetch fresh (incl. this item) on first view.
      if (!gallery || gallery.status === 'idle') return prev
      return {
        ...prev,
        [media.groupId]: { ...gallery, items: [media, ...gallery.items] },
      }
    })
  }, [])

  const uploader = useUploader(onUploaded)

  // Stable identity so Gallery's IntersectionObserver isn't torn down per render.
  const loadSelected = useCallback(() => {
    if (selectedGroupId !== null) loadMore(selectedGroupId)
  }, [selectedGroupId, loadMore])

  const exitSelecting = useCallback(() => {
    setSelecting(false)
    setSelectedIds(new Set())
  }, [])

  const selectGroup = (groupId: string) => {
    setSelectedGroupId(groupId)
    setLightboxIndex(null)
    setSelecting(false)
    setSelectedIds(new Set())
    setArchiveMenu(null)
    localStorage.setItem(GROUP_STORAGE_KEY, groupId)
  }

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** Desktop path: pick a file once, stream the whole zip into it (F6). */
  const runClientZip = useCallback(
    async (items: Media[], suggestedName: string) => {
      try {
        setZipProgress({ written: 0, total: 1 })
        await downloadClientZip(items, suggestedName, (written, total) =>
          setZipProgress({ written, total }),
        )
        setSelecting(false)
        setSelectedIds(new Set())
      } catch (err) {
        // Cancelling the save-picker is a no-op, not an error.
        if (!isPickerAbort(err)) {
          pushToast(err instanceof Error ? err.message : 'Download failed')
        }
      } finally {
        setZipProgress(null)
      }
    },
    [pushToast],
  )

  const addFiles = (files: File[]) => {
    if (selectedGroupId === null) return
    uploader.addFiles(files, selectedGroupId)
  }

  const saveCaption = async (media: Media, caption: string | null) => {
    try {
      const updated = await updateMedia(media.id, { caption })
      setGalleries((prev) => {
        const gallery = prev[media.groupId]
        if (!gallery) return prev
        return {
          ...prev,
          [media.groupId]: {
            ...gallery,
            items: gallery.items.map((m) => (m.id === media.id ? updated : m)),
          },
        }
      })
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Could not save the caption')
      throw err
    }
  }

  const removeMedia = async (media: Media) => {
    try {
      await deleteMedia(media.id)
      setGalleries((prev) => {
        const gallery = prev[media.groupId]
        if (!gallery) return prev
        return {
          ...prev,
          [media.groupId]: {
            ...gallery,
            items: gallery.items.filter((m) => m.id !== media.id),
          },
        }
      })
      setLightboxIndex((current) => {
        if (current === null) return null
        const remaining = (galleries[media.groupId]?.items.length ?? 1) - 1
        if (remaining <= 0) return null
        return Math.min(current, remaining - 1)
      })
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Could not delete the item')
    }
  }

  if (session.state === 'loading') {
    return (
      <main className="screen-center">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  if (session.state === 'denied') {
    return (
      <main className="screen-center">
        <div className="notice-card">
          <h1>cf-mediashare</h1>
          <p>You're signed in, but not on the member list of this deployment.</p>
          <p className="muted">Ask the person running it to add your email. ({session.message})</p>
        </div>
      </main>
    )
  }

  if (session.state === 'error') {
    return (
      <main className="screen-center">
        <div className="notice-card">
          <h1>cf-mediashare</h1>
          <p>Couldn't reach the server — {session.message}</p>
          <button className="btn" onClick={loadSession}>
            Try again
          </button>
        </div>
      </main>
    )
  }

  const { me } = session

  if (view === 'admin' && me.user.isAdmin) {
    return (
      <>
        <AdminPanel currentUserId={me.user.id} onClose={closeAdmin} pushToast={pushToast} />
        <ToastShelf toasts={toasts} onDismiss={dismissToast} />
      </>
    )
  }

  const gallery =
    selectedGroupId !== null ? (galleries[selectedGroupId] ?? EMPTY_GALLERY) : EMPTY_GALLERY

  const groupName = me.groups.find((g) => g.id === selectedGroupId)?.name ?? 'archive'

  /** Selection download (F6): client-side zip where the browser allows it. */
  const downloadSelected = async () => {
    if (selectedGroupId === null) return
    const items = gallery.items.filter((m) => selectedIds.has(m.id))
    if (items.length === 0) return
    if (canClientZip()) {
      await runClientZip(items, `${groupName}-selection.zip`)
      return
    }
    // Worker-zip path (mobile/Safari/Firefox): ids ride in the URL, capped.
    if (items.length > ARCHIVE_MAX_SELECTION_IDS) {
      pushToast(
        `On this browser a selection download is capped at ${ARCHIVE_MAX_SELECTION_IDS} items — ` +
          'pick fewer, or use Download all which streams in parts.',
      )
      return
    }
    triggerBrowserDownload(
      groupArchiveSelectionUrl(
        selectedGroupId,
        items.map((m) => m.id),
      ),
    )
    setSelecting(false)
    setSelectedIds(new Set())
  }

  /** Download all (F6). The full item list is walked fresh — the gallery may
   * only have a few pages loaded, and JSON pages are cheap next to the bytes. */
  const downloadAll = async () => {
    if (selectedGroupId === null) return
    if (canClientZip()) {
      try {
        const items: Media[] = []
        let cursor: string | undefined
        for (;;) {
          const page = await listMedia(selectedGroupId, cursor ? { cursor } : {})
          items.push(...page.items)
          if (page.nextCursor === null) break
          cursor = page.nextCursor
        }
        if (items.length === 0) return
        await runClientZip(items, `${groupName}.zip`)
      } catch (err) {
        if (!isPickerAbort(err)) {
          pushToast(err instanceof Error ? err.message : 'Download failed')
        }
      }
      return
    }
    // Worker-zip path: fetch the part plan. One part → straight to the
    // download manager; several → menu so the member grabs them in order.
    setArchiveMenuBusy(true)
    try {
      const info = await getArchiveInfo(selectedGroupId)
      if (info.parts.length === 0) {
        pushToast('Nothing to download yet')
      } else if (info.parts.length === 1) {
        triggerBrowserDownload(groupArchiveUrl(selectedGroupId, 1))
      } else {
        setArchiveMenu(info)
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Could not plan the download')
    } finally {
      setArchiveMenuBusy(false)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">cf-mediashare</span>
        <nav className="group-tabs" aria-label="Groups">
          {me.groups.map((group) => (
            <button
              key={group.id}
              className={`group-tab${group.id === selectedGroupId ? ' active' : ''}`}
              aria-current={group.id === selectedGroupId}
              onClick={() => selectGroup(group.id)}
            >
              {group.name}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {selectedGroupId !== null && gallery.items.length > 0 && (
            <>
              <button className="ghost-btn" onClick={() => setSelecting(true)}>
                Select
              </button>
              <span className="download-all-wrap">
                <button
                  className="ghost-btn"
                  disabled={archiveMenuBusy}
                  onClick={() => void downloadAll()}
                >
                  {archiveMenuBusy ? 'Planning…' : 'Download all'}
                </button>
                {archiveMenu && (
                  <div className="download-menu" role="menu">
                    <p className="download-menu-head">
                      {archiveMenu.itemCount} items · {formatBytes(archiveMenu.totalBytes)} — grab
                      each part:
                    </p>
                    {archiveMenu.parts.map((p) => (
                      <a
                        key={p.part}
                        className="download-part"
                        href={groupArchiveUrl(selectedGroupId, p.part)}
                        download
                      >
                        Part {p.part} of {archiveMenu.parts.length} · {p.itemCount} items ·{' '}
                        {formatBytes(p.zipBytes)}
                      </a>
                    ))}
                    <button className="link-btn" onClick={() => setArchiveMenu(null)}>
                      Close
                    </button>
                  </div>
                )}
              </span>
            </>
          )}
          {selectedGroupId !== null && (
            <label className="btn upload-btn">
              Upload
              <input
                type="file"
                multiple
                accept="image/*,video/*"
                hidden
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />
            </label>
          )}
          {me.user.isAdmin && (
            <button className="link-btn admin-link" onClick={() => setView('admin')}>
              Admin
            </button>
          )}
          <span className="user-email" title={me.user.email}>
            {me.user.email}
          </span>
          {zipProgress !== null && (
            <span className="zip-progress" role="status">
              Zipping… {Math.round((zipProgress.written / zipProgress.total) * 100)}%
            </span>
          )}
        </div>
      </header>

      {selecting && (
        <div className="selection-bar" role="toolbar" aria-label="Selection">
          <span className="selection-count">{selectedIds.size} selected</span>
          <button
            className="link-btn"
            onClick={() => setSelectedIds(new Set(gallery.items.map((m) => m.id)))}
          >
            Select all loaded
          </button>
          <button
            className="btn"
            disabled={selectedIds.size === 0 || zipProgress !== null}
            onClick={() => void downloadSelected()}
          >
            Download zip
          </button>
          <button className="link-btn" onClick={exitSelecting}>
            Cancel
          </button>
        </div>
      )}

      {me.groups.length === 0 ? (
        <main className="screen-center">
          <div className="notice-card">
            <p>You're a member, but not in any group yet.</p>
            <p className="muted">Ask the operator to add you to one.</p>
          </div>
        </main>
      ) : (
        <Gallery
          items={gallery.items}
          // 'error' must NOT count as hasMore: the observer sentinel would
          // refetch in a tight loop. Recovery goes through the Retry button.
          hasMore={
            gallery.status !== 'error' && (gallery.nextCursor !== null || gallery.status === 'idle')
          }
          loading={gallery.status === 'loading'}
          error={gallery.status === 'error'}
          onLoadMore={loadSelected}
          onOpen={setLightboxIndex}
          onDropFiles={addFiles}
          selecting={selecting}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
        />
      )}

      {lightboxIndex !== null && gallery.items.length > 0 && (
        <Lightbox
          items={gallery.items}
          index={Math.min(lightboxIndex, gallery.items.length - 1)}
          user={me.user}
          hasMore={gallery.status !== 'error' && gallery.nextCursor !== null}
          onNavigate={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onLoadMore={loadSelected}
          onSaveCaption={saveCaption}
          onDelete={removeMedia}
        />
      )}

      <UploadPanel
        jobs={uploader.jobs}
        onRetry={uploader.retry}
        onDismiss={uploader.dismiss}
        onClearFinished={uploader.clearFinished}
      />
      <ToastShelf toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
