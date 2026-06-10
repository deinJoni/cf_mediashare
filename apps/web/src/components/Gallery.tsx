/** Per-group thumbnail grid (F4): lazy images, infinite scroll, drag-drop uploads. */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { mediaUrl, type Media } from '@cf-mediashare/shared'
import { formatDuration } from '../lib/format.js'

export function Gallery({
  items,
  hasMore,
  loading,
  error,
  onLoadMore,
  onOpen,
  onDropFiles,
}: {
  items: Media[]
  hasMore: boolean
  loading: boolean
  error: boolean
  onLoadMore: () => void
  onOpen: (index: number) => void
  onDropFiles: (files: File[]) => void
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // Counter instead of boolean: dragenter/dragleave fire for every child node.
  const dragDepth = useRef(0)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore()
      },
      { rootMargin: '600px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore, items.length])

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragOver(false)
      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) onDropFiles(files)
    },
    [onDropFiles],
  )

  return (
    <section
      className={`gallery${dragOver ? ' drag-over' : ''}`}
      aria-label="Media gallery"
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {items.length === 0 && !loading && !error && (
        <div className="empty-state">
          <p>Nothing here yet.</p>
          <p className="muted">Drop photos or videos anywhere, or use the Upload button.</p>
        </div>
      )}

      <div className="grid">
        {items.map((media, index) => (
          <button
            key={media.id}
            className="tile"
            onClick={() => onOpen(index)}
            aria-label={media.caption ?? media.fileName}
          >
            <img src={mediaUrl(media.id, 'thumb')} alt={media.caption ?? ''} loading="lazy" />
            {media.kind === 'video' && (
              <span className="tile-badge">
                <span aria-hidden="true">▶</span>
                {media.duration !== null && <span>{formatDuration(media.duration)}</span>}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && <p className="muted gallery-status">Loading…</p>}
      {error && (
        <div className="gallery-status">
          <p className="muted">Couldn't load media.</p>
          <button className="btn" onClick={onLoadMore}>
            Retry
          </button>
        </div>
      )}
      {hasMore && <div ref={sentinelRef} className="sentinel" aria-hidden="true" />}

      {dragOver && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop to upload</span>
        </div>
      )}
    </section>
  )
}
