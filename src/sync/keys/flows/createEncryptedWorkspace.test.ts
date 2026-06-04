import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryWorkspaceKeyStore } from '../keyStore.js'
import { getModePin } from '../modePin.js'
import { importWorkspaceKey, parseWorkspaceKey, WK_PREFIX } from '../../crypto/workspaceKey.js'
import { validateCanary } from '../../crypto/canary.js'
import { createEncryptedWorkspace } from './createEncryptedWorkspace.js'

const USER = 'user-1'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('createEncryptedWorkspace (§8.1)', () => {
  it('mints a canary the shown WK can validate, calls the RPC with e2ee params, and stores key + pin', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    let rpcArgs: { name: string; options: { encryptionMode: string; workspaceId: string; wkCanary: string } } | null =
      null

    const result = await createEncryptedWorkspace('Secret', {
      userId: USER,
      keyStore,
      newWorkspaceId: () => 'ws-fixed',
      createWorkspace: async (name, options) => {
        rpcArgs = { name, options }
        return { workspaceId: options.workspaceId }
      },
    })

    // The user is shown a paste-friendly WK string.
    expect(result.workspaceKey.startsWith(WK_PREFIX)).toBe(true)

    // RPC got the e2ee mode, the client-chosen id, and a canary.
    expect(rpcArgs).not.toBeNull()
    expect(rpcArgs!.name).toBe('Secret')
    expect(rpcArgs!.options.encryptionMode).toBe('e2ee')
    expect(rpcArgs!.options.workspaceId).toBe('ws-fixed')

    // The invariant that matters: a future device pasting the shown WK can open
    // the canary the server stored — i.e. §8.2 validation will succeed.
    const pastedKey = await importWorkspaceKey(parseWorkspaceKey(result.workspaceKey))
    expect(await validateCanary(pastedKey, rpcArgs!.options.wkCanary, 'ws-fixed')).toBe(true)

    // Key persisted on this device + workspace pinned e2ee.
    expect(await keyStore.get(USER, 'ws-fixed')).not.toBeNull()
    expect(getModePin(USER, 'ws-fixed')).toBe('e2ee')

    // The pass-through workspace payload is preserved on the result.
    expect(result.workspaceId).toBe('ws-fixed')
  })

  it('leaves no local key or pin when the create RPC fails (server row first)', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    await expect(
      createEncryptedWorkspace('Secret', {
        userId: USER,
        keyStore,
        newWorkspaceId: () => 'ws-fail',
        createWorkspace: async () => {
          throw new Error('rpc boom')
        },
      }),
    ).rejects.toThrow('rpc boom')

    expect(await keyStore.get(USER, 'ws-fail')).toBeNull()
    expect(getModePin(USER, 'ws-fail')).toBeNull()
  })

  it('still pins e2ee and reveals the WK when the key store write fails (locked, not orphaned)', async () => {
    // A device where IndexedDB put fails (quota / private mode). The workspace
    // must end up e2ee-pinned-but-locked, with the WK returned so the user can
    // save it and re-paste — never an orphaned workspace whose mode is unknown.
    const failingStore = {
      get: async () => null,
      put: async () => {
        throw new Error('QuotaExceededError')
      },
      delete: async () => {},
      clearAll: async () => {},
    }
    const result = await createEncryptedWorkspace('Secret', {
      userId: USER,
      keyStore: failingStore,
      newWorkspaceId: () => 'ws-nokey',
      createWorkspace: async (_name, options) => ({ workspaceId: options.workspaceId }),
    })
    expect(result.workspaceKey.startsWith(WK_PREFIX)).toBe(true)
    expect(getModePin(USER, 'ws-nokey')).toBe('e2ee')
  })

  it('generates a distinct random WK per call by default', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    const make = (id: string) =>
      createEncryptedWorkspace('WS', {
        userId: USER,
        keyStore,
        newWorkspaceId: () => id,
        createWorkspace: async (_name, options) => ({ workspaceId: options.workspaceId }),
      })
    const a = await make('ws-a')
    const b = await make('ws-b')
    expect(a.workspaceKey).not.toBe(b.workspaceKey)
  })
})
