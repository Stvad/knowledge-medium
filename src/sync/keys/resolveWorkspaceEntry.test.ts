import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceKeyRecord } from './keyStore.js'
import type { ModePin } from './modePin.js'
import type { GateWorkspace } from './resolveWorkspaceEntry.js'

// The read-half wraps two side-effecting reads (the local pin and the
// per-device key store); mock them so the test drives the orchestration the
// pure decideWorkspaceEntry can't see (key lookup, its failure handling, and
// the name/canary enrichment for the lock prompt).
const getModePin = vi.fn<(userId: string, workspaceId: string) => ModePin | null>()
const hasPinUpgradeMarker = vi.fn<(userId: string, workspaceId: string) => boolean>()
const keyGet = vi.fn<(userId: string, workspaceId: string) => Promise<WorkspaceKeyRecord | null>>()
// A full (post-K_id) record — WK + content-key HMAC co-located.
const aRecord = (): WorkspaceKeyRecord => ({ wk: {} as CryptoKey, contentKeyHmac: {} as CryptoKey })
// A LEGACY record — bare WK, no K_id (pre-content-key feature).
const legacyRecord = (): WorkspaceKeyRecord => ({ wk: {} as CryptoKey, contentKeyHmac: null })

vi.mock('./modePin.js', () => ({
  getModePin: (u: string, w: string) => getModePin(u, w),
  hasPinUpgradeMarker: (u: string, w: string) => hasPinUpgradeMarker(u, w),
}))
vi.mock('./keyStore.js', async (importActual) => ({
  ...(await importActual<typeof import('./keyStore.js')>()),
  getWorkspaceKeyStore: () => ({get: keyGet}),
}))

const { resolveWorkspaceEntry } = await import('./resolveWorkspaceEntry.js')

const workspace = (over: Partial<GateWorkspace> = {}): GateWorkspace => ({
  encryptionMode: 'none',
  name: 'My space',
  wkCanary: null,
  ...over,
})

beforeEach(() => {
  getModePin.mockReset()
  hasPinUpgradeMarker.mockReset()
  hasPinUpgradeMarker.mockReturnValue(false)
  keyGet.mockReset()
  keyGet.mockResolvedValue(null)
})

describe('resolveWorkspaceEntry (read-inputs half of the §6 gate)', () => {
  it('plaintext pin → ready without reading the key store', async () => {
    getModePin.mockReturnValue('plaintext')
    expect(await resolveWorkspaceEntry('u', 'w', async () => workspace())).toEqual({kind: 'ready'})
    expect(keyGet).not.toHaveBeenCalled()
  })

  it('plaintext pin with no row waits for it', async () => {
    getModePin.mockReturnValue('plaintext')
    expect(await resolveWorkspaceEntry('u', 'w', async () => null)).toEqual({kind: 'waiting'})
  })

  it('e2ee pin reads the key store; key present → ready', async () => {
    getModePin.mockReturnValue('e2ee')
    keyGet.mockResolvedValue(aRecord())
    expect(await resolveWorkspaceEntry('u', 'w', async () => null)).toEqual({kind: 'ready'})
    expect(keyGet).toHaveBeenCalledWith('u', 'w')
  })

  it('a LEGACY record (no K_id) → locked, so the gate prompts a re-paste', async () => {
    // Pre-content-key WK can decrypt text but not media; K_id can't be re-derived
    // from the stored WK, so the workspace must re-unlock rather than open `ready`
    // into permanently-broken media.
    getModePin.mockReturnValue('e2ee')
    keyGet.mockResolvedValue(legacyRecord())
    const entry = await resolveWorkspaceEntry('u', 'w', async () => workspace({encryptionMode: 'e2ee'}))
    expect(entry).toMatchObject({kind: 'locked', reason: 'key-required'})
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
      reason: 'server-e2ee',
      workspaceName: 'Vault',
      canary: 'canary-1',
    })
  })

  it('waits when the row needed to decide has not synced yet', async () => {
    getModePin.mockReturnValue(null)
    expect(await resolveWorkspaceEntry('u', 'w', async () => null)).toEqual({kind: 'waiting'})
  })

  it('a pending pin upgrade resumes before anything else, without the row', async () => {
    // The marker is written after the server check passed, and finishing it is
    // local (pin + drain), so it needs neither the row nor the key read here.
    getModePin.mockReturnValue('e2ee')
    hasPinUpgradeMarker.mockReturnValue(true)
    const loadWorkspace = vi.fn(async () => null)
    expect(await resolveWorkspaceEntry('u', 'w', loadWorkspace)).toEqual({
      kind: 'locked',
      reason: 'finishing-upgrade',
      workspaceName: null,
      canary: null,
    })
    expect(keyGet).not.toHaveBeenCalled()
  })

  it('a plaintext pin the server converted is gated, carrying the canary', async () => {
    getModePin.mockReturnValue('plaintext')
    const entry = await resolveWorkspaceEntry('u', 'w', async () =>
      workspace({encryptionMode: 'e2ee', wkCanary: 'canary-1'}),
    )
    expect(entry).toMatchObject({kind: 'locked', reason: 'server-e2ee', canary: 'canary-1'})
  })
})
