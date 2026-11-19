/**
 * Client-side bulk download (F6, the desktop path): stream a store-mode zip
 * straight into a file the user picks via the File System Access API. Uses the
 * same shared zipStore as the Worker's archive route — one zip implementation,
 * two writers. Originals arrive via the same `/api/media/:id/download` route
 * the single-file button uses, so no new endpoint or auth surface is needed.
 *
 * Browsers without the API (Firefox, Safari, all of iOS) take the worker-side
 * `/archive` URLs instead — the caller checks {@link canClientZip}.
 */
import { mediaDownloadUrl, zipPlannedSize, zipStore } from '@cf-mediashare/shared'
import type { Media, ZipEntryInput } from '@cf-mediashare/shared'

/** Minimal File System Access surface — lib.dom doesn't ship these types yet. */
interface FileSystemWritableLike {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
interface SaveFilePickerResult {
  createWritable(): Promise<FileSystemWritableLike>
}
declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string
      types?: { description?: string; accept: Record<string, string[]> }[]
    }) => Promise<SaveFilePickerResult>
  }
}

/** True on desktop Chromium — the only place the save-picker exists. */
export function canClientZip(): boolean {
  return typeof window.showSaveFilePicker === 'function'
}

/**
 * Is this the user cancelling the save-picker? That flow isn't an error — the
 * caller should swallow it quietly instead of toasting.
 */
export function isPickerAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/**
 * Zip `items` into a user-picked file. `onProgress(written, total)` reports
 * exact byte progress — the planned size is deterministic, so the percentage
 * is real, not an estimate.
 */
export async function downloadClientZip(
  items: Media[],
  suggestedName: string,
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const picker = window.showSaveFilePicker
  if (picker === undefined) {
    throw new Error('This browser cannot pick a save location')
  }
  const handle = await picker({
    suggestedName,
    types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
  })
  const writable = await handle.createWritable()

  const total = zipPlannedSize(
    items.map((m) => ({ name: m.fileName, sizeBytes: m.sizeBytes })),
  )
  let written = 0

  const entries = (async function* (): AsyncIterable<ZipEntryInput> {
    for (const media of items) {
      const res = await fetch(mediaDownloadUrl(media.id), { credentials: 'same-origin' })
      if (!res.ok || res.body === null) {
        throw new Error(`Couldn't fetch "${media.fileName}" (HTTP ${res.status})`)
      }
      yield {
        name: media.fileName,
        sizeBytes: media.sizeBytes,
        modifiedAt: new Date(media.createdAt),
        body: res.body,
      }
    }
  })()

  const reader = zipStore(entries).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await writable.write(value)
      written += value.byteLength
      onProgress?.(written, total)
    }
    await writable.close()
  } catch (err) {
    // Kill the partial file where the API supports it — a half zip shouldn't
    // masquerade as a finished download on the user's disk.
    try {
      await writable.abort()
    } catch {
      /* older implementations may lack abort() — the file just stays partial */
    }
    throw err
  }
}
