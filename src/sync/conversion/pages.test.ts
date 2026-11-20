import { describe, expect, it } from 'vitest'
import { keysetPages } from './pages.js'

const ROWS = Array.from({length: 10}, (_, i) => ({id: i + 1}))

const failure = (code: string | undefined, status: number) =>
  Object.assign(new Error(`failed (${code ?? status})`), {code, status})

/** Reads ROWS after a cursor, failing as `fail` says for the reads it names. */
const reader = (fail: (call: number, limit: number) => Error | null = () => null) => {
  const limits: number[] = []
  const read = async (after: number, limit: number) => {
    limits.push(limit)
    const error = fail(limits.length, limit)
    if (error) throw error
    return ROWS.filter(row => row.id > after).slice(0, limit)
  }
  return {read, limits}
}

const collect = async (read: (after: number, limit: number) => Promise<readonly {id: number}[]>, pageSize = 4) => {
  const ids: number[] = []
  for await (const page of keysetPages({read, first: 0, cursorOf: row => row.id, pageSize, sleep: async () => {}})) {
    ids.push(...page.map(row => row.id))
  }
  return ids
}

describe('keysetPages', () => {
  it('reads every row once, past a failure that had no answer', async () => {
    const {read} = reader(call => (call === 2 ? failure(undefined, 0) : null))

    expect(await collect(read)).toEqual(ROWS.map(row => row.id))
  })

  it('reads a page that ran past the statement timeout again in halves, then grows back', async () => {
    const {read, limits} = reader((_call, limit) => (limit > 2 && limits.length === 1 ? failure('57014', 500) : null))

    expect(await collect(read)).toEqual(ROWS.map(row => row.id))
    expect(limits).toEqual([4, 2, 4, 4, 4])
  })

  it('keeps its transient retries for after a page had to shrink several times', async () => {
    // Three statement timeouts shrink 8 to 1; then one failure with no answer.
    const {read, limits} = reader(call => (call <= 3 ? failure('57014', 500) : call === 4 ? failure(undefined, 503) : null))

    expect(await collect(read, 8)).toEqual(ROWS.map(row => row.id))
    expect(limits.slice(0, 5)).toEqual([8, 4, 2, 1, 1])
  })

  it('retries a rate limit and an expired token, as the upload queue does', async () => {
    const {read, limits} = reader(call => (call === 1 ? failure(undefined, 429) : call === 3 ? failure('PGRST301', 401) : null))

    expect(await collect(read)).toEqual(ROWS.map(row => row.id))
    expect(limits.slice(0, 4)).toEqual([4, 4, 4, 4])
  })

  it('stops on the database refusing the request itself', async () => {
    const {read, limits} = reader(() => failure('42501', 401))

    await expect(collect(read)).rejects.toThrow('42501')
    expect(limits).toEqual([4])
  })

  it('gives up on a failure that keeps coming back', async () => {
    const {read, limits} = reader(() => failure(undefined, 503))

    await expect(collect(read)).rejects.toThrow('503')
    expect(limits).toHaveLength(4)
  })

  it('stops at a cursor known to be the last', async () => {
    const {read} = reader()
    const ids: number[] = []
    for await (const page of keysetPages({read, first: 0, cursorOf: row => row.id, pageSize: 3, done: after => after >= 6})) {
      ids.push(...page.map(row => row.id))
    }

    expect(ids).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('stops once the run is cancelled, without waiting out a retry', async () => {
    const controller = new AbortController()
    const {read} = reader(() => {
      controller.abort()
      return failure(undefined, 0)
    })
    const pages = keysetPages({read, first: 0, cursorOf: row => row.id, pageSize: 4, signal: controller.signal})

    await expect(pages.next()).rejects.toThrow()
  })
})
