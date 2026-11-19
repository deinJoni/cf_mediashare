/**
 * Streaming store-mode ZIP writer (F6) — one implementation shared by the
 * Worker archive route and the browser's client-side download path.
 *
 * Design notes:
 * - Store mode only (method 0): photos/videos are already compressed; the zip
 *   is a pure container, so nothing burns CPU re-encoding bytes.
 * - Data descriptors (bit 3): entry sizes are known upfront (D1/R2 metadata)
 *   but CRC32 is only known after streaming, so crc/sizes ride in a trailer
 *   after each file's data. Legal per APPNOTE and read by every mainstream
 *   unzipper (macOS/iOS/Windows included).
 * - ZIP64: engaged per-entry when a size or offset overflows u32, plus the
 *   EOCD records when the archive itself does — required once a single
 *   original can exceed 4 GiB.
 * - O(1) memory: entries stream through; the only state kept is the central
 *   directory (metadata, not bytes) and a small CRC32 table.
 * - Pure TS + Web Streams: runs identically in workerd and the browser.
 */
import { ARCHIVE_PART_MAX_BYTES, ARCHIVE_PART_MAX_ITEMS } from './constants.js'

/**
 * Split an ordered item list into bounded archive parts (F6): a part closes
 * when the next item would push it past the byte or item bound. An item larger
 * than the byte bound gets a part to itself — boundedness is about resumable
 * downloads, not a hard ceiling. Callers pass items in archive order (newest
 * first, matching the gallery).
 */
export function partitionArchive<T extends { sizeBytes: number }>(
  items: T[],
  maxBytes = ARCHIVE_PART_MAX_BYTES,
  maxItems = ARCHIVE_PART_MAX_ITEMS,
): T[][] {
  const parts: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const item of items) {
    if (
      current.length > 0 &&
      (bytes + item.sizeBytes > maxBytes || current.length >= maxItems)
    ) {
      parts.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += item.sizeBytes
  }
  if (current.length > 0) parts.push(current)
  return parts
}

// --- CRC32 (IEEE 802.3, reflected) -------------------------------------------
// Single-byte lookup table — the archive part bound caps how many bytes ever
// pass through it per request, so no slicing tricks are needed.

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable === null) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      crcTable[n] = c
    }
  }
  return crcTable
}

/** Running CRC32 state — update() per chunk, digest() once at the end. */
export class Crc32 {
  private state = 0xffffffff

  update(chunk: Uint8Array): void {
    const table = getCrcTable()
    let c = this.state
    for (let i = 0; i < chunk.length; i++) {
      c = table[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
    }
    this.state = c
  }

  digest(): number {
    return (this.state ^ 0xffffffff) >>> 0
  }
}

// --- Entry names --------------------------------------------------------------

const BAD_CHARS_RE = /[\x00-\x1f<>:"|?*]/g
const encoder = new TextEncoder()
const MAX_NAME_BYTES = 400

/**
 * Make one path segment safe for a zip entry: strip control chars and the
 * Windows-reserved set, drop empties/dots segments entirely. Returns null when
 * nothing usable remains.
 */
function sanitizeSegment(segment: string): string | null {
  const cleaned = segment
    .replace(BAD_CHARS_RE, '_')
    .replace(/[. ]+$/, '')
    .trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null
  return cleaned
}

/** Cap a UTF-8 string at `maxBytes` without splitting a multibyte sequence. */
function capUtf8(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value)
  if (bytes.length <= maxBytes) return value
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes))
}

/**
 * Sanitize a user-supplied file name into a safe zip entry path: normalize
 * separators, drop traversal segments, cap length. Never returns ''.
 */
export function sanitizeZipName(name: string): string {
  const segments = name
    .replaceAll('\\', '/')
    .split('/')
    .map(sanitizeSegment)
    .filter((s): s is string => s !== null)
  const joined = segments.join('/') || 'file'
  return capUtf8(joined, MAX_NAME_BYTES)
}

/** `name (2).ext`-style dedupe against an already-used set. Mutates `used`. */
function dedupeName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = capUtf8(`${stem} (${n})${ext}`, MAX_NAME_BYTES)
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/**
 * Resolve the final entry names for an archive — sanitized and deduplicated.
 * Deterministic: same inputs, same output. {@link zipPlannedSize} runs the same
 * resolution so a Content-Length computed from it can't drift from what the
 * writer actually emits (the writer applies this logic lazily, per entry).
 */
