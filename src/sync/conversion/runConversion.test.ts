import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validateCanary } from '../crypto/canary.js'
import { InMemoryWorkspaceKeyStore, type WorkspaceKeyRecord } from '../keys/keyStore.js'
import { mintWorkspaceKey } from '../keys/mintWorkspaceKey.js'
import type { SavedKeyPrompt, SaveKeyPrompt } from './conversionKey.js'
import { FLIP_SETTLED_MS, InMemoryFlipAttempts } from './flipAttempts.js'
import type { PreflightReport } from './preflight.js'
import { conversionLockName, webConversionLock } from './runLock.js'
import {
  runConversion,
  type ActiveStage,
  type ConversionFlowDeps,
  type ConversionStatus,
  type ConversionUi,
} from './runConversion.js'
import { rawNameOf } from './bundle/attachmentParts.js'
import { keyOf, mediaPropertiesJson, sealFor, seedMedia, seedPlaintext, WS } from './test/conversionFixtures.js'
import { FakeConversionServer } from './test/fakeConversionServer.js'
import { emptyBundleRecord, FAKE_LOCAL_DB, flowDeps, passingEnvironment, USER } from './test/flowFixtures.js'
import { MemoryBundleFolder } from './test/memoryBundleFolder.js'
import type { BundleFolder } from './bundle/bundleParts.js'
import { InMemoryBundleRecordStore } from './bundle/bundleRecord.js'
import type { FinishPrompt } from './cleaningStage.js'
import { createFakeAttachmentStorage, type FakeAttachmentStorage } from './test/fakeAttachmentStorage.js'

/** A user who answers every prompt as told, and remembers what they were asked. */
class ScriptedUi implements ConversionUi {
  readonly statuses: ConversionStatus[] = []
  readonly contracts: ActiveStage['kind'][] = []
  readonly preflights: PreflightReport[] = []
  readonly keyPrompts: SaveKeyPrompt[] = []
  readonly savedKeyPrompts: SavedKeyPrompt[] = []
  /** What the user types back, given the key shown; by default what was shown. */
  typeBack: (prompt: SaveKeyPrompt) => string = prompt => prompt.displayed
  /** What the user pastes when asked for the saved key, in order; null starts over. */
  pastes: Array<string | null> = []
  cancelContract = false
  /** Where the user puts each new bundle. */
  readonly bundleParent = new MemoryBundleFolder('picked')

  async chooseBundleFolder() {
    return this.bundleParent
  }

  async reopenBundleFolder({recorded}: {recorded: BundleFolder}) {
    return recorded
  }

  async confirmContract(stage: ActiveStage) {
    this.contracts.push(stage.kind)
    if (this.cancelContract) throw new DOMException('cancelled', 'AbortError')
  }

  async confirmPreflight(report: PreflightReport) {
    this.preflights.push(report)
  }

  async saveKey(prompt: SaveKeyPrompt) {
    this.keyPrompts.push(prompt)
    return this.typeBack(prompt)
  }

  async enterSavedKey(prompt: SavedKeyPrompt) {
    this.savedKeyPrompts.push(prompt)
    const next = this.pastes.shift()
    if (next === undefined) throw new Error('the test pasted no more keys')
    return next
  }

  async confirmNoVerifiedSource() {
    throw new Error('every attachment has a verified copy')
  }

  async chooseExistingBundle(): Promise<BundleFolder> {
    throw new Error('this device holds the bundle record')
  }

  readonly finishes: FinishPrompt[] = []
  async confirmFinish(prompt: FinishPrompt) {
    this.finishes.push(prompt)
  }

  status(status: ConversionStatus) {
    this.statuses.push(status)
  }
}

let server: FakeConversionServer
let keyStore: InMemoryWorkspaceKeyStore
let flipAttempts: InMemoryFlipAttempts
let ui: ScriptedUi
let localCanaries: string[]
let clock: number
let storage: FakeAttachmentStorage
let bundles: InMemoryBundleRecordStore


beforeEach(() => {
  server = new FakeConversionServer()
  seedPlaintext(server, 3)
  keyStore = new InMemoryWorkspaceKeyStore()
  clock = 1_000_000
  flipAttempts = new InMemoryFlipAttempts(() => clock)
  ui = new ScriptedUi()
  localCanaries = []
  storage = createFakeAttachmentStorage()
  bundles = new InMemoryBundleRecordStore()
})

