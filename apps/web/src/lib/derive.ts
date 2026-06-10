/**
 * Client-side derivative generation (F3): before anything is uploaded, the
 * browser produces the `thumb` and `display` JPEGs (for videos: poster frames)
 * and measures dimensions/duration. The Worker never touches pixels.
 */
import {
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
  DERIVED_JPEG_QUALITY,
  DISPLAY_MAX_PX,
  THUMB_MAX_PX,
  type MediaKind,
} from '@cf-mediashare/shared'

export interface Derived {
  kind: MediaKind
  width: number | null
  height: number | null
  /** Seconds, videos only. */
  duration: number | null
  /** Lowercase original extension, e.g. "jpg". */
  ext: string
  thumb: Blob
  display: Blob
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

/** Kind for an accepted file, or null when the type isn't supported (e.g. HEIC). */
export function kindForFile(file: File): MediaKind | null {
  if ((ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) return 'photo'
  if ((ALLOWED_VIDEO_TYPES as readonly string[]).includes(file.type)) return 'video'
  return null
}

/** Extension from the file name when sane, otherwise mapped from the MIME type. */
function extForFile(file: File): string {
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toLowerCase()
  return fromName ?? EXT_BY_MIME[file.type] ?? 'bin'
}

/** Draw `source` scaled down to fit `maxEdge` (never upscaled) as a JPEG blob. */
function rasterToJpeg(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  maxEdge: number,
): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(srcWidth, srcHeight))
  const width = Math.max(1, Math.round(srcWidth * scale))
  const height = Math.max(1, Math.round(srcHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('Canvas 2D is not available'))
  // JPEG has no alpha — flatten transparent PNGs onto a dark matte that
  // matches the gallery background instead of the default black.
  ctx.fillStyle = '#15181c'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))),
      'image/jpeg',
      DERIVED_JPEG_QUALITY,
    )
  })
}

async function derivePhoto(file: File): Promise<Derived> {
  let bitmap: ImageBitmap
  try {
    // createImageBitmap applies EXIF orientation by default.
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`This browser can't decode "${file.name}" (${file.type || 'unknown type'})`)
  }
  try {
    const [display, thumb] = await Promise.all([
      rasterToJpeg(bitmap, bitmap.width, bitmap.height, DISPLAY_MAX_PX),
      rasterToJpeg(bitmap, bitmap.width, bitmap.height, THUMB_MAX_PX),
    ])
    return {
      kind: 'photo',
      width: bitmap.width,
      height: bitmap.height,
      duration: null,
      ext: extForFile(file),
      thumb,
      display,
    }
  } finally {
    bitmap.close()
  }
}

/** A neutral placeholder poster for videos whose frames can't be captured. */
function placeholderJpeg(maxEdge: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = maxEdge
  canvas.height = Math.round((maxEdge * 9) / 16)
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('Canvas 2D is not available'))
  ctx.fillStyle = '#15181c'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#9aa0a6'
  ctx.font = `${Math.round(maxEdge / 10)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('▶', canvas.width / 2, canvas.height / 2)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))),
      'image/jpeg',
      DERIVED_JPEG_QUALITY,
    )
  })
}

function deriveVideo(file: File): Promise<Derived> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'

    const finish = (result: Derived) => {
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
      resolve(result)
    }
    const fail = (err: Error) => {
      URL.revokeObjectURL(url)
      reject(err)
    }

    const fallback = async (
      width: number | null,
      height: number | null,
      duration: number | null,
    ) => {
      try {
        const [display, thumb] = await Promise.all([
          placeholderJpeg(DISPLAY_MAX_PX),
          placeholderJpeg(THUMB_MAX_PX),
        ])
        finish({ kind: 'video', width, height, duration, ext: extForFile(file), thumb, display })
      } catch (err) {
        fail(err instanceof Error ? err : new Error('Poster generation failed'))
      }
    }

    video.onerror = () => void fallback(null, null, null)

    video.onloadedmetadata = () => {
      const { videoWidth, videoHeight } = video
      const duration = Number.isFinite(video.duration) ? video.duration : null
      if (!videoWidth || !videoHeight) {
        void fallback(null, null, duration)
        return
      }
      // Seek a beat in so the poster isn't a black first frame.
      video.currentTime = Math.min(0.5, (duration ?? 1) / 10)
      video.onseeked = async () => {
        try {
          const [display, thumb] = await Promise.all([
            rasterToJpeg(video, videoWidth, videoHeight, DISPLAY_MAX_PX),
            rasterToJpeg(video, videoWidth, videoHeight, THUMB_MAX_PX),
          ])
          finish({
            kind: 'video',
            width: videoWidth,
            height: videoHeight,
            duration,
            ext: extForFile(file),
            thumb,
            display,
          })
        } catch {
          // Codec quirks (e.g. some .mov) can poison drawImage — keep the upload alive.
          void fallback(videoWidth, videoHeight, duration)
        }
      }
    }

    video.src = url
  })
}

/** Derive everything needed to upload `file`. Throws for unsupported types. */
export function deriveForFile(file: File): Promise<Derived> {
  const kind = kindForFile(file)
  if (kind === null) {
    throw new Error(
      `"${file.name}" isn't a supported type${file.type ? ` (${file.type})` : ''}. ` +
        'Photos: JPEG/PNG/WebP/GIF/AVIF. Videos: MP4/MOV/WebM.',
    )
  }
  return kind === 'photo' ? derivePhoto(file) : deriveVideo(file)
}
