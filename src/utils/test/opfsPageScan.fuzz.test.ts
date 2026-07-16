// @vitest-environment node
/**
 * Fuzz suite for `scanForZeroPages` in `src/utils/opfsPageScan.ts`. See
 * `src/test/fuzz.ts` for smoke/deep tier mechanics and `docs/fuzzing.md` for
 * conventions.
 *
 * ──── Contract, grounded at the call sites ────
 *
 * `scanForZeroPages(source, {timeBudgetMs, now})` (opfsPageScan.ts:77-130)
 * reads a SQLite page size from byte source's first <=100 bytes
 * (opfsPageScan.ts:85-86, `readPageSize` at 50-57), then walks the file in
 * `WINDOW_PAGES` (1024, line 20)-page windows counting fully-zeroed pages
 * (`isAllZero`, lines 60-71) up to a wall-clock budget checked once per
 * window (lines 97-101). It never throws on malformed input — `readPageSize`
 * falls back to `DEFAULT_PAGE_SIZE` (4096, line 19) for anything that isn't
 * a plausible power-of-two page size (lines 54-57).
 *
 * All properties below build a synthetic in-memory `ByteSource` mirroring
 * `buildDb`/`sourceOf` in `src/utils/opfsPageScan.test.ts:5-28`, and always
 * pass an injected, constant `now` (never `Date.now()`) so the time budget
 * never fires except in the two properties that deliberately target it.
 *
 * One quirk of the mirrored `buildDb` pattern carries over here: it stamps
 * the page-size header (bytes 16-17) into page 1 unconditionally, AFTER
 * filling every non-zeroed page — so a "zeroed" page 1 built that way would
 * still end up with 1-2 non-zero bytes and never actually read back as an
 * all-zero page. `buildImage` below has the same property (see its
 * docstring), so the general-purpose zero-page generators only ever place
 * injected zero pages in `[2, pageCount]`; page 1's header semantics get
 * their own dedicated properties (P5/P6) with purpose-built images instead.
 *
 * ──── Properties ────
 * P1 zeroPageCount/pageCount/scannedPages exactness + histogram sum, over a
 *    byte-budgeted random pageSize/pageCount/zero-set.
 * P2 zeroPages is the ascending-sorted, MAX_LISTED_ZERO_PAGES-capped prefix
 *    of the injected zero set — forced above the cap so the branch is
 *    always exercised (not left to chance under the fixed smoke seed).
 * P3 window-boundary crossing: pageCount straddling WINDOW_PAGES (1024)
 *    multiples, zero pages biased onto the boundary itself.
 * P4 time-budget truncation: `timedOut` true, and the partial result is
 *    sound (scanned-range-only, no page beyond `scannedPages` reported).
 * P5 header fallback: an all-zero header prefix forces `DEFAULT_PAGE_SIZE`
 *    regardless of file size (tiny or large).
 * P6 page 1 itself fully zeroed: fallback pageSize AND page 1 correctly
 *    reported as the (only) zero page, combined.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { scanForZeroPages, type ByteSource } from '../opfsPageScan'

// Mirrors src/utils/opfsPageScan.test.ts:20 (not exported by the source).
const WINDOW_PAGES = 1024
// Mirrors opfsPageScan.ts:21.
const MAX_LISTED_ZERO_PAGES = 200
// Mirrors opfsPageScan.ts:19.
const DEFAULT_PAGE_SIZE = 4096

const POWER_OF_TWO_PAGE_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536] as const

// A ByteSource over an in-memory buffer — mirrors
// src/utils/opfsPageScan.test.ts:5-10.
const sourceOf = (bytes: Uint8Array): ByteSource => ({
  size: bytes.byteLength,
  slice: (start: number, end: number) => ({
    arrayBuffer: async () => bytes.slice(start, end).buffer,
  }),
})

/**
 * Build a `pageCount`-page image: `zeroPageIndices` (1-indexed) stay
 * all-zero (native `Uint8Array` zero-init — no write needed), every other
 * page gets a non-zero leaf-table type byte (0x0d) + non-zero filler via
 * native `.fill()`. Functionally the same construction as `buildDb` in
 * opfsPageScan.test.ts:15-28 (including the unconditional trailing header
 * stamp, so page 1 must never be passed in `zeroPageIndices` — see file
 * docblock), just faster to generate for fuzzing (native fills instead of
 * per-byte loops).
 */
