/**
 * R2 object keys for a media item (PRD §6 data model):
 *
 *   <groupId>/<mediaId>/original.<ext>
 *   <groupId>/<mediaId>/display.jpg
 *   <groupId>/<mediaId>/thumb.jpg
 *
 * Keys are worker-internal: derived here at presign time, re-derived at
 * finalize (never trusted from the client), stored on the media row, and
 * never returned over the wire — clients only see `/api/media/:id/:tier`.
 */

export interface MediaKeys {
  original: string
  display: string
  thumb: string
}

export function mediaKeys(groupId: string, mediaId: string, originalExt: string): MediaKeys {
  const prefix = `${groupId}/${mediaId}`
  return {
    original: `${prefix}/original.${originalExt}`,
    display: `${prefix}/display.jpg`,
    thumb: `${prefix}/thumb.jpg`,
  }
}
