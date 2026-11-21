// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest'
import {withMirrorRunLock} from '../runLock.js'

const original = globalThis.navigator?.locks

/** Records the names asked for, and whether the lock was granted. */
const stubLocks = (granted = true) => {
  const requested: string[] = []
  const request = vi.fn(async (name: string, _opts: unknown, body: (lock: unknown) => unknown) => {
    requested.push(name)
    return body(granted ? {name} : null)
  })
  Object.defineProperty(globalThis.navigator, 'locks', {value: {request}, configurable: true})
  return {requested}
}

afterEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {value: original, configurable: true})
})

describe('withMirrorRunLock', () => {
  it('names the lock after the database, not just the origin', async () => {
    // A PR preview and production share an origin but have separate database
    // files; one name would let either defer the other for a whole cadence.
    const {requested} = stubLocks()

    await withMirrorRunLock('kmp-v6-alice.db', async () => 'ran')
    await withMirrorRunLock('kmp-v6~pr-9~alice.db', async () => 'ran')

    expect(new Set(requested).size).toBe(2)
    expect(requested[0]).toContain('kmp-v6-alice.db')
  })

  it('runs the body when the lock is free', async () => {
    stubLocks(true)
    expect(await withMirrorRunLock('db', async () => 'ran')).toBe('ran')
  })

  it('answers null without running the body when another holder has it', async () => {
    stubLocks(false)
    const body = vi.fn(async () => 'ran')

    expect(await withMirrorRunLock('db', body)).toBeNull()
    expect(body).not.toHaveBeenCalled()
  })

  it('still runs where the Web Locks API is missing — one realm makes it moot', async () => {
    Object.defineProperty(globalThis.navigator, 'locks', {value: undefined, configurable: true})
    expect(await withMirrorRunLock('db', async () => 'ran')).toBe('ran')
  })
})
