import { describe, expect, it } from 'vitest'
import type { ByteStore } from '../byteStore.js'

const U = 'user-1'
const WS = 'ws-A'
const KEY = 'deadbeef'
const bytes = (...vals: number[]) => new Uint8Array(vals)

/** The behaviour every {@link ByteStore} backend must have. `make` returns an empty store. */
export const describeByteStoreContract = (name: string, make: () => ByteStore): void => {
  describe(`ByteStore contract — ${name}`, () => {
    it('returns null on a miss', async () => {
      expect(await make().get(U, WS, KEY)).toBeNull()
      expect(await make().has(U, WS, KEY)).toBe(false)
    })

    it('round-trips bytes by (user, workspace, key)', async () => {
      const store = make()
      await store.put(U, WS, KEY, bytes(1, 2, 3))
      expect(await store.get(U, WS, KEY)).toEqual(bytes(1, 2, 3))
      expect(await store.has(U, WS, KEY)).toBe(true)
    })

    it('isolates by user, workspace, and key', async () => {
      const store = make()
      await store.put(U, WS, KEY, bytes(1))
      expect(await store.get('other-user', WS, KEY)).toBeNull()
      expect(await store.get(U, 'other-ws', KEY)).toBeNull()
      expect(await store.get(U, WS, 'other-key')).toBeNull()
    })

    it('does not alias the stored buffer (a later mutation of the source is not reflected)', async () => {
      const store = make()
      const src = bytes(9, 9, 9)
      await store.put(U, WS, KEY, src)
      src[0] = 0 // mutate the caller's buffer after the put
      expect(await store.get(U, WS, KEY)).toEqual(bytes(9, 9, 9))
    })

    it('purgeWorkspace drops only that workspace, leaving the user’s other workspaces', async () => {
      const store = make()
      await store.put(U, WS, KEY, bytes(1))
      await store.put(U, 'ws-B', KEY, bytes(2))
      await store.put('other-user', WS, KEY, bytes(3))

      await store.purgeWorkspace(U, WS)

      expect(await store.get(U, WS, KEY)).toBeNull() // purged
      expect(await store.get(U, 'ws-B', KEY)).toEqual(bytes(2)) // sibling ws survives
      expect(await store.get('other-user', WS, KEY)).toEqual(bytes(3)) // other account survives
    })

    it('purgeWorkspace is a no-op when nothing is stored', async () => {
      await expect(make().purgeWorkspace(U, WS)).resolves.toBeUndefined()
    })

    it('delete drops a single object, leaving siblings; no-op when absent', async () => {
      const store = make()
      await store.put(U, WS, KEY, bytes(1))
      await store.put(U, WS, 'other-key', bytes(2))

      await store.delete(U, WS, KEY)
      expect(await store.get(U, WS, KEY)).toBeNull() // deleted
      expect(await store.get(U, WS, 'other-key')).toEqual(bytes(2)) // sibling survives

      await expect(store.delete(U, WS, 'never-stored')).resolves.toBeUndefined() // no-op
    })

    it('listWorkspaceKeys returns the stored content-keys for one (user, workspace), scoped', async () => {
      const store = make()
      await store.put(U, WS, 'aaaa', bytes(1))
      await store.put(U, WS, 'bbbb', bytes(2))
      await store.put(U, 'ws-B', 'cccc', bytes(3)) // a sibling workspace
      await store.put('other-user', WS, 'dddd', bytes(4)) // another account

      expect(await store.listWorkspaceKeys(U, WS)).toEqual(new Set(['aaaa', 'bbbb']))
      expect(await store.listWorkspaceKeys(U, 'empty-ws')).toEqual(new Set()) // nothing stored
    })

    it('listWorkspaceKeys decodes filenames back to keys (round-trips a reserved char)', async () => {
      const store = make()
      await store.put(U, WS, 'a/b', bytes(1)) // '/' is escaped on disk, must decode back
      expect(await store.listWorkspaceKeys(U, WS)).toEqual(new Set(['a/b']))
    })
  })
}