const run = (overrides: Partial<ConversionFlowDeps> = {}) =>
  runConversion(flowDeps(server, ui, {
    keyStore,
    flipAttempts,
    attachments: storage.io,
    bundles,
    markLocalConverted: async canary => void localCanaries.push(canary),
    ...overrides,
  }))
const flips = () => server.calls.filter(call => call.method === 'convertWorkspaceToE2ee').length

const serverCanary = async (): Promise<string> => {
  const read = await server.conversionState(WS)
  if (read.kind !== 'read' || !read.state.wkCanary) throw new Error('the server holds no canary')
  return read.state.wkCanary
}

const storedKey = async (): Promise<WorkspaceKeyRecord> => {
  const record = await keyStore.get(USER, WS)
  if (!record) throw new Error('no key stored')
  return record
}

/** A key an earlier attempt minted, showed, had typed back and stored, then didn't flip. */
const earlierAttempt = async () => {
  const earlier = await mintWorkspaceKey(WS)
  await keyStore.put(USER, WS, earlier.record)
  return earlier
}

const PLAINTEXT_READ = {kind: 'read' as const, state: {encryptionMode: 'none', conversionPhase: null, wkCanary: null, ownerUserId: USER}}

describe('runConversion: preflight → key → flip', () => {
  it('flips under a key the user typed back, stores it, and marks the local row', async () => {
    const result = await run()

    // Past the flip the stage runs on through the bundle, re-seal, purge and cleanup.
    expect(result).toMatchObject({kind: 'done'})
    expect(ui.finishes).toEqual([{unrecoverable: [], left: [], refused: [], bundleRead: true}])
    expect(ui.contracts).toEqual(['plaintext'])
    // The dry run measures what the bundle then writes.
    const [bundle] = [...ui.bundleParent.folders.values()]
    const manifest = JSON.parse(bundle.text('manifest.json'))
    expect(ui.preflights).toEqual([{
      oversized: [],
      noVerifiedSource: [],
      sizes: {
        blockRows: 3,
        blocksBytes: manifest.parts['blocks.jsonl'].bytes,
        historyRows: 3,
        historyBytes: manifest.parts['server-history.jsonl'].bytes,
        localDbBytes: FAKE_LOCAL_DB.length,
        attachmentBytes: 0,
        contentBytes: expect.any(Number),
      },
    }])
    expect(ui.keyPrompts).toHaveLength(1)
    expect(await validateCanary((await storedKey()).wk, await serverCanary(), WS)).toBe(true)
    expect(localCanaries[0]).toBe(await serverCanary())
    // The sealing stage's canary check needed no paste: this device holds the key.
    expect(ui.savedKeyPrompts).toEqual([])
  })

  it('keeps the screen awake through the preflight scan', async () => {
    const awake: string[] = []
    ui.confirmPreflight = async () => void awake.push('confirm')

    await run({keepAwake: async () => (awake.push('on'), () => void awake.push('off'))})

    expect(awake.slice(0, 3)).toEqual(['on', 'off', 'confirm'])
  })

  it('asks again until the typed-back key unlocks the workspace, storing nothing before', async () => {
    let attempts = 0
    ui.typeBack = prompt => (++attempts < 3 ? `${prompt.displayed.slice(0, -2)}xx` : prompt.displayed)
    const put = vi.spyOn(keyStore, 'put')

    await run()

    expect(ui.keyPrompts.map(prompt => prompt.mismatch)).toEqual([false, true, true])
    expect(new Set(ui.keyPrompts.map(prompt => prompt.displayed)).size).toBe(1)
    // The probe writes elsewhere; the workspace's key is stored once, after the match.
    expect(put.mock.calls.filter(([, workspaceId]) => workspaceId === WS)).toHaveLength(1)
  })

  it('flips under an earlier attempt\'s key only once the user pastes their copy of it', async () => {
    const earlier = await earlierAttempt()
    ui.pastes = [(await mintWorkspaceKey(WS)).displayed, earlier.displayed]

    await run()

    expect(ui.keyPrompts).toEqual([])
    expect(ui.savedKeyPrompts).toEqual([
      {context: 'earlier-attempt', problem: null, canStartOver: true},
      {context: 'earlier-attempt', problem: 'invalid-key', canStartOver: true},
    ])
    expect(await validateCanary(earlier.record.wk, await serverCanary(), WS)).toBe(true)
  })

  it('starts over with a new key when the user no longer has the earlier one', async () => {
    const earlier = await earlierAttempt()
    ui.pastes = [null]

    await run()

    expect(ui.keyPrompts).toHaveLength(1)
    expect(await validateCanary(earlier.record.wk, await serverCanary(), WS)).toBe(false)
    expect(await validateCanary((await storedKey()).wk, await serverCanary(), WS)).toBe(true)
  })

  it('keeps the earlier key while a flip sent under it could still commit', async () => {
    const earlier = await earlierAttempt()
    flipAttempts.markSent()
    clock += FLIP_SETTLED_MS - 1
    ui.pastes = [null, earlier.displayed]

    await run()

    expect(ui.savedKeyPrompts.map(prompt => prompt.canStartOver)).toEqual([false, false])
    expect(ui.keyPrompts).toEqual([])
    expect(await validateCanary(earlier.record.wk, await serverCanary(), WS)).toBe(true)
  })

  it('refuses rather than mint a second key when the key store cannot be read', async () => {
    await earlierAttempt()
    vi.spyOn(keyStore, 'get').mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    const put = vi.spyOn(keyStore, 'put')

    await expect(run()).rejects.toThrow('IndexedDB unavailable')
    expect(ui.keyPrompts).toEqual([])
    expect(put).not.toHaveBeenCalled()
    expect(flips()).toBe(0)
  })

  it('carries on past a flip that committed after its response was lost', async () => {
    server.loseNextFlipResponse = true

    expect(await run()).toMatchObject({kind: 'done'})
    expect(flips()).toBe(1)
    expect(await validateCanary((await storedKey()).wk, await serverCanary(), WS)).toBe(true)
    // Marked from the server's canary as each stage past the flip begins.
    expect(new Set(localCanaries)).toEqual(new Set([await serverCanary()]))
  })

  it('marks the local row from a flip whose response was lost, before anything else can end the run', async () => {
    server.loseNextFlipResponse = true
    const read = server.conversionState.bind(server)
    let reads = 0
    // The start, then the read that finds the flip landed; the next one fails.
    vi.spyOn(server, 'conversionState').mockImplementation(async ws =>
      ++reads > 2 ? {kind: 'unavailable', error: new Error('offline')} : read(ws))

    expect(await run()).toMatchObject({kind: 'blocked', read: {kind: 'unavailable'}})
    expect(localCanaries).toEqual([await read(WS).then(r => (r.kind === 'read' ? r.state.wkCanary : null))])
  })

  it('treats a not-plaintext refusal as a late flip when the server has moved on', async () => {
    const earlier = await earlierAttempt()
    ui.pastes = [earlier.displayed]
    // The earlier attempt's flip commits between this run's stage read and its own flip.
    const flip = server.convertWorkspaceToE2ee.bind(server)
    server.convertWorkspaceToE2ee = async (workspaceId, canary) => {
      if (flips() === 0) server.flip(WS, earlier.canary)
      return flip(workspaceId, canary)
    }

    expect(await run()).toMatchObject({kind: 'done'})
    expect(await serverCanary()).toBe(earlier.canary)
  })

  it('reports a refusal it can\'t follow up as blocked, not as refused', async () => {
    server.flip(WS, (await mintWorkspaceKey(WS)).canary)
    const reads = vi.spyOn(server, 'conversionState')
    reads.mockResolvedValueOnce(PLAINTEXT_READ)
    reads.mockResolvedValue({kind: 'unavailable', error: new Error('offline')})

    expect(await run()).toEqual({kind: 'blocked', read: {kind: 'unavailable'}})
  })

  it('marks the local row as soon as the flip returns, before re-reading the server', async () => {
    const reads = vi.spyOn(server, 'conversionState')
    reads.mockResolvedValueOnce(PLAINTEXT_READ)
    reads.mockResolvedValue({kind: 'unavailable', error: new Error('offline')})

    expect(await run()).toEqual({kind: 'blocked', read: {kind: 'unavailable'}})
    reads.mockRestore()
    expect(localCanaries).toEqual([await serverCanary()])
  })

  it('refuses to fall back to preflight when a read after the flip lags behind it', async () => {
    vi.spyOn(server, 'conversionState').mockResolvedValueOnce(PLAINTEXT_READ).mockResolvedValueOnce(PLAINTEXT_READ)

    expect(await run()).toEqual({kind: 'stage-moved-back', reached: 'sealing', shown: {kind: 'plaintext'}})
    expect(ui.preflights).toHaveLength(1)
    expect(flips()).toBe(1)
  })

  it('checks the upload queue again right before the flip', async () => {
    let checks = 0
    // An upload lands while the user saves the key.
    const uploadQueue = async () => ({pending: ++checks > 1 ? 2 : 0, rejected: 0})

    expect(await run({preflight: passingEnvironment({uploadQueue})}))
      .toEqual({kind: 'preflight-failed', blockers: [{kind: 'pending-uploads', count: 2}]})
    expect(ui.keyPrompts).toHaveLength(1)
    expect(flips()).toBe(0)
  })

  it('checks the upload queue again before a retry after a lock refusal', async () => {
    server.writesInFlight = 1
    let checks = 0
    // Preflight and the first send see an empty queue; an upload lands during the backoff.
    const uploadQueue = async () => ({pending: ++checks > 2 ? 1 : 0, rejected: 0})

    expect(await run({preflight: passingEnvironment({uploadQueue})}))
      .toEqual({kind: 'preflight-failed', blockers: [{kind: 'pending-uploads', count: 1}]})
    // The refused send changed nothing; no second one went out.
    expect(flips()).toBe(1)
    expect(await server.conversionState(WS)).toMatchObject({kind: 'read', state: {encryptionMode: 'none'}})
  })

  it('sends no flip once Stop lands during the check before it', async () => {
    const stop = new AbortController()
    let checks = 0
    // The second check is the one right before the send.
    const uploadQueue = async () => {
      if (++checks > 1) stop.abort(new DOMException('stopped', 'AbortError'))
      return {pending: 0, rejected: 0}
    }

    await expect(run({signal: stop.signal, preflight: passingEnvironment({uploadQueue})})).rejects.toThrow('stopped')
    expect(flips()).toBe(0)
  })

  it('refuses before showing a key this device could not keep', async () => {
    vi.spyOn(keyStore, 'put').mockRejectedValue(new Error('QuotaExceededError'))

    await expect(run()).rejects.toThrow('QuotaExceededError')
    expect(ui.keyPrompts).toEqual([])
    expect(flips()).toBe(0)
  })

  it('refuses to flip when the stored key does not read back', async () => {
    const put = keyStore.put.bind(keyStore)
    // Takes the probe, then loses the workspace's key.
    vi.spyOn(keyStore, 'put').mockImplementation(async (userId, workspaceId, record) => {
      if (workspaceId !== WS) await put(userId, workspaceId, record)
    })

    await expect(run()).rejects.toThrow(/did not read back/)
    expect(flips()).toBe(0)
  })

  it('retries the flip while writes are in flight, reporting each wait and each send', async () => {
    server.writesInFlight = 3
    const sleeps: number[] = []

    await run({flipTiming: {sleep: async ms => void sleeps.push(ms), random: () => 1}})

    expect(flips()).toBe(4)
    expect(sleeps).toEqual([500, 1000, 2000])
    expect(ui.statuses.filter(status => status.kind === 'flipping')).toEqual([
      {kind: 'flipping', waiting: null},
      {kind: 'flipping', waiting: {attempt: 1, retryInMs: 500}},
      {kind: 'flipping', waiting: null},
      {kind: 'flipping', waiting: {attempt: 2, retryInMs: 1000}},
      {kind: 'flipping', waiting: null},
      {kind: 'flipping', waiting: {attempt: 3, retryInMs: 2000}},
      {kind: 'flipping', waiting: null},
    ])
    expect(flipAttempts.sentRecently()).toBe(true)
  })

  it('stops a flip retrying once the run is cancelled', async () => {
    server.writesInFlight = Infinity
    const controller = new AbortController()

    const running = run({
      signal: controller.signal,
      flipTiming: {
        sleep: async (_ms, signal) => {
          controller.abort()
          signal?.throwIfAborted()
        },
        random: () => 0,
      },
    })

    await expect(running).rejects.toThrow()
    expect(flips()).toBe(1)
  })

  it('reports a refused flip and changes nothing', async () => {
    // As a stale ownership would: everything before the flip passes, and the
    // flip itself refuses.
    server.convertWorkspaceToE2ee = async () => {
      throw Object.assign(new Error('convert_workspace_to_e2ee: only the workspace owner can convert it'), {code: 'KMC01'})
    }
    expect(await run()).toEqual({kind: 'flip-refused', message: 'convert_workspace_to_e2ee: only the workspace owner can convert it'})
    expect(await server.conversionState(WS)).toMatchObject({state: {encryptionMode: 'none', conversionPhase: null}})
    expect(localCanaries).toEqual([])
  })
})

