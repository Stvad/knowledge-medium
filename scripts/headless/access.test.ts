import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {mintWorkspaceKey} from '@/sync/keys/mintWorkspaceKey'
import {getWorkspaceKeyStore, readUsableKeyRecord} from '@/sync/keys/keyStore'
import {getModePin, setModePin, writePinUpgradeMarker} from '@/sync/keys/modePin'
import {resolveWorkspaceEntry, type GateWorkspace} from '@/sync/keys/resolveWorkspaceEntry'
import {openDeviceWorkspace} from './access'
import type {HeadlessConfig} from './config'

const user = 'member'
const workspaceId = 'scratch'
let dir: string
let encryptedRow: GateWorkspace
const plaintextRow: GateWorkspace = {name: null, wkCanary: null, encryptionMode: 'none'}
const keyPath = () => join(dir, 'device.key')
const config = (mode: HeadlessConfig['mode']): HeadlessConfig => {
  const common = {stateDir: dir, workspaceId, profile: 'test'}
  return mode === 'e2ee' ? {...common, mode, keyFile: keyPath()} : {...common, mode}
}
const pin = () => getModePin(user, workspaceId)
const entry = (row: GateWorkspace) => resolveWorkspaceEntry(user, workspaceId, async () => row)
const keys = () => readUsableKeyRecord(getWorkspaceKeyStore(), user, workspaceId)

beforeEach(async () => {
  stubLocalStorage()
  dir = await mkdtemp(join(tmpdir(), 'headless-access-'))
  const {canary, displayed} = await mintWorkspaceKey(workspaceId)
  encryptedRow = {name: null, wkCanary: canary, encryptionMode: 'e2ee'}
  await writeFile(keyPath(), displayed, {mode: 0o600})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await getWorkspaceKeyStore().clearForUser(user)
  vi.unstubAllGlobals()
  await rm(dir, {force: true, recursive: true})
})

describe('workspace access', () => {
  it.each(['server-e2ee', 'key-required'] as const)('unlocks %s with the validated key', async reason => {
    if (reason === 'key-required') setModePin(user, workspaceId, 'e2ee')
    expect(await entry(encryptedRow)).toMatchObject({kind: 'locked', reason})
    await openDeviceWorkspace(config('e2ee'), user, encryptedRow)
    expect(pin()).toBe('e2ee')
    expect(await keys()).not.toBeNull()
    expect(await entry(encryptedRow)).toEqual({kind: 'ready'})
  })

  it('pins a quarantined plaintext workspace and reopens it without writing again', async () => {
    expect(await entry(plaintextRow)).toMatchObject({kind: 'locked', reason: 'quarantine'})
    await openDeviceWorkspace(config('plaintext'), user, plaintextRow)
    expect(pin()).toBe('plaintext')
    const write = vi.spyOn(localStorage, 'setItem')
    await openDeviceWorkspace(config('plaintext'), user, plaintextRow)
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    ['plaintext', 'e2ee', 'server-e2ee'],
    ['e2ee', 'none', 'quarantine'],
  ] as const)('refuses configured %s against %s (%s) before writing the first pin', async (mode, reported, reason) => {
    const row = reported === 'e2ee' ? encryptedRow : plaintextRow
    expect(await entry(row)).toMatchObject({kind: 'locked', reason})
    const write = vi.spyOn(localStorage, 'setItem')
    await expect(openDeviceWorkspace(config(mode), user, row)).rejects.toThrow(`Configured ${mode}, workspace reports ${reported}`)
    expect(write).not.toHaveBeenCalled()
    expect(pin()).toBeNull()
    expect(await keys()).toBeNull()
  })

  it('refuses a reported downgrade even with an unlocked key and matching encrypted pin', async () => {
    await openDeviceWorkspace(config('e2ee'), user, encryptedRow)
    expect(await entry(plaintextRow)).toEqual({kind: 'ready'})
    await expect(openDeviceWorkspace(config('e2ee'), user, plaintextRow)).rejects.toThrow('Configured e2ee, workspace reports none')
    expect(pin()).toBe('e2ee')
  })

  it('refuses key-required for plaintext without downgrading the encrypted pin', async () => {
    setModePin(user, workspaceId, 'e2ee')
    expect(await entry(plaintextRow)).toMatchObject({kind: 'locked', reason: 'key-required'})
    await expect(openDeviceWorkspace(config('plaintext'), user, plaintextRow)).rejects.toThrow('key-required')
    expect(pin()).toBe('e2ee')
  })

  it('requires an operator for a server-e2ee conversion under an existing plaintext pin', async () => {
    setModePin(user, workspaceId, 'plaintext')
    expect(await entry(encryptedRow)).toMatchObject({kind: 'locked', reason: 'server-e2ee'})
    await expect(openDeviceWorkspace(config('e2ee'), user, encryptedRow)).rejects.toThrow('Workspace locked: server-e2ee')
    expect(pin()).toBe('plaintext')
    expect(await keys()).toBeNull()
  })

  it.each(['e2ee', 'plaintext'] as const)('refuses an interrupted pin upgrade in %s mode', async mode => {
    writePinUpgradeMarker(user, workspaceId)
    const row = mode === 'e2ee' ? encryptedRow : plaintextRow
    expect(await entry(row)).toMatchObject({kind: 'locked', reason: 'finishing-upgrade'})
    await expect(openDeviceWorkspace(config(mode), user, row)).rejects.toThrow('finishing-upgrade')
    expect(pin()).toBeNull()
  })

  it('validates the key against the workspace canary before the first pin', async () => {
    await writeFile(keyPath(), (await mintWorkspaceKey(workspaceId)).displayed)
    await expect(openDeviceWorkspace(config('e2ee'), user, encryptedRow)).rejects.toThrow('invalid-key')
    expect(pin()).toBeNull()
    expect(await keys()).toBeNull()
  })

  it('refuses a first unlock with a missing canary', async () => {
    await expect(openDeviceWorkspace(config('e2ee'), user, {...encryptedRow, wkCanary: null}))
      .rejects.toThrow('missing its key canary')
    expect(pin()).toBeNull()
  })

  it('refuses a group-readable key file', async () => {
    await chmod(keyPath(), 0o640)
    await expect(openDeviceWorkspace(config('e2ee'), user, encryptedRow)).rejects.toThrow('0600')
    expect(pin()).toBeNull()
    expect(await keys()).toBeNull()
  })

  it('refuses when the pin is correct but the unlocked key cannot be read back', async () => {
    vi.spyOn(getWorkspaceKeyStore(), 'put').mockResolvedValue(undefined)
    await expect(openDeviceWorkspace(config('e2ee'), user, encryptedRow)).rejects.toThrow('not ready')
    expect(pin()).toBe('e2ee')
    expect(await entry(encryptedRow)).toMatchObject({kind: 'locked', reason: 'key-required'})
  })

  it('refuses plaintext when the gate reports ready using an encrypted pin and key', async () => {
    await openDeviceWorkspace(config('e2ee'), user, encryptedRow)
    expect(await entry(plaintextRow)).toEqual({kind: 'ready'})
    await expect(openDeviceWorkspace(config('plaintext'), user, plaintextRow)).rejects.toThrow('configured mode pin')
    expect(pin()).toBe('e2ee')
  })

  it('reopens an already-unlocked encrypted workspace without reading the key file again', async () => {
    await openDeviceWorkspace(config('e2ee'), user, encryptedRow)
    await rm(keyPath())
    await openDeviceWorkspace(config('e2ee'), user, encryptedRow)
    expect(await keys()).not.toBeNull()
  })
})
