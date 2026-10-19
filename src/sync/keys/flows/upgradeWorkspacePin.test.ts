// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryWorkspaceKeyStore, type WorkspaceKeyRecord } from '../keyStore.js'
import {
  getModePin,
  hasPinUpgradeMarker,
  setModePin,
  upgradeModePinToE2ee,
  writePinUpgradeMarker,
} from '../modePin.js'
import type { WorkspaceConversionRead, WorkspaceConversionState } from '../conversionState.js'
import { mintCanary } from '../../crypto/canary.js'
import { deriveContentKeyHmac } from '../../crypto/contentKey.js'
import {
  formatWorkspaceKey,
  generateWorkspaceKeyBytes,
  importWorkspaceKey,
} from '../../crypto/workspaceKey.js'
import {
  checkServerE2eeEntry,
  resumePinUpgrade,
  upgradeWorkspacePin,
  type ServerE2eeEntryDeps,
  type WorkspaceDrain,
} from './upgradeWorkspacePin.js'

const USER = 'owner-1'
const WS = 'ws-converted'

let keyStore: InMemoryWorkspaceKeyStore
let canary: string
let wkString: string
let storedRecord: WorkspaceKeyRecord
let serverState: WorkspaceConversionState
let read: WorkspaceConversionRead | null
let copied: boolean
let drainWorkspace: ReturnType<typeof vi.fn<WorkspaceDrain>>

beforeEach(async () => {
  localStorage.clear()
  keyStore = new InMemoryWorkspaceKeyStore()
  const bytes = generateWorkspaceKeyBytes()
  wkString = formatWorkspaceKey(bytes)
  const wk = await importWorkspaceKey(bytes.slice())
  storedRecord = {wk, contentKeyHmac: await deriveContentKeyHmac(bytes.slice())}
  canary = await mintCanary(wk, WS)
  serverState = {encryptionMode: 'e2ee', conversionPhase: 'cleaning', wkCanary: canary, ownerUserId: USER}
  read = null
  copied = false
  drainWorkspace = vi.fn<WorkspaceDrain>(async () => ({deferred: 0}))
  setModePin(USER, WS, 'plaintext')
})

const entryDeps = (): ServerE2eeEntryDeps => ({
  userId: USER,
  workspaceId: WS,
  fetchConversionState: async () => read ?? {kind: 'read', state: serverState},
  hasCopiedCiphertext: async () => copied,
})

const upgrade = (key: Parameters<typeof upgradeWorkspacePin>[0]['key'] = {kind: 'pasted', text: wkString}) =>
  upgradeWorkspacePin({...entryDeps(), key, keyStore, drainWorkspace})

const resume = () => resumePinUpgrade({userId: USER, workspaceId: WS, keyStore, drainWorkspace})

describe('checkServerE2eeEntry', () => {
  it('opens once the server is past sealing, offering the owner to finish while it is cleaning', async () => {
    expect(await checkServerE2eeEntry(entryDeps())).toEqual({kind: 'open', canary, offerFinish: true})
  })

  it('offers no finish to a member who is not the owner', async () => {
    serverState = {...serverState, ownerUserId: 'someone-else'}
    expect(await checkServerE2eeEntry(entryDeps())).toEqual({kind: 'open', canary, offerFinish: false})
  })

  it('offers no finish once the conversion is done', async () => {
    serverState = {...serverState, conversionPhase: null}
    expect(await checkServerE2eeEntry(entryDeps())).toEqual({kind: 'open', canary, offerFinish: false})
  })

  it('refuses while the server is sealing', async () => {
    serverState = {...serverState, conversionPhase: 'sealing'}
    expect(await checkServerE2eeEntry(entryDeps())).toEqual({kind: 'converting'})
  })

  it('refuses when the phase cannot be read', async () => {
    read = {kind: 'unavailable', error: new TypeError('Failed to fetch')}
    expect(await checkServerE2eeEntry(entryDeps())).toEqual({kind: 'unavailable'})
  })

  it('refuses when the workspace row is not visible to this session', async () => {
    read = {kind: 'not-visible'}
    expect(await checkServerE2eeEntry(entryDeps())).toEqual({kind: 'unavailable'})
  })

  it('refuses when the server row is not e2ee or carries no canary', async () => {
    serverState = {...serverState, encryptionMode: 'none'}
    expect(await checkServerE2eeEntry(entryDeps())).toEqual({kind: 'unavailable'})
    serverState = {...serverState, encryptionMode: 'e2ee', wkCanary: null}
    expect(await checkServerE2eeEntry(entryDeps())).toEqual({kind: 'unavailable'})
  })

  it('sends a device that copied ciphertext to the reset', async () => {
    copied = true
    expect(await checkServerE2eeEntry(entryDeps())).toEqual({kind: 'copied-ciphertext'})
  })
})