describe('runConversion: preflight', () => {
  const blockers = async (overrides: Partial<ConversionFlowDeps>) => {
    const result = await run(overrides)
    expect(ui.keyPrompts).toEqual([])
    expect(flips()).toBe(0)
    if (result.kind !== 'preflight-failed') throw new Error(`expected a failed preflight, got ${result.kind}`)
    return result.blockers
  }

  it('refuses a plaintext row the re-seal would count as sealed', async () => {
    const wk = await keyOf(9)
    server.insert({id: 'looks-sealed', workspace_id: WS, ...await sealFor(wk, {id: 'looks-sealed', workspace_id: WS}, {content: 'a', properties_json: '{}', references_json: '[]'})})
    server.insert({id: 'prefix-only', workspace_id: WS, content: 'enc:v1:', properties_json: 'enc:v1:', references_json: 'enc:v1:'})

    expect(await blockers({})).toEqual([{kind: 'sealed-looking-rows', blockIds: ['looks-sealed']}])
  })

  it('finds a sealed-looking row on a later page', async () => {
    server.maxRows = 2
    const wk = await keyOf(9)
    server.insert({id: 'z-sealed', workspace_id: WS, ...await sealFor(wk, {id: 'z-sealed', workspace_id: WS}, {content: 'a', properties_json: '{}', references_json: '[]'})})

    expect(await blockers({})).toEqual([{kind: 'sealed-looking-rows', blockIds: ['z-sealed']}])
  })

  it('refuses on this device\'s own blockers before reading the workspace from the server', async () => {
    expect(await blockers({preflight: passingEnvironment({supportsDirectoryPicker: false})})).toEqual([{kind: 'no-directory-picker'}])
    expect(server.calls.filter(call => call.method === 'readFullBlockPage' || call.method === 'readHistoryPage')).toEqual([])
  })

  it('refuses while uploads are pending or rejected, or storage would not last', async () => {
    expect(await blockers({
      preflight: passingEnvironment({
        uploadQueue: async () => ({pending: 4, rejected: 1}),
        canPersistPins: () => false,
        keyStoreIsDurable: false,
        supportsDirectoryPicker: false,
      }),
    })).toEqual([
      {kind: 'pins-not-durable'},
      {kind: 'key-store-not-durable'},
      {kind: 'no-directory-picker'},
      {kind: 'pending-uploads', count: 4},
      {kind: 'rejected-uploads', count: 1},
    ])
  })

  it('refuses while attachment uploads are unconfirmed, before downloading any attachment', async () => {
    storage.pendingUploads = 3
    await seedMedia(server, storage, {id: 'photo', bytes: new Uint8Array([1, 2, 3]), at: {remote: true}})
    const reads = vi.spyOn(storage.io, 'readObject')

    expect(await blockers({})).toEqual([{kind: 'pending-attachment-uploads', count: 3}])
    expect(reads).not.toHaveBeenCalled()
  })

  it('checks attachment uploads again right before the flip', async () => {
    let checks = 0
    vi.spyOn(storage.io, 'pendingUploads').mockImplementation(async () => (++checks > 1 ? 1 : 0))

    expect(await run()).toEqual({kind: 'preflight-failed', blockers: [{kind: 'pending-attachment-uploads', count: 1}]})
    expect(ui.keyPrompts).toHaveLength(1)
    expect(flips()).toBe(0)
  })

  it('refuses when this device has no room to keep the attachments only Storage holds, saying how much', async () => {
    const big = new Uint8Array(3000)
    await seedMedia(server, storage, {id: 'kept', bytes: new Uint8Array(1000), at: {remote: true}})
    await seedMedia(server, storage, {id: 'big', bytes: big, at: {remote: true}})
    // Room for the first, after the database's headroom.
    const freeLocalBytes = async () => 512 * 1024 * 1024 + 2000

    expect(await blockers({preflight: passingEnvironment({freeLocalBytes})}))
      // 1000 left after the first; the second needs only what it lacks.
      .toEqual([{kind: 'local-space', neededBytes: big.length - 1000, freeBytes: 1000}])
  })

  it('reports the attachment survey as it goes', async () => {
    await seedMedia(server, storage, {id: 'a', bytes: new Uint8Array([1]), at: {remote: true}})
    storage.objects.set('stray', new Uint8Array([2]))
    ui.confirmPreflight = async () => {
      throw new DOMException('cancelled', 'AbortError')
    }

    await expect(run()).rejects.toThrow('cancelled')
    expect(ui.statuses.filter(status => status.kind === 'preflight')).toEqual([
      {kind: 'preflight', progress: null},
      {kind: 'preflight', progress: {checked: 1, total: 2}},
      {kind: 'preflight', progress: {checked: 2, total: 2}},
    ])
  })

  it('lists media with no verified copy with the blocks that carry it, and keeps a Storage-only copy here', async () => {
    const remoteOnly = new Uint8Array([1, 2, 3])
    const kept = await seedMedia(server, storage, {id: 'kept', bytes: remoteOnly, at: {remote: true}})
    const lost = await seedMedia(server, storage, {id: 'lost', bytes: new Uint8Array([4, 5]), at: {}})
    server.insert({id: 'lost-too', workspace_id: WS, properties_json: mediaPropertiesJson(lost)})
    // Storage holds other bytes under the lost one's name.
    storage.objects.set(rawNameOf(lost), new Uint8Array([6]))
    storage.objects.set('stray', new Uint8Array(10))
    ui.confirmPreflight = async report => {
      ui.preflights.push(report)
      throw new DOMException('cancelled', 'AbortError')
    }

    await expect(run()).rejects.toThrow('cancelled')
    expect(ui.preflights[0]).toMatchObject({
      noVerifiedSource: [{contentHash: lost, blockIds: ['lost', 'lost-too']}],
      oversized: [],
      // The kept copy and the stray; the object at the lost hash's name is neither.
      sizes: {attachmentBytes: remoteOnly.length + 10},
    })
    expect(storage.local.get(rawNameOf(kept))).toEqual(remoteOnly)
    expect(storage.local.has(rawNameOf(lost))).toBe(false)
  })
})

