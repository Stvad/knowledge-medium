/**
 * Cheap structural scan of a raw SQLite `.db` file for physically-lost pages.
 *
 * A whole-file `PRAGMA integrity_check` on a multi-GB DB takes ~30s and aborts
 * with a generic "malformed" the moment it hits an unparseable page — no
 * per-page detail. This scan instead reads the raw bytes and flags **fully
 * zeroed pages**, which is the clearest fingerprint of a dropped/torn write
 * (a live b-tree page zero-filled by file extension but never written back).
 * The two real iPad corruptions (see the db-forensics instrumentation) both
 * surfaced this way; the 2026-07-01 incident was a single zeroed page at
 * exactly the 1 GiB offset. Reading 1.4 GB this way takes ~3s.
 *
 * Runs against a `Blob`/`File` (from `handle.getFile()`), reading one window at
 * a time so a multi-GB file never lands in memory. It does NOT interpret b-tree
 * structure beyond the page-type byte — a zeroed page is unambiguous; detecting
 * non-zero corruption (torn/stale writes) needs SQLite and is out of scope here.
 */

const DEFAULT_PAGE_SIZE = 4096
const WINDOW_PAGES = 1024
const MAX_LISTED_ZERO_PAGES = 200
const DEFAULT_TIME_BUDGET_MS = 30_000

/** Minimal slice-able byte source — a `File`/`Blob`, or a test stand-in. */
export interface ByteSource {
  readonly size: number
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

export interface OpfsPageScanResult {
  fileSize: number
  pageSize: number
  pageCount: number
  scannedPages: number
  /** Fully-zeroed pages (1-indexed, SQLite convention), capped to a sample. */
  zeroPages: number[]
  zeroPageCount: number
  /** Byte offset of the first zeroed page, or null. Power-of-two offsets are
   *  the signal we care about (the 1 GiB-boundary fingerprint). */
  firstZeroPageByteOffset: number | null
  /** Histogram of each page's first byte (b-tree page-type: 2/5/10/13; 0 =
   *  overflow/free/zeroed). Cheap sanity signal on overall structure. */
  typeByteHistogram: Record<number, number>
  elapsedMs: number
  timedOut: boolean
}

/** SQLite stores the page size at bytes 16-17 of page 1 (big-endian); the
 *  value 1 encodes 65536. Falls back to 4096 when the header is unreadable. */
const readPageSize = (header: Uint8Array): number => {
  if (header.length < 18) return DEFAULT_PAGE_SIZE
  const raw = (header[16] << 8) | header[17]
  if (raw === 1) return 65536
  // Must be a power of two in [512, 65536]; otherwise the file isn't a sane
  // SQLite image — scan with the default so we still surface zeroed pages.
  if (raw >= 512 && raw <= 65536 && (raw & (raw - 1)) === 0) return raw
  return DEFAULT_PAGE_SIZE
}

const isAllZero = (buf: Uint8Array, base: number, pageSize: number): boolean => {
  // Stride first for a fast reject on the common non-zero page (its header
  // bytes are non-zero, so this usually exits on the first check), then confirm
  // the whole page only for genuine candidates.
  for (let i = 0; i < pageSize; i += 8) {
    if (buf[base + i] !== 0) return false
  }
  for (let i = 0; i < pageSize; i++) {
    if (buf[base + i] !== 0) return false
  }
  return true
}

/**
 * Scan `source` for fully-zeroed pages. `now` is injectable for tests; it
 * defaults to `Date.now` (this is app-runtime code, not a workflow script).
 */
export const scanForZeroPages = async (
  source: ByteSource,
  options: { timeBudgetMs?: number; now?: () => number } = {},
): Promise<OpfsPageScanResult> => {
  const now = options.now ?? Date.now
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
  const total = source.size

  const header = new Uint8Array(await source.slice(0, Math.min(100, total)).arrayBuffer())
  const pageSize = readPageSize(header)
  const pageCount = Math.floor(total / pageSize)
  const windowBytes = pageSize * WINDOW_PAGES

  const zeroPages: number[] = []
  const typeByteHistogram: Record<number, number> = {}
  let zeroPageCount = 0
  let scannedPages = 0
  let timedOut = false
  const start = now()

  for (let off = 0; off < total; off += windowBytes) {
    if (now() - start > timeBudgetMs) {
      timedOut = true
      break
    }
    const end = Math.min(off + windowBytes, total)
    const buf = new Uint8Array(await source.slice(off, end).arrayBuffer())
    const pagesInWindow = Math.floor(buf.length / pageSize)
    for (let p = 0; p < pagesInWindow; p++) {
      const base = p * pageSize
      const pageIndex = off / pageSize + p + 1 // SQLite pages are 1-indexed
      const typeByte = buf[base]
      typeByteHistogram[typeByte] = (typeByteHistogram[typeByte] ?? 0) + 1
      if (isAllZero(buf, base, pageSize)) {
        zeroPageCount++
        if (zeroPages.length < MAX_LISTED_ZERO_PAGES) zeroPages.push(pageIndex)
      }
      scannedPages++
    }
  }

  return {
    fileSize: total,
    pageSize,
    pageCount,
    scannedPages,
    zeroPages,
    zeroPageCount,
    firstZeroPageByteOffset: zeroPages.length > 0 ? (zeroPages[0] - 1) * pageSize : null,
    typeByteHistogram,
    elapsedMs: now() - start,
    timedOut,
  }
}
