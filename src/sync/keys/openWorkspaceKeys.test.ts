import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryWorkspaceKeyStore, type WorkspaceKeyStore } from './keyStore.js'
import {
  onWorkspaceKeyUnavailable,
  orNullWhenKeyUnavailable,
  requireWorkspaceKeys,
  WorkspaceKeyUnavailableError,
} from './openWorkspaceKeys.js'

const USER = 'user-1'
const WS = 'ws-A'
const WK = {name: 'wk'} as unknown as CryptoKey
const KID = {name: 'k_id'} as unknown as CryptoKey

let unsubscribe = () => {}
afterEach(() => unsubscribe())

const watch = () => {
  const reported = vi.fn()
  unsubscribe = onWorkspaceKeyUnavailable(reported)
  return reported
}

describe('requireWorkspaceKeys', () => {
  it('returns the stored keys and reports nothing', async () => {
    const reported = watch()
    const store = new InMemoryWorkspaceKeyStore()
    await store.put(USER, WS, {wk: WK, contentKeyHmac: KID})

    expect(await requireWorkspaceKeys(store, USER, WS)).toEqual({cek: WK, contentKeyHmac: KID})
    expect(reported).not.toHaveBeenCalled()
  })

  it.each([
    ['no record', async (store: InMemoryWorkspaceKeyStore) => { await store.put(USER, 'ws-other', {wk: WK, contentKeyHmac: KID}) }],
    ['a legacy record with no K_id', async (store: InMemoryWorkspaceKeyStore) => { await store.put(USER, WS, {wk: WK, contentKeyHmac: null}) }],
  ])('reports the workspace, then throws, for %s', async (_case, seed) => {
    const reported = watch()
    const store = new InMemoryWorkspaceKeyStore()
    await seed(store)

    const error = await requireWorkspaceKeys(store, USER, WS).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(WorkspaceKeyUnavailableError)
    expect((error as WorkspaceKeyUnavailableError).workspaceId).toBe(WS)
    expect(reported).toHaveBeenCalledWith(USER, WS)
  })

  it('tries a failed read once more before reporting anything', async () => {
    const reported = watch()
    const store = new InMemoryWorkspaceKeyStore()
    await store.put(USER, WS, {wk: WK, contentKeyHmac: KID})
    vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('IndexedDB connection lost'))

    expect(await requireWorkspaceKeys(store, USER, WS)).toEqual({cek: WK, contentKeyHmac: KID})
    expect(reported).not.toHaveBeenCalled()
  })

  it('treats an unreadable store as no key, keeping the read failure as the cause', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reported = watch()
    const failure = new Error('IndexedDB connection lost')
    const store: WorkspaceKeyStore = {
      get: async () => { throw failure },
      put: async () => {},
      delete: async () => {},
      clearForUser: async () => {},
    }

    const error = await requireWorkspaceKeys(store, USER, WS).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(WorkspaceKeyUnavailableError)
    expect((error as Error).cause).toBe(failure)
    expect(reported).toHaveBeenCalledWith(USER, WS)
  })
})

describe('orNullWhenKeyUnavailable', () => {
  it('answers null for a read that found no key, and passes any other failure on', async () => {
    expect(await orNullWhenKeyUnavailable(Promise.reject(new WorkspaceKeyUnavailableError(WS)))).toBeNull()
    await expect(orNullWhenKeyUnavailable(Promise.reject(new Error('db closed')))).rejects.toThrow('db closed')
  })
})