describe('runConversion: every run', () => {
  it('refuses a second run while one holds the lock', async () => {
    const held = new Set<string>()
    // The Web Locks contract the flow relies on: `ifAvailable` answers null
    // rather than queueing behind the holder.
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, _options: {ifAvailable: boolean}, callback: (lock: object | null) => Promise<unknown>) => {
          if (held.has(name)) return callback(null)
          held.add(name)
          try {
            return await callback({name})
          } finally {
            held.delete(name)
          }
        },
      },
    })
    try {
      const lock = webConversionLock()!
      let releaseFirst!: () => void
      ui.confirmContract = () => new Promise<void>(resolve => (releaseFirst = resolve))
      const first = run({lock})
      await vi.waitFor(() => expect(held.has(conversionLockName(USER, WS))).toBe(true))

      expect(await run({lock})).toEqual({kind: 'busy'})
      releaseFirst()
      expect(await first).toMatchObject({kind: 'done'})
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does nothing for a workspace this user does not own', async () => {
    server.ownerUserId = 'someone-else'

    expect(await run()).toEqual({kind: 'blocked', read: {kind: 'not-owner'}})
    expect(ui.contracts).toEqual([])
  })

  it('ends with nothing changed when the user cancels the contract check', async () => {
    ui.cancelContract = true

    await expect(run()).rejects.toThrow('cancelled')
    expect(flips()).toBe(0)
    expect(await keyStore.get(USER, WS)).toBeNull()
  })

  it('marks the local row past the flip even when the user cancels the contract check', async () => {
    const minted = await mintWorkspaceKey(WS)
    server.flip(WS, minted.canary)
    ui.cancelContract = true

    await expect(run()).rejects.toThrow('cancelled')
    expect(localCanaries).toEqual([minted.canary])
  })

  it('leaves the local row alone when a plaintext run is cancelled', async () => {
    ui.cancelContract = true

    await expect(run()).rejects.toThrow('cancelled')
    expect(localCanaries).toEqual([])
  })

  it('reports a finished conversion without asking anything, and marks the local row', async () => {
    const minted = await mintWorkspaceKey(WS)
    server.flip(WS, minted.canary)
    server.setPhase(WS, null)

    expect(await run()).toMatchObject({kind: 'done'})
    expect(ui.contracts).toEqual([])
    expect(localCanaries).toEqual([minted.canary])
  })

  it('resumes from the stage the server shows', async () => {
    const minted = await mintWorkspaceKey(WS)
    await keyStore.put(USER, WS, minted.record)
    server.flip(WS, minted.canary)
    server.setPhase(WS, 'cleaning')
    await bundles.put(USER, WS, emptyBundleRecord())

    expect(await run()).toMatchObject({kind: 'done'})
    expect(ui.contracts).toEqual(['cleaning'])
    expect(flips()).toBe(0)
  })
})

