// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    const rec = await keyStore.get(USER, 'ws-fixed')
    expect(rec?.wk).toBeDefined()
    // K_id (§10) derived + co-located at create, so this device resolves media.
    expect(rec?.contentKeyHmac, 'create must derive K_id').not.toBeNull()
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

  it('refuses (no server row, no pin) when the key store write fails — never an unopenable workspace', async () => {
    // IndexedDB unwritable (quota / corruption / private mode) while localStorage
    // works. The key-store preflight probe must refuse BEFORE creating the server
    // row, rather than producing an e2ee workspace with a pin but no key that
    // this device could never open (the gate would loop on re-paste).
    let rpcCalled = false
    const failingStore = {
      get: async () => null,
      put: async () => {
        throw new Error('QuotaExceededError')
      },
      delete: async () => {},
      clearForUser: async () => {},
    }
    await expect(
      createEncryptedWorkspace('Secret', {
        userId: USER,
        keyStore: failingStore,
        newWorkspaceId: () => 'ws-nokey',
        createWorkspace: async (_name, options) => {
          rpcCalled = true
          return { workspaceId: options.workspaceId }
        },
      }),
    ).rejects.toThrow(/storage/i)
    expect(rpcCalled).toBe(false)
    expect(getModePin(USER, 'ws-nokey')).toBeNull()
  })

  it('refuses to create (no server row, no local key) when pin storage is unavailable', async () => {
    // E2EE needs durable pin storage. If localStorage can't persist, the flow
    // must refuse BEFORE creating the server row — otherwise the user would have
    // a server-side encrypted workspace this device can never open.
    const keyStore = new InMemoryWorkspaceKeyStore()
    let rpcCalled = false
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage is blocked')
    })
    try {
      await expect(
        createEncryptedWorkspace('Secret', {
          userId: USER,
          keyStore,
          newWorkspaceId: () => 'ws-nostore',
          createWorkspace: async (_name, options) => {
            rpcCalled = true
            return { workspaceId: options.workspaceId }
          },
        }),
      ).rejects.toThrow(/storage/i)
      expect(rpcCalled).toBe(false)
      expect(await keyStore.get(USER, 'ws-nostore')).toBeNull()
    } finally {
      spy.mockRestore()
    }
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
