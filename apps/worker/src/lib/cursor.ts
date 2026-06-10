/**
 * Opaque keyset-pagination cursor: base64url(JSON.stringify([createdAt, id])).
 *
 * (createdAt, id) mirrors the gallery sort key (created_at DESC, id DESC) so a
 * page boundary stays exact even when two rows share a millisecond timestamp.
 * Encoded so clients treat it as a token, not a structure to construct.
 */

export interface CursorPosition {
  createdAt: string
  id: string
}

export function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

/** Returns null on any malformed input — the route maps that to a 400. */
export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const b64 = cursor.replaceAll('-', '+').replaceAll('_', '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const parsed: unknown = JSON.parse(atob(padded))
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { createdAt: parsed[0], id: parsed[1] }
    }
    return null
  } catch {
    return null
  }
}