describe('runConversion: finishing', () => {
  beforeEach(async () => {
    const minted = await mintWorkspaceKey(WS)
    await keyStore.put(USER, WS, minted.record)
    server.flip(WS, minted.canary)
    server.setPhase(WS, 'cleaning')
    await bundles.put(USER, WS, emptyBundleRecord())
  })
  const finishes = () => server.calls.filter(call => call.method === 'finishConversion').length

  it('finishes, names the bundle folder, and forgets the bundle record', async () => {
    expect(await run()).toEqual({kind: 'done', bundleFolder: 'bundle'})
    expect(finishes()).toBe(1)
    expect(await bundles.get(USER, WS)).toBeNull()
  })

  it('takes a finish whose response was lost as done', async () => {
    const finish = server.finishConversion.bind(server)
    server.finishConversion = async workspaceId => {
      await finish(workspaceId)
      throw new Error('conversion: finish_conversion failed: the request timed out')
    }

    expect(await run()).toEqual({kind: 'done', bundleFolder: 'bundle'})
    expect(await bundles.get(USER, WS)).toBeNull()
  })

  it('reports a finish that failed with the conversion still unfinished', async () => {
    server.finishConversion = async () => {
      throw new Error('conversion: finish_conversion failed: the request timed out')
    }

    await expect(run()).rejects.toThrow('timed out')
    expect(await phaseOf()).toBe('cleaning')
    expect(await bundles.get(USER, WS)).not.toBeNull()
  })
})