export function resolveZipNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((raw) => dedupeName(sanitizeZipName(raw), used))
}

// --- Binary helpers -----------------------------------------------------------

const LFH_SIG = 0x04034b50
const DD_SIG = 0x08074b50
const CD_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50

const FLAG_UTF8 = 1 << 11
const FLAG_DD = 1 << 3
const METHOD_STORE = 0
const VERSION_DEFAULT = 20
const VERSION_ZIP64 = 45

const U32_MAX = 0xffffffff

function u16(v: number): number {
  return v & 0xffff
}
function u32(v: number): number {
  return v & 0xffffffff
}

class Buf {
  private bytes: number[] = []
  u16(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff)
    return this
  }
  u32(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff)
    return this
  }
  u64(v: number): this {
    // Sizes/offsets stay under 2^53 in practice (archives are part-bounded).
    const lo = v >>> 0
    const hi = Math.floor(v / 0x100000000) >>> 0
    return this.u32(lo).u32(hi)
  }
  raw(b: Uint8Array): this {
    for (const x of b) this.bytes.push(x)
    return this
  }
  out(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

/** MS-DOS date/time pair for the zip headers. UTC is used for determinism. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()))
  return {
    time: u16((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)),
    date: u16(((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()),
  }
}

// --- Writer -------------------------------------------------------------------

export interface ZipEntryInput {
  /** Raw file name — sanitized + deduplicated internally (see {@link resolveZipNames}). */
  name: string
  /** Uncompressed size in bytes (must equal the body's byte count). */
  sizeBytes: number
  /** Stored mtime; defaults to "now". */
  modifiedAt?: Date
  body: ReadableStream<Uint8Array>
}

interface CentralRecord {
  nameBytes: Uint8Array
  flags: number
  time: number
  date: number
  crc: number
  sizeBytes: number
  /** True when this entry's size fields needed ZIP64 anywhere. */
  zip64: boolean
  localHeaderOffset: number
}

/**
 * Emit a streaming ZIP from an (async) iterable of entries. Each entry's body
 * is only consumed when the archive reaches it, so callers can hand over a
 * lazy generator that fetches objects on demand — memory stays O(1) no matter
 * how large the archive gets.
 */