describe('upgradeWorkspacePin', () => {
  it('stores the key, upgrades the pin, drains, and clears the marker', async () => {
    const order: string[] = []
    drainWorkspace.mockImplementation(async () => {
      order.push(`drain: pin=${getModePin(USER, WS)} marker=${hasPinUpgradeMarker(USER, WS)}`)
      return {deferred: 0}
    })

    expect(await upgrade()).toEqual({ok: true})

    expect(order).toEqual(['drain: pin=e2ee marker=true'])
    expect(getModePin(USER, WS)).toBe('e2ee')
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
    const rec = await keyStore.get(USER, WS)
    expect(rec?.contentKeyHmac).not.toBeNull()
  })

  it('the marker is durable before the pin moves', async () => {
    // A crash between the two must leave the marker, or the next start opens an
    // e2ee pin with the mismatch window's rows still staged.
    const markerAtPinWrite: boolean[] = []
    const setItem = localStorage.setItem.bind(localStorage)
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((k, v) => {
      if (k.startsWith('kmp-e2ee-mode:') && v === 'e2ee') markerAtPinWrite.push(hasPinUpgradeMarker(USER, WS))
      setItem(k, v)
    })
    try {
      expect(await upgrade()).toEqual({ok: true})
    } finally {
      spy.mockRestore()
    }
    expect(markerAtPinWrite).toEqual([true])
  })

  it('reuses a key already stored on this device (the converting device)', async () => {
    await keyStore.put(USER, WS, storedRecord)
    expect(await upgrade({kind: 'stored'})).toEqual({ok: true})
    expect(getModePin(USER, WS)).toBe('e2ee')
  })

  it('a stored key without K_id is not enough', async () => {
    await keyStore.put(USER, WS, {wk: storedRecord.wk, contentKeyHmac: null})
    expect(await upgrade({kind: 'stored'})).toEqual({ok: false, reason: 'no-stored-key'})
    expect(getModePin(USER, WS)).toBe('plaintext')
  })

  it('refuses while sealing, on the converting device too: no pin change, no drain', async () => {
    serverState = {...serverState, conversionPhase: 'sealing'}
    await keyStore.put(USER, WS, storedRecord)

    expect(await upgrade({kind: 'stored'})).toEqual({ok: false, reason: 'refused', entry: {kind: 'converting'}})
    expect(await upgrade()).toEqual({ok: false, reason: 'refused', entry: {kind: 'converting'}})

    expect(getModePin(USER, WS)).toBe('plaintext')
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
    expect(drainWorkspace).not.toHaveBeenCalled()
  })

  it('re-reads the server itself rather than trusting what the gate saw', async () => {
    const fetchConversionState = vi.fn(async (): Promise<WorkspaceConversionRead> =>
      ({kind: 'read', state: {...serverState, conversionPhase: 'sealing'}}))
    const result = await upgradeWorkspacePin({
      ...entryDeps(), fetchConversionState, key: {kind: 'pasted', text: wkString}, keyStore, drainWorkspace,
    })
    expect(fetchConversionState).toHaveBeenCalled()
    expect(result).toMatchObject({ok: false, reason: 'refused'})
  })

  it('a wrong key stores nothing and leaves the pin', async () => {
    const otherBytes = generateWorkspaceKeyBytes()
    expect(await upgrade({kind: 'pasted', text: formatWorkspaceKey(otherBytes)}))
      .toEqual({ok: false, reason: 'invalid-key'})
    expect(await keyStore.get(USER, WS)).toBeNull()
    expect(getModePin(USER, WS)).toBe('plaintext')
  })

  it('text that is not a key is a format error', async () => {
    expect(await upgrade({kind: 'pasted', text: 'not a key'})).toEqual({ok: false, reason: 'format'})
  })

  it('a key that cannot be saved is a storage failure, before the pin moves', async () => {
    keyStore.put = async () => {
      throw new Error('QuotaExceededError')
    }
    expect(await upgrade()).toEqual({ok: false, reason: 'storage'})
    expect(getModePin(USER, WS)).toBe('plaintext')
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
  })

  it('refuses a device that copied ciphertext', async () => {
    copied = true
    expect(await upgrade()).toEqual({ok: false, reason: 'refused', entry: {kind: 'copied-ciphertext'}})
    expect(getModePin(USER, WS)).toBe('plaintext')
  })

  it('pins an unpinned device the same way', async () => {
    localStorage.clear()
    expect(await upgrade()).toEqual({ok: true})
    expect(getModePin(USER, WS)).toBe('e2ee')
  })
})

