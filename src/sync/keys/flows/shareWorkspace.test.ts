// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryWorkspaceKeyStore } from '../keyStore.js'
import { getModePin } from '../modePin.js'
import { createEncryptedWorkspace } from './createEncryptedWorkspace.js'
import { unlockWorkspaceWithKey } from './unlockWorkspaceWithKey.js'

/**
 * §8.3 — sharing an E2EE workspace needs NO new flow: the owner uses the
 * existing invite→accept chain (membership is plaintext metadata), sends the WK
 * out of band, and the collaborator opens it through the same key-required gate
 * (§6 rule 3, branch a) + {@link unlockWorkspaceWithKey} a new device uses.
 *
 * This test pins the one property that makes share work and isn't obvious from
 * either flow alone: the `wk_canary` is WORKSPACE-scoped, not user-scoped, so a
 * WK minted by the owner validates for a *different* collaborator user. If
 * someone ever made the canary depend on the minter's user id, share would
 * silently break and this would catch it.
 */
const OWNER = 'owner-1'
const COLLABORATOR = 'collab-2'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('§8.3 share an E2EE workspace with another user', () => {
  it('an owner-minted WK opens the workspace for a different collaborator user', async () => {
    // Owner creates the encrypted workspace on their device; the server stores
    // the canary the owner's create RPC produced.
    const ownerStore = new InMemoryWorkspaceKeyStore()
    let canary: string | null = null
    const created = await createEncryptedWorkspace('Shared', {
      userId: OWNER,
      keyStore: ownerStore,
      newWorkspaceId: () => 'ws-shared',
      createWorkspace: async (_name, options) => {
        canary = options.wkCanary
        return { workspaceId: options.workspaceId }
      },
    })

    // The owner sends `created.workspaceKey` to the collaborator out of band
    // (never through the app). The collaborator accepts the invite, the
    // workspace row syncs with encryption_mode='e2ee' + this canary, the gate
    // puts them on the key-required branch, and they paste the WK on their own
    // device (a fresh, separate key store).
    const collaboratorStore = new InMemoryWorkspaceKeyStore()
    const result = await unlockWorkspaceWithKey({
      userId: COLLABORATOR,
      workspaceId: 'ws-shared',
      canary: canary!,
      pastedKey: created.workspaceKey,
      keyStore: collaboratorStore,
    })

    expect(result).toEqual({ ok: true })
    // The collaborator is now independently pinned e2ee and holds the key on
    // their device — without the owner ever transmitting it through the server.
    expect(getModePin(COLLABORATOR, 'ws-shared')).toBe('e2ee')
    expect(await collaboratorStore.get(COLLABORATOR, 'ws-shared')).not.toBeNull()
  })
})
