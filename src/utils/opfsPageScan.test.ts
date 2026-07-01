import { describe, expect, it } from 'vitest'
import { scanForZeroPages, type ByteSource } from './opfsPageScan'

// A ByteSource over an in-memory buffer with a real slice/arrayBuffer.
const sourceOf = (bytes: Uint8Array): ByteSource => ({
  size: bytes.byteLength,
  slice: (start: number, end: number) => ({
    arrayBuffer: async () => bytes.slice(start, end).buffer,
  }),
})

// Build a `pageCount`-page image with a valid-ish SQLite header (page size at
// bytes 16-17). `zeroPageIndices` (1-indexed) are left all-zero; every other
// page is filled with a non-zero leaf-table type byte (0x0d) + content.
const buildDb = (pageSize: number, pageCount: number, zeroPageIndices: number[]): Uint8Array => {
  const buf = new Uint8Array(pageSize * pageCount)
  const zero = new Set(zeroPageIndices)
  for (let page = 1; page <= pageCount; page++) {
    if (zero.has(page)) continue
    const base = (page - 1) * pageSize
    buf[base] = 0x0d // leaf-table b-tree page type
    for (let i = 1; i < pageSize; i++) buf[base + i] = (i % 251) + 1 // non-zero filler
  }
  // header: page size big-endian at bytes 16-17
  buf[16] = (pageSize >> 8) & 0xff
  buf[17] = pageSize & 0xff
  return buf
}

describe('scanForZeroPages', () => {
  it('finds a single zeroed page and reports its byte offset', async () => {
    const pageSize = 4096
    const result = await scanForZeroPages(sourceOf(buildDb(pageSize, 10, [7])))

    expect(result.pageSize).toBe(pageSize)
    expect(result.pageCount).toBe(10)
    expect(result.scannedPages).toBe(10)
    expect(result.zeroPages).toEqual([7])
    expect(result.zeroPageCount).toBe(1)
    expect(result.firstZeroPageByteOffset).toBe(6 * pageSize)
    expect(result.timedOut).toBe(false)
  })

  it('reports no zero pages for a clean image', async () => {
    const result = await scanForZeroPages(sourceOf(buildDb(4096, 2050, [])))
    expect(result.zeroPageCount).toBe(0)
    expect(result.zeroPages).toEqual([])
    expect(result.firstZeroPageByteOffset).toBeNull()
    // spans multiple 1024-page windows
    expect(result.scannedPages).toBe(2050)
  })

  it('detects zero pages across a window boundary', async () => {
    // WINDOW_PAGES is 1024; page 1030 lands in the second window.
    const result = await scanForZeroPages(sourceOf(buildDb(4096, 1100, [1030])))
    expect(result.zeroPages).toEqual([1030])
    expect(result.firstZeroPageByteOffset).toBe(1029 * 4096)
  })

  it('reads the page size from the header (non-4096)', async () => {
    const result = await scanForZeroPages(sourceOf(buildDb(512, 20, [5])))
    expect(result.pageSize).toBe(512)
    expect(result.zeroPages).toEqual([5])
    expect(result.firstZeroPageByteOffset).toBe(4 * 512)
  })

  it('honours the time budget and reports timedOut', async () => {
    let t = 0
    const result = await scanForZeroPages(sourceOf(buildDb(4096, 5000, [4000])), {
      timeBudgetMs: 5,
      now: () => (t += 10), // every call advances 10ms → budget blown on first check
    })
    expect(result.timedOut).toBe(true)
    expect(result.scannedPages).toBeLessThan(5000)
  })

  it('builds a page-type histogram (0 for the zeroed page)', async () => {
    const result = await scanForZeroPages(sourceOf(buildDb(4096, 4, [2])))
    // 3 leaf-table pages (0x0d = 13) + 1 zeroed (0)
    expect(result.typeByteHistogram[13]).toBe(3)
    expect(result.typeByteHistogram[0]).toBe(1)
  })
})