const buildImage = (pageSize: number, pageCount: number, zeroPageIndices: readonly number[]): Uint8Array => {
  const buf = new Uint8Array(pageSize * pageCount)
  const zero = new Set(zeroPageIndices)
  for (let page = 1; page <= pageCount; page++) {
    if (zero.has(page)) continue
    const base = (page - 1) * pageSize
    buf[base] = 0x0d
    buf.fill(0x2a, base + 1, base + pageSize)
  }
  // header: page size big-endian at bytes 16-17, written last — mirrors
  // opfsPageScan.test.ts:24-26, but using the real SQLite encoding (raw=1
  // means 65536, opfsPageScan.ts:53) rather than a naive 2-byte truncation
  // of 65536 (which wraps to 0 and would misreport as the DEFAULT_PAGE_SIZE
  // fallback) — opfsPageScan.test.ts never exercises pageSize 65536, so
  // that shortcut was never wrong there.
  const raw = pageSize === 65536 ? 1 : pageSize
  buf[16] = (raw >> 8) & 0xff
  buf[17] = raw & 0xff
  return buf
}

const pagesInRange = (from: number, to: number): number[] =>
  Array.from({length: Math.max(0, to - from + 1)}, (_, i) => from + i)

// ──── P1: exactness over a byte-budgeted random case ────

// Keep total allocated bytes per case small so the smoke tier (which
// allocates+scans on every run) stays fast regardless of which pageSize
// fast-check picks.
const P1_BYTES_BUDGET = 150_000

const mainCaseArb = fc.constantFrom(...POWER_OF_TWO_PAGE_SIZES).chain(pageSize => {
  const maxPageCount = Math.max(2, Math.min(300, Math.floor(P1_BYTES_BUDGET / pageSize)))
  return fc.integer({min: 2, max: maxPageCount}).chain(pageCount =>
    fc.record({
      pageSize: fc.constant(pageSize),
      pageCount: fc.constant(pageCount),
      zeroPageIndices: fc.subarray(pagesInRange(2, pageCount)),
    }),
  )
})

