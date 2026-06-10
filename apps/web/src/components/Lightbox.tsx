/** Full-viewport viewer (F5–F7): display-size photos with explicit original
 * fetch, range-seeking video, caption edit, delete, and download. */
import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react'
import {
  MAX_CAPTION_LENGTH,
  mediaDownloadUrl,
  mediaUrl,
  type Media,
  type User,
} from '@cf-mediashare/shared'
import { formatBytes, formatDate, formatDuration } from '../lib/format.js'

export function Lightbox({
  items,
  index,
  user,
  hasMore,
  onNavigate,
  onClose,
  onLoadMore,
  onSaveCaption,
  onDelete,
}: {
  items: Media[]
  index: number
  user: User
  hasMore: boolean
  onNavigate: (index: number) => void
  onClose: () => void
  onLoadMore: () => void
  onSaveCaption: (media: Media, caption: string | null) => Promise<void>
  onDelete: (media: Media) => Promise<void>
}) {
  const media = items[index]
  const canManage = media !== undefined && (user.isAdmin || user.id === media.uploaderId)

  const [showOriginal, setShowOriginal] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftCaption, setDraftCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [infoOpen, setInfoOpen] = useState(true)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<Element | null>(null)
  const touchStartX = useRef<number | null>(null)

  // Per-item view state resets when navigating.
  useEffect(() => {
    setShowOriginal(false)
    setEditing(false)
    setBusy(false)
  }, [index, media?.id])

  // Take focus on open so keyboard navigation works immediately; give it back on close.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement
    rootRef.current?.focus()
    return () => {
      if (restoreFocusRef.current instanceof HTMLElement) restoreFocusRef.current.focus()
    }
  }, [])

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= items.length) return
      onNavigate(next)
      // Browsing near the end of what's loaded? Pull the next page in.
      if (hasMore && next >= items.length - 3) onLoadMore()
    },
    [items.length, hasMore, onNavigate, onLoadMore],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editing) return
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') goTo(index - 1)
      else if (event.key === 'ArrowRight') goTo(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, goTo, index, onClose])

  // Swiping must not hijack touches meant for interactive children — video
  // timeline scrubbing and caption editing are horizontal gestures too.
  const isInteractiveTarget = (target: EventTarget | null) =>
    target instanceof Element && target.closest('video, textarea, button, a, input') !== null

  const onTouchStart = (event: TouchEvent) => {
    touchStartX.current =
      editing || isInteractiveTarget(event.target) ? null : (event.touches[0]?.clientX ?? null)
  }
  const onTouchEnd = (event: TouchEvent) => {
    const start = touchStartX.current
    touchStartX.current = null
    const end = event.changedTouches[0]?.clientX
    if (start === null || end === undefined || editing) return
    const delta = end - start
    if (Math.abs(delta) > 60) goTo(delta < 0 ? index + 1 : index - 1)
  }

  if (media === undefined) return null

  const startEditing = () => {
    setDraftCaption(media.caption ?? '')
    setEditing(true)
  }

  const saveCaption = async () => {
    setBusy(true)
    try {
      const trimmed = draftCaption.trim()
      await onSaveCaption(media, trimmed === '' ? null : trimmed)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (!window.confirm(`Delete "${media.fileName}"? This removes it for everyone.`)) return
    setBusy(true)
    try {
      await onDelete(media)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={media.caption ?? media.fileName}
      tabIndex={-1}
      ref={rootRef}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <button className="lightbox-close icon-btn" aria-label="Close" onClick={onClose}>
        ×
      </button>

      {index > 0 && (
        <button
          className="lightbox-nav prev icon-btn"
          aria-label="Previous"
          onClick={() => goTo(index - 1)}
        >
          ‹
        </button>
      )}
      {index < items.length - 1 && (
        <button
          className="lightbox-nav next icon-btn"
          aria-label="Next"
          onClick={() => goTo(index + 1)}
        >
          ›
        </button>
      )}

      <figure className="lightbox-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {media.kind === 'photo' ? (
          <img
            key={`${media.id}-${showOriginal ? 'original' : 'display'}`}
            src={mediaUrl(media.id, showOriginal ? 'original' : 'display')}
            alt={media.caption ?? media.fileName}
          />
        ) : (
          <video
            key={media.id}
            controls
            autoPlay
            playsInline
            poster={mediaUrl(media.id, 'display')}
            src={mediaUrl(media.id, 'original')}
          />
        )}
      </figure>

      <div className={`lightbox-info${infoOpen ? '' : ' collapsed'}`}>
        <button
          className="lightbox-info-toggle link-btn"
          aria-expanded={infoOpen}
          onClick={() => setInfoOpen((open) => !open)}
        >
          {infoOpen ? 'Hide info' : 'Info'}
        </button>

        {infoOpen && (
          <>
            <div className="lightbox-caption">
              {editing ? (
                <div className="caption-editor">
                  <textarea
                    value={draftCaption}
                    maxLength={MAX_CAPTION_LENGTH}
                    rows={2}
                    autoFocus
                    onChange={(e) => setDraftCaption(e.target.value)}
                    aria-label="Caption"
                  />
                  <div className="caption-editor-actions">
                    <button className="btn" disabled={busy} onClick={() => void saveCaption()}>
                      Save
                    </button>
                    <button className="link-btn" disabled={busy} onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p>
                  {media.caption ?? <span className="muted">No caption</span>}
                  {canManage && (
                    <button className="link-btn caption-edit" onClick={startEditing}>
                      Edit
                    </button>
                  )}
                </p>
              )}
            </div>

            <dl className="lightbox-meta">
              <div>
                <dt>By</dt>
                <dd>{media.uploaderEmail}</dd>
              </div>
              <div>
                <dt>On</dt>
                <dd>{formatDate(media.createdAt)}</dd>
              </div>
              {media.width !== null && media.height !== null && (
                <div>
                  <dt>Size</dt>
                  <dd>
                    {media.width}×{media.height}
                  </dd>
                </div>
              )}
              {media.duration !== null && (
                <div>
                  <dt>Length</dt>
                  <dd>{formatDuration(media.duration)}</dd>
                </div>
              )}
              <div>
                <dt>File</dt>
                <dd title={media.fileName}>
                  {media.fileName} · {formatBytes(media.sizeBytes)}
                </dd>
              </div>
            </dl>

            <div className="lightbox-actions">
              <a className="btn" href={mediaDownloadUrl(media.id)} download={media.fileName}>
                Download
              </a>
              {media.kind === 'photo' && !showOriginal && (
                <button className="link-btn" onClick={() => setShowOriginal(true)}>
                  View original ({formatBytes(media.sizeBytes)})
                </button>
              )}
              {canManage && (
                <button
                  className="link-btn danger"
                  disabled={busy}
                  onClick={() => void confirmDelete()}
                >
                  Delete
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
