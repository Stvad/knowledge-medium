import { describe, expect, it, vi } from 'vitest'
import { collectPaged } from './paginate.js'

describe('collectPaged', () => {
  it('walks pages until an empty page and concatenates in order', async () => {
    const data = [1, 2, 3, 4, 5, 6, 7]
    const fetchPage = vi.fn(async (offset: number) => data.slice(offset, offset + 3))
    expect(await collectPaged(fetchPage)).toEqual(data)
    // offsets 0,3,6 (lengths 3,3,1) then 7 → [] stops it
    expect(fetchPage).toHaveBeenCalledTimes(4)
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([0, 3, 6, 7])
  })

  it('advances by the ACTUAL page length when the server caps a page below the page size', async () => {
    // The "server" only ever returns 2 rows per call (a db-max-rows-style cap),
    // regardless of how big a page the caller wanted. Advancing by the actual
    // length (2), not the requested size, must not skip the remainder.
    const data = [1, 2, 3, 4, 5]
    const fetchPage = vi.fn(async (offset: number) => data.slice(offset, offset + 2))
    expect(await collectPaged(fetchPage)).toEqual(data)
  })

  it('returns empty when the first page is empty', async () => {
    const fetchPage = vi.fn(async () => [])
    expect(await collectPaged(fetchPage)).toEqual([])
    expect(fetchPage).toHaveBeenCalledOnce()
  })

  it('terminates with one trailing empty fetch after an exact-multiple final page', async () => {
    const data = [1, 2, 3, 4]
    const fetchPage = vi.fn(async (offset: number) => data.slice(offset, offset + 2))
    expect(await collectPaged(fetchPage)).toEqual(data)
    expect(fetchPage).toHaveBeenCalledTimes(3) // 0→[1,2], 2→[3,4], 4→[]
  })
})