describe('scanForZeroPages', () => {
  it('reports exact pageCount/scannedPages/zeroPageCount and a consistent type histogram (opfsPageScan.ts:87,110-114,118-129)', async () => {
    await fc.assert(
      fc.asyncProperty(mainCaseArb, async ({pageSize, pageCount, zeroPageIndices}) => {
        const image = buildImage(pageSize, pageCount, zeroPageIndices)
        const result = await scanForZeroPages(sourceOf(image), {now: () => 0})

        // pageCount = floor(total/pageSize) (line 87); buildImage produces
        // an exact multiple, so this must round-trip exactly.
        expect(result.pageSize).toBe(pageSize)
        expect(result.pageCount).toBe(pageCount)
        // No timeout (constant `now`) ⇒ every page gets scanned (line 114).
        expect(result.timedOut).toBe(false)
        expect(result.scannedPages).toBe(pageCount)
        // zeroPageCount counts ALL zero pages, uncapped (line 111, vs the
        // capped `zeroPages` list at line 112) — must exactly equal the
        // injected zero-set size.
        expect(result.zeroPageCount).toBe(zeroPageIndices.length)
        // typeByteHistogram increments once per scanned page (lines
        // 108-109) — its counts must sum to scannedPages.
        const histogramSum = Object.values(result.typeByteHistogram).reduce((a, b) => a + b, 0)
        expect(histogramSum).toBe(result.scannedPages)
      }),
      fuzzParams(30),
    )
  }, fuzzTestTimeout())

  // ──── P2: zeroPages = ascending prefix capped at MAX_LISTED_ZERO_PAGES ────

  it('zeroPages is the ascending, MAX_LISTED_ZERO_PAGES-capped prefix of the zero set (opfsPageScan.ts:97,105,110-113)', async () => {
    const pageSize = 512 // small ⇒ affordable to push pageCount near 300
    // pageCount >= 202 so pagesInRange(2, pageCount) (size pageCount-1) has
    // at least 201 elements — required for the minLength below.
    const capCaseArb = fc.integer({min: 202, max: 300}).chain(pageCount =>
      fc.record({
        pageCount: fc.constant(pageCount),
        // Forced above MAX_LISTED_ZERO_PAGES (200) so the cap branch is
        // always exercised, not left to the fixed smoke seed's luck.
        zeroPageIndices: fc.subarray(pagesInRange(2, pageCount), {minLength: 201}),
      }),
    )
    await fc.assert(
      fc.asyncProperty(capCaseArb, async ({pageCount, zeroPageIndices}) => {
        const image = buildImage(pageSize, pageCount, zeroPageIndices)
        const result = await scanForZeroPages(sourceOf(image), {now: () => 0})

        expect(result.zeroPageCount).toBe(zeroPageIndices.length)
        // The scan visits pages in strictly ascending order (outer loop
        // ascending `off`, line 97; inner loop ascending `p`, line 105) and
        // pushes to `zeroPages` only while under the cap (line 112) — so
        // the capped list is exactly the smallest-`MAX_LISTED_ZERO_PAGES`
        // indices, in order.
        const expected = [...zeroPageIndices].sort((a, b) => a - b).slice(0, MAX_LISTED_ZERO_PAGES)
        expect(result.zeroPages).toEqual(expected)
        expect(result.zeroPages.length).toBe(Math.min(zeroPageIndices.length, MAX_LISTED_ZERO_PAGES))
      }),
      fuzzParams(15),
    )
  }, fuzzTestTimeout())

  // ──── P3: window-boundary (WINDOW_PAGES=1024) crossing ────

  it('is exact across a WINDOW_PAGES window boundary (opfsPageScan.ts:97-116 — off-by-ones live at the window seam)', async () => {
    const boundaryCaseArb = fc.constantFrom(512, 1024).chain(pageSize =>
      fc
        .tuple(fc.constantFrom(1, 2), fc.integer({min: -2, max: 2}))
        .map(([mult, delta]) => Math.max(3, mult * WINDOW_PAGES + delta))
        .chain(pageCount => {
          // Bias candidates onto every window boundary within pageCount,
          // plus a couple of far-away pages, to keep generation cheap
          // while directly targeting the seam.
          const boundaries = []
          for (let b = WINDOW_PAGES; b <= pageCount; b += WINDOW_PAGES) boundaries.push(b)
          const nearBoundary = Array.from(
            new Set(boundaries.flatMap(b => [b - 1, b, b + 1]).filter(p => p >= 2 && p <= pageCount)),
          )
          const farCandidates = [2, Math.max(2, Math.floor(pageCount / 2)), pageCount].filter(
            p => !nearBoundary.includes(p),
          )
          return fc.record({
            pageSize: fc.constant(pageSize),
            pageCount: fc.constant(pageCount),
            zeroPageIndices: fc
              .tuple(fc.subarray(nearBoundary), fc.subarray(farCandidates))
              .map(([a, b]) => Array.from(new Set([...a, ...b]))),
          })
        }),
    )
    await fc.assert(
      fc.asyncProperty(boundaryCaseArb, async ({pageSize, pageCount, zeroPageIndices}) => {
        const image = buildImage(pageSize, pageCount, zeroPageIndices)
        const result = await scanForZeroPages(sourceOf(image), {now: () => 0})

        expect(result.pageCount).toBe(pageCount)
        expect(result.scannedPages).toBe(pageCount)
        expect(result.zeroPageCount).toBe(zeroPageIndices.length)
        const expected = [...zeroPageIndices].sort((a, b) => a - b)
        expect(result.zeroPages).toEqual(expected)
        if (expected.length > 0) {
          expect(result.firstZeroPageByteOffset).toBe((expected[0] - 1) * pageSize)
        } else {
          expect(result.firstZeroPageByteOffset).toBeNull()
        }
      }),
      fuzzParams(15),
    )
  }, fuzzTestTimeout())

  // ──── P4: time-budget truncation is sound ────

  it('honours a tiny time budget and keeps the partial result sound (opfsPageScan.ts:97-101 — truncated ⇒ no page beyond scannedPages reported)', async () => {
    const truncationCaseArb = fc.integer({min: 1025, max: 1400}).chain(pageCount =>
      fc.record({
        pageCount: fc.constant(pageCount),
        zeroPageIndices: fc.subarray(pagesInRange(2, pageCount)),
      }),
    )
    await fc.assert(
      fc.asyncProperty(truncationCaseArb, async ({pageCount, zeroPageIndices}) => {
        const pageSize = 512
        const image = buildImage(pageSize, pageCount, zeroPageIndices)

        // Deterministic clock: call #1 is `start` (returns 0); call #2 is
        // the first per-window budget check (returns 0, so diff 0 <= budget
        // 0 is false ⇒ proceeds and scans window 1, exactly WINDOW_PAGES
        // pages since pageCount > WINDOW_PAGES here); call #3 is the
        // second window's budget check (returns a huge value ⇒ diff >
        // budget ⇒ break before scanning window 2). This guarantees
        // exactly one window (1024 pages) is scanned, deterministically.
        let calls = 0
        const now = () => {
          calls += 1
          return calls <= 2 ? 0 : 1_000_000
        }

        const result = await scanForZeroPages(sourceOf(image), {timeBudgetMs: 0, now})

        expect(result.timedOut).toBe(true)
        // pageSize/pageCount are computed before the loop (lines 86-87),
        // unaffected by the budget.
        expect(result.pageSize).toBe(pageSize)
        expect(result.pageCount).toBe(pageCount)
        // Exactly window 1 (WINDOW_PAGES pages) was scanned before the
        // second window's budget check tripped.
        expect(result.scannedPages).toBe(WINDOW_PAGES)

        // Soundness: the reported zero set is exactly the injected zero
        // pages that fall within the scanned range — no page beyond
        // `scannedPages` is ever reported (no false positives from
        // never-visited memory), and no page outside the injected set is
        // reported either.
        const scannedZero = zeroPageIndices.filter(p => p <= WINDOW_PAGES).sort((a, b) => a - b)
        expect(result.zeroPageCount).toBe(scannedZero.length)
        expect(result.zeroPages).toEqual(scannedZero.slice(0, MAX_LISTED_ZERO_PAGES))
        for (const p of result.zeroPages) expect(p).toBeLessThanOrEqual(result.scannedPages)
      }),
      fuzzParams(8),
    )
  }, fuzzTestTimeout())

  // ──── P5: header fallback (any all-zero header prefix ⇒ DEFAULT_PAGE_SIZE) ────

  it('falls back to DEFAULT_PAGE_SIZE whenever the header prefix is all-zero, at any file size (opfsPageScan.ts:50-57,85-87)', async () => {
    const fallbackCaseArb = fc.record({
      totalBytes: fc.integer({min: 0, max: 200_000}),
      fillByte: fc.integer({min: 1, max: 255}),
    })
    await fc.assert(
      fc.asyncProperty(fallbackCaseArb, async ({totalBytes, fillByte}) => {
        const buf = new Uint8Array(totalBytes) // zero-init ⇒ header prefix (bytes [0,100)) stays zero
        buf.fill(fillByte, 100) // no-op if totalBytes <= 100
        const result = await scanForZeroPages(sourceOf(buf), {now: () => 0})

        // header.length < 18 (line 51) for totalBytes < 18, or the
        // power-of-two range check fails on an all-zero raw value (lines
        // 54-57) otherwise — either way, DEFAULT_PAGE_SIZE.
        expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE)
        expect(result.pageCount).toBe(Math.floor(totalBytes / DEFAULT_PAGE_SIZE))
        expect(result.timedOut).toBe(false)
        expect(result.scannedPages).toBe(result.pageCount)
      }),
      fuzzParams(20),
    )
  }, fuzzTestTimeout())

  // ──── P6: page 1 itself fully zeroed — fallback + zero-page report combined ────

  it('reports a fully-zeroed page 1 as the sole zero page, under the fallback page size (opfsPageScan.ts:50-57,110-113,125)', async () => {
    const page1ZeroCaseArb = fc.integer({min: 2, max: 300})
    await fc.assert(
      fc.asyncProperty(page1ZeroCaseArb, async pageCount => {
        const totalBytes = DEFAULT_PAGE_SIZE * pageCount
        const buf = new Uint8Array(totalBytes) // zero-init ⇒ page 1 (bytes [0,4096)) stays all-zero
        buf.fill(0x2a, DEFAULT_PAGE_SIZE) // every other page non-zero
        const result = await scanForZeroPages(sourceOf(buf), {now: () => 0})

        expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE)
        expect(result.pageCount).toBe(pageCount)
        expect(result.scannedPages).toBe(pageCount)
        expect(result.zeroPageCount).toBe(1)
        expect(result.zeroPages).toEqual([1])
        expect(result.firstZeroPageByteOffset).toBe(0)
      }),
      fuzzParams(20),
    )
  }, fuzzTestTimeout())
})
