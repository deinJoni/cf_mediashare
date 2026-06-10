/**
 * Upload pipeline (F3): derive → presign → PUT ×3 → finalize, as a React hook.
 *
 * Each file is a job that checkpoints its intermediate state (derived blobs,
 * presign response, which PUTs landed) in a ref, so Retry resumes from the
 * failed step instead of redoing work. At most MAX_CONCURRENT jobs run at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DERIVED_CONTENT_TYPE,
  MAX_FILE_NAME_LENGTH,
  PRESIGN_EXPIRY_SECONDS,
  type Media,
  type PresignUploadResponse,
} from '@cf-mediashare/shared'
import { createMedia, presignUpload, putBlob, putBlobWithProgress } from '../api/client.js'
import { deriveForFile, type Derived } from './derive.js'

export type UploadStage = 'queued' | 'preparing' | 'uploading' | 'finishing' | 'done' | 'error'

export interface UploadJob {
  id: string
  fileName: string
  groupId: string
  stage: UploadStage
  /** 0..1, progress of the original's PUT (the only large payload). */
  progress: number
  error: string | null
}

interface JobInternals {
  file: File
  groupId: string
  derived?: Derived
  presign?: PresignUploadResponse
  /** When the presign was issued — stale ones are discarded on retry. */
  presignedAt?: number
  putsDone: { original: boolean; display: boolean; thumb: boolean }
}

const MAX_CONCURRENT = 3
/** Re-presign a minute before the URLs actually expire. */
const PRESIGN_STALE_MS = (PRESIGN_EXPIRY_SECONDS - 60) * 1000

let nextJobId = 0

export function useUploader(onUploaded: (media: Media) => void) {
  const [jobs, setJobs] = useState<UploadJob[]>([])
  const internals = useRef(new Map<string, JobInternals>())
  const running = useRef(new Set<string>())
  const queue = useRef<string[]>([])
  const onUploadedRef = useRef(onUploaded)
  onUploadedRef.current = onUploaded

  const patchJob = useCallback((id: string, patch: Partial<UploadJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)))
  }, [])

  const runJob = useCallback(
    async (id: string) => {
      const internal = internals.current.get(id)
      if (!internal) return
      running.current.add(id)
      try {
        if (!internal.derived) {
          patchJob(id, { stage: 'preparing', error: null })
          internal.derived = await deriveForFile(internal.file)
        }
        const derived = internal.derived

        // A checkpointed presign older than its expiry can't be retried —
        // discard it so this run allocates a fresh media id + URLs.
        if (
          internal.presign &&
          internal.presignedAt !== undefined &&
          Date.now() - internal.presignedAt > PRESIGN_STALE_MS
        ) {
          internal.presign = undefined
        }
        if (!internal.presign) {
          internal.presign = await presignUpload({
            groupId: internal.groupId,
            kind: derived.kind,
            originalContentType: internal.file.type,
            originalExt: derived.ext,
            originalSizeBytes: internal.file.size,
          })
          internal.presignedAt = Date.now()
          // New media id ⇒ none of the previous PUTs (if any) count.
          internal.putsDone = { original: false, display: false, thumb: false }
        }
        const presign = internal.presign

        patchJob(id, { stage: 'uploading', error: null })
        if (!internal.putsDone.thumb) {
          await putBlob(presign.uploads.thumb, derived.thumb, DERIVED_CONTENT_TYPE)
          internal.putsDone.thumb = true
        }
        if (!internal.putsDone.display) {
          await putBlob(presign.uploads.display, derived.display, DERIVED_CONTENT_TYPE)
          internal.putsDone.display = true
        }
        if (!internal.putsDone.original) {
          await putBlobWithProgress(
            presign.uploads.original,
            internal.file,
            internal.file.type,
            (fraction) => patchJob(id, { progress: fraction }),
          )
          internal.putsDone.original = true
        }

        patchJob(id, { stage: 'finishing', progress: 1 })
        const media = await createMedia({
          mediaId: presign.mediaId,
          groupId: internal.groupId,
          kind: derived.kind,
          originalExt: derived.ext,
          originalContentType: internal.file.type,
          fileName: (internal.file.name || `upload.${derived.ext}`).slice(0, MAX_FILE_NAME_LENGTH),
          width: derived.width,
          height: derived.height,
          duration: derived.duration,
        })

        patchJob(id, { stage: 'done' })
        internals.current.delete(id)
        onUploadedRef.current(media)
      } catch (err) {
        patchJob(id, {
          stage: 'error',
          error: err instanceof Error ? err.message : 'Upload failed',
        })
      } finally {
        running.current.delete(id)
        pump()
      }
    },
    // `pump` and `runJob` are mutually recursive; the closure resolves `pump`
    // lazily at call time, after both memoized values exist.
    [patchJob],
  )

  const pump = useCallback(() => {
    while (running.current.size < MAX_CONCURRENT && queue.current.length > 0) {
      const id = queue.current.shift()
      if (id !== undefined && internals.current.has(id)) void runJob(id)
    }
  }, [runJob])

  const addFiles = useCallback(
    (files: File[], groupId: string) => {
      const fresh = files.map((file) => {
        const id = `u${nextJobId++}`
        internals.current.set(id, {
          file,
          groupId,
          putsDone: { original: false, display: false, thumb: false },
        })
        queue.current.push(id)
        return {
          id,
          fileName: file.name,
          groupId,
          stage: 'queued' as const,
          progress: 0,
          error: null,
        }
      })
      setJobs((prev) => [...prev, ...fresh])
      pump()
    },
    [pump],
  )

  const retry = useCallback(
    (id: string) => {
      if (!internals.current.has(id) || running.current.has(id)) return
      patchJob(id, { stage: 'queued', error: null, progress: 0 })
      queue.current.push(id)
      pump()
    },
    [patchJob, pump],
  )

  const dismiss = useCallback((id: string) => {
    internals.current.delete(id)
    queue.current = queue.current.filter((q) => q !== id)
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }, [])

  const clearFinished = useCallback(() => {
    setJobs((prev) => prev.filter((j) => j.stage !== 'done'))
  }, [])

  const activeCount = useMemo(
    () => jobs.filter((j) => j.stage !== 'done' && j.stage !== 'error').length,
    [jobs],
  )

  // Don't let a tab close silently kill in-flight uploads.
  useEffect(() => {
    if (activeCount === 0) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [activeCount])

  return { jobs, addFiles, retry, dismiss, clearFinished, activeCount }
}