export function zipStore(
  entries: Iterable<ZipEntryInput> | AsyncIterable<ZipEntryInput>,
): ReadableStream<Uint8Array> {
  const iterator =
    Symbol.asyncIterator in entries
      ? entries[Symbol.asyncIterator]()
      : (function* () {
          yield* entries
        })()

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      void (async () => {
        try {
          const usedNames = new Set<string>()
          const central: CentralRecord[] = []
          let offset = 0
          const push = (chunk: Uint8Array) => {
            controller.enqueue(chunk)
            offset += chunk.byteLength
          }

          for (;;) {
            const next = await iterator.next()
            if (next.done) break
            const entry = next.value

            const nameBytes = encoder.encode(dedupeName(sanitizeZipName(entry.name), usedNames))
            const sizeBytes = entry.sizeBytes
            const zip64 = sizeBytes >= U32_MAX
            const flags = u16(FLAG_UTF8 | FLAG_DD)
            const { time, date } = dosDateTime(entry.modifiedAt ?? new Date())
            const localHeaderOffset = offset

            // Local file header — crc/sizes zeroed; real values ride in the
            // data descriptor after the body.
            push(
              new Buf()
                .u32(LFH_SIG)
                .u16(zip64 ? VERSION_ZIP64 : VERSION_DEFAULT)
                .u16(flags)
                .u16(METHOD_STORE)
                .u16(time)
                .u16(date)
                .u32(0)
                .u32(0)
                .u32(0)
                .u16(nameBytes.length)
                .u16(0)
                .raw(nameBytes)
                .out(),
            )

            const crc = new Crc32()
            const reader = entry.body.getReader()
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                if (value.byteLength === 0) continue
                crc.update(value)
                push(value)
              }
            } finally {
              reader.releaseLock()
            }

            // Data descriptor — u64 size fields iff the entry is ZIP64.
            const dd = new Buf().u32(DD_SIG).u32(crc.digest())
            if (zip64) dd.u64(sizeBytes).u64(sizeBytes)
            else dd.u32(sizeBytes).u32(sizeBytes)
            push(dd.out())

            central.push({
              nameBytes,
              flags,
              time,
              date,
              crc: crc.digest(),
              sizeBytes,
              zip64,
              localHeaderOffset,
            })
          }

          // --- Central directory ------------------------------------------
          const cdStart = offset
          for (const rec of central) {
            const offset64 = rec.localHeaderOffset >= U32_MAX
            const needs64 = rec.zip64 || offset64
            const extra = needs64
              ? (() => {
                  const b = new Buf().u16(0x0001)
                  const values: number[] = []
                  if (rec.zip64) values.push(rec.sizeBytes, rec.sizeBytes)
                  if (offset64) values.push(rec.localHeaderOffset)
                  b.u16(values.length * 8)
                  for (const v of values) b.u64(v)
                  return b.out()
                })()
              : new Uint8Array(0)

            push(
              new Buf()
                .u32(CD_SIG)
                .u16(VERSION_ZIP64)
                .u16(needs64 ? VERSION_ZIP64 : VERSION_DEFAULT)
                .u16(rec.flags)
                .u16(METHOD_STORE)
                .u16(rec.time)
                .u16(rec.date)
                .u32(rec.crc)
                .u32(rec.zip64 ? U32_MAX : rec.sizeBytes)
                .u32(rec.zip64 ? U32_MAX : rec.sizeBytes)
                .u16(rec.nameBytes.length)
                .u16(extra.length)
                .u16(0)
                .u16(0)
                .u16(0)
                .u32(0)
                .u32(offset64 ? U32_MAX : u32(rec.localHeaderOffset))
                .raw(rec.nameBytes)
                .raw(extra)
                .out(),
            )
          }
          const cdSize = offset - cdStart
          const cdOffset = cdStart

          const needZip64Eocd =
            central.some((r) => r.zip64) ||
            central.length > 0xffff ||
            cdSize >= U32_MAX ||
            cdOffset >= U32_MAX

          if (needZip64Eocd) {
            const zip64EocdOffset = offset
            push(
              new Buf()
                .u32(ZIP64_EOCD_SIG)
                .u64(44)
                .u16(VERSION_ZIP64)
                .u16(VERSION_ZIP64)
                .u32(0)
                .u32(0)
                .u64(central.length)
                .u64(central.length)
                .u64(cdSize)
                .u64(cdOffset)
                .out(),
            )
            push(
              new Buf()
                .u32(ZIP64_LOCATOR_SIG)
                .u32(0)
                .u64(zip64EocdOffset)
                .u32(1)
                .out(),
            )
          }

          push(
            new Buf()
              .u32(EOCD_SIG)
              .u16(0)
              .u16(0)
              .u16(needZip64Eocd ? 0xffff : u16(central.length))
              .u16(needZip64Eocd ? 0xffff : u16(central.length))
              .u32(needZip64Eocd ? U32_MAX : u32(cdSize))
              .u32(needZip64Eocd ? U32_MAX : u32(cdOffset))
              .u16(0)
              .out(),
          )

          controller.close()
        } catch (err) {
          controller.error(err)
        }
      })()
    },
  })
}

/**
 * Exact archive byte size — for Content-Length and the UI's size labels. Runs
 * the same name resolution the writer does, so the result can't drift. Throws
 * nothing; assumes inputs match what the writer will see (same order).
 */
export function zipPlannedSize(entries: { name: string; sizeBytes: number }[]): number {
  const names = resolveZipNames(entries.map((e) => e.name))
  let dataEnd = 0
  let cd = 0
  let anyZip64 = false
  let offset = 0
  for (let i = 0; i < entries.length; i++) {
    const nameLen = encoder.encode(names[i]).length
    const zip64 = entries[i].sizeBytes >= U32_MAX
    if (zip64) anyZip64 = true
    const localHeaderOffset = offset
    offset += 30 + nameLen + entries[i].sizeBytes + (zip64 ? 24 : 16)
    const offset64 = localHeaderOffset >= U32_MAX
    // zip64 extra block: 4-byte header + 8 per stored value. Order is fixed
    // (usize, csize, offset) and only fields that needed the sentinel appear.
    const extraLen = zip64 && offset64 ? 28 : zip64 ? 20 : offset64 ? 12 : 0
    cd += 46 + nameLen + extraLen
  }
  dataEnd = offset
  const needZip64Eocd =
    anyZip64 || entries.length > 0xffff || cd >= U32_MAX || dataEnd >= U32_MAX
  return dataEnd + cd + (needZip64Eocd ? 56 + 20 : 0) + 22
}