const phaseOf = async () => {
  const read = await server.conversionState(WS)
  return read.kind === 'read' ? read.state.conversionPhase : null
}

describe('runConversion: the canary check past the flip', () => {
  let saved: Awaited<ReturnType<typeof mintWorkspaceKey>>

  beforeEach(async () => {
    saved = await mintWorkspaceKey(WS)
    server.flip(WS, saved.canary)
  })

  it('asks for the saved key when this device holds none, and stores it', async () => {
    ui.pastes = ['not a key', (await mintWorkspaceKey(WS)).displayed, saved.displayed]

    expect(await run()).toMatchObject({kind: 'done'})
    expect(ui.savedKeyPrompts).toEqual([
      {context: 'converting', problem: null, canStartOver: false},
      {context: 'converting', problem: 'format', canStartOver: false},
      {context: 'converting', problem: 'invalid-key', canStartOver: false},
    ])
    expect(await validateCanary((await storedKey()).wk, saved.canary, WS)).toBe(true)
    expect(new Set(localCanaries)).toEqual(new Set([saved.canary]))
  })

  it('says so when the key this device holds does not open the canary', async () => {
    await keyStore.put(USER, WS, (await mintWorkspaceKey(WS)).record)
    ui.pastes = [saved.displayed]

    await run()

    expect(ui.savedKeyPrompts.map(prompt => prompt.problem)).toEqual(['stored-key-wrong'])
  })
})
