/** HTTP response helpers for the byte-serving routes (F5, F6). */

/**
 * RFC 5987 percent-encoding for the `filename*` parameter. encodeURIComponent
 * covers everything except `'`, `(`, `)` and `*`, which the RFC also requires
 * percent-encoded.
 */
function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * `Content-Disposition: attachment` carrying the original upload file name:
 * `filename*` (RFC 5987) preserves Unicode names, while the plain `filename`
 * is an ASCII-sanitized fallback for clients that don't speak 5987.
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Encode(fileName)}`
}

/**
 * Resolve the R2Range that R2 actually served into absolute (offset, length)
 * for the Content-Range header. R2 normally reports offset+length; the other
 * arms just make the union total.
 */
export function resolveRange(range: R2Range, size: number): { offset: number; length: number } {
  if ('suffix' in range) {
    const length = Math.min(range.suffix, size)
    return { offset: size - length, length }
  }
  const offset = range.offset ?? 0
  return { offset, length: range.length ?? size - offset }
}