// A crash at each step of the upgrade, then the next start. Each case builds the
// state the crash leaves behind and runs what startup runs.
describe('a crash during the upgrade', () => {
  it('after the key is stored, before the marker: nothing to resume, and the stored key finishes it', async () => {
    await keyStore.put(USER, WS, storedRecord)

    expect(await resume()).toEqual({kind: 'nothing-pending'})
    expect(getModePin(USER, WS)).toBe('plaintext')
    expect(drainWorkspace).not.toHaveBeenCalled()

    expect(await upgrade({kind: 'stored'})).toEqual({ok: true})
    expect(getModePin(USER, WS)).toBe('e2ee')
  })

  it('after the marker, before the pin: resume upgrades the pin, drains, clears', async () => {
    await keyStore.put(USER, WS, storedRecord)
    writePinUpgradeMarker(USER, WS)

    expect(await resume()).toEqual({kind: 'resumed'})
    expect(getModePin(USER, WS)).toBe('e2ee')
    expect(drainWorkspace).toHaveBeenCalledTimes(1)
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
  })

  it('after the pin, during the drain: the marker survives the failed drain and resume finishes it', async () => {
    drainWorkspace.mockRejectedValueOnce(new Error('tab closed mid-drain'))
    await expect(upgrade()).rejects.toThrow('tab closed mid-drain')
    expect(getModePin(USER, WS)).toBe('e2ee')
    expect(hasPinUpgradeMarker(USER, WS)).toBe(true)

    expect(await resume()).toEqual({kind: 'resumed'})
    expect(drainWorkspace).toHaveBeenCalledTimes(2)
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
  })

  it('after the drain, before the marker clears: resume drains again (idempotent) and clears', async () => {
    await keyStore.put(USER, WS, storedRecord)
    writePinUpgradeMarker(USER, WS)
    upgradeModePinToE2ee(USER, WS)

    expect(await resume()).toEqual({kind: 'resumed'})
    expect(drainWorkspace).toHaveBeenCalledTimes(1)
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
  })

  it('a drain that left rows deferred keeps the marker, so the next start drains again', async () => {
    // With an e2ee pin and a key, a row only defers when the key store can't be
    // read; clearing the marker then would open the workspace with them staged.
    drainWorkspace.mockResolvedValueOnce({deferred: 3})
    expect(await upgrade()).toEqual({ok: true})
    expect(getModePin(USER, WS)).toBe('e2ee')
    expect(hasPinUpgradeMarker(USER, WS)).toBe(true)

    drainWorkspace.mockResolvedValueOnce({deferred: 1})
    expect(await resume()).toEqual({kind: 'incomplete'})
    expect(hasPinUpgradeMarker(USER, WS)).toBe(true)

    expect(await resume()).toEqual({kind: 'resumed'})
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
  })

  it('an upgraded pin whose key is gone drops the marker, back to the key prompt', async () => {
    // Unlocking with the pasted key then drains the whole workspace, which is
    // what the marker was waiting for.
    writePinUpgradeMarker(USER, WS)
    upgradeModePinToE2ee(USER, WS)

    expect(await resume()).toEqual({kind: 'key-missing'})
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
    expect(drainWorkspace).not.toHaveBeenCalled()
  })

  it('a key store that cannot be read keeps the marker: the resume throws, to be retried', async () => {
    // Dropping it would let the next read succeed, open the workspace `ready`, and
    // leave the mismatch window's rows staged with nothing to drain them.
    await keyStore.put(USER, WS, storedRecord)
    writePinUpgradeMarker(USER, WS)
    upgradeModePinToE2ee(USER, WS)
    const get = keyStore.get.bind(keyStore)
    keyStore.get = async () => { throw new Error('IndexedDB unavailable') }

    await expect(resume()).rejects.toThrow('IndexedDB unavailable')
    expect(hasPinUpgradeMarker(USER, WS)).toBe(true)
    expect(drainWorkspace).not.toHaveBeenCalled()

    keyStore.get = get
    expect(await resume()).toEqual({kind: 'resumed'})
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
  })

  it('a marker whose key was evicted before the pin moved is dropped, back to the gate', async () => {
    writePinUpgradeMarker(USER, WS)

    expect(await resume()).toEqual({kind: 'key-missing'})
    expect(getModePin(USER, WS)).toBe('plaintext')
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
    expect(drainWorkspace).not.toHaveBeenCalled()
  })
})
