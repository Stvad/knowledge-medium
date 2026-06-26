import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceKeyRecord } from './keyStore.js'
import type { ModePin } from './modePin.js'
import type { GateWorkspace } from './resolveWorkspaceEntry.js'

// The read-half wraps two side-effecting reads (the local pin and the
// per-device key store); mock them so the test drives the orchestration the
// pure decideWorkspaceEntry can't see (key lookup, its failure handling, and
// the name/canary enrichment for the lock prompt).
const getModePin = vi.fn<(userId: string, workspaceId: string) => ModePin | null>()
const keyGet = vi.fn<(userId: string, workspaceId: string) => Promise<WorkspaceKeyRecord | null>>()
const aRecord = (): WorkspaceKeyRecord => ({ wk: {} as CryptoKey, contentKeyHmac: null })

vi.mock('./modePin.js', () => ({getModePin: (u: string, w: string) => getModePin(u, w)}))
vi.mock('./keyStore.js', () => ({getWorkspaceKeyStore: () => ({get: keyGet})}))

const { resolveWorkspaceEntry } = await import('./resolveWorkspaceEntry.js')

const workspace = (over: Partial<GateWorkspace> = {}): GateWorkspace => ({
  encryptionMode: 'none',
  name: 'My space',
  wkCanary: null,
  ...over,
})

beforeEach(() => {
  getModePin.mockReset()
  keyGet.mockReset()
  keyGet.mockResolvedValue(null)
})

describe('resolveWorkspaceEntry (read-inputs half of the §6 gate)', () => {
  it('plaintext pin → ready without reading the key store or the row', async () => {
    getModePin.mockReturnValue('plaintext')
    const loadWorkspace = vi.fn()
    expect(await resolveWorkspaceEntry('u', 'w', loadWorkspace)).toEqual({kind: 'ready'})
    expect(keyGet).not.toHaveBeenCalled()
  })

  it('e2ee pin reads the key store; key present → ready', async () => {
    getModePin.mockReturnValue('e2ee')
    keyGet.mockResolvedValue(aRecord())
    expect(await resolveWorkspaceEntry('u', 'w', async () => null)).toEqual({kind: 'ready'})
    expect(keyGet).toHaveBeenCalledWith('u', 'w')
  })

  it('a thrown key-store read is treated as locked, not fatal', async () => {
    getModePin.mockReturnValue('e2ee')
    keyGet.mockRejectedValue(new Error('IndexedDB unavailable'))
    const entry = await resolveWorkspaceEntry('u', 'w', async () => workspace({encryptionMode: 'e2ee'}))
    expect(entry).toMatchObject({kind: 'locked', reason: 'key-required'})
  })

  it('locked entries carry the row name and canary for the prompt', async () => {
    getModePin.mockReturnValue(null)
    const entry = await resolveWorkspaceEntry('u', 'w', async () =>
      workspace({encryptionMode: 'e2ee', name: 'Vault', wkCanary: 'canary-1'}),
    )
    expect(entry).toEqual({
      kind: 'locked',
      reason: 'key-required',
      workspaceName: 'Vault',
      canary: 'canary-1',
    })
  })

  it('waits when the row needed to decide has not synced yet', async () => {
    getModePin.mockReturnValue(null)
    expect(await resolveWorkspaceEntry('u', 'w', async () => null)).toEqual({kind: 'waiting'})
  })
})
