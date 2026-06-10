import { useCallback, useEffect, useRef, useState } from 'react'
import type { Media, MeResponse } from '@cf-mediashare/shared'
import { ApiClientError, deleteMedia, getMe, listMedia, updateMedia } from './api/client.js'
import { Gallery } from './components/Gallery.js'
import { Lightbox } from './components/Lightbox.js'
import { ToastShelf, useToasts } from './components/Toasts.js'
import { UploadPanel } from './components/UploadPanel.js'
import { useUploader } from './lib/uploader.js'

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

  const selectGroup = (groupId: string) => {
    setSelectedGroupId(groupId)
    setLightboxIndex(null)
    localStorage.setItem(GROUP_STORAGE_KEY, groupId)
  }

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
  const gallery =
    selectedGroupId !== null ? (galleries[selectedGroupId] ?? EMPTY_GALLERY) : EMPTY_GALLERY

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
          <span className="user-email" title={me.user.email}>
            {me.user.email}
          </span>
        </div>
      </header>

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
