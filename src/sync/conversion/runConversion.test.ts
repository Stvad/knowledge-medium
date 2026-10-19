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
import { keyOf, sealFor, seedPlaintext, WS } from './test/conversionFixtures.js'
import { FakeConversionServer } from './test/fakeConversionServer.js'
import { flowDeps, passingEnvironment, USER } from './test/flowFixtures.js'
import { MemoryBundleFolder } from './test/memoryBundleFolder.js'
import type { BundleFolder } from './bundle/bundleParts.js'
import type { BundleRetakeReason } from './sealingStage.js'

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
  readonly bundleReasons: Array<BundleRetakeReason | null> = []

  async chooseBundleFolder({reason}: {reason: BundleRetakeReason | null}) {
    this.bundleReasons.push(reason)
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

beforeEach(() => {
  server = new FakeConversionServer()
  seedPlaintext(server, 3)
  keyStore = new InMemoryWorkspaceKeyStore()
  clock = 1_000_000
  flipAttempts = new InMemoryFlipAttempts(() => clock)
  ui = new ScriptedUi()
  localCanaries = []
})

const run = (overrides: Partial<ConversionFlowDeps> = {}) =>
  runConversion(flowDeps(server, ui, {
    keyStore,
    flipAttempts,
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

    // Past the flip the stage runs on through the bundle, re-seal and purge.
    expect(result).toEqual({kind: 'stopped', stage: {kind: 'cleaning', canary: await serverCanary()}})
    expect(ui.contracts).toEqual(['plaintext'])
    // The dry run measures what the bundle then writes.
    const [bundle] = [...ui.bundleParent.folders.values()]
    const manifest = JSON.parse(bundle.text('manifest.json'))
    expect(ui.preflights).toEqual([{
      blockers: [],
      sizes: {
        blockRows: 3,
        blocksBytes: manifest.parts['blocks.jsonl'].bytes,
        historyRows: 3,
        historyBytes: manifest.parts['server-history.jsonl'].bytes,
        localDbBytes: 16,
        contentBytes: expect.any(Number),
      },
    }])
    expect(ui.keyPrompts).toHaveLength(1)
    expect(await validateCanary((await storedKey()).wk, await serverCanary(), WS)).toBe(true)
    expect(localCanaries[0]).toBe(await serverCanary())
    // The sealing stage's canary check needed no paste: this device holds the key.
    expect(ui.savedKeyPrompts).toEqual([])
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

    expect(await run()).toMatchObject({kind: 'stopped', stage: {kind: 'cleaning'}})
    expect(flips()).toBe(1)
    expect(await validateCanary((await storedKey()).wk, await serverCanary(), WS)).toBe(true)
    // Marked from the server's canary as each stage past the flip begins.
    expect(new Set(localCanaries)).toEqual(new Set([await serverCanary()]))
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

    expect(await run()).toMatchObject({kind: 'stopped', stage: {kind: 'cleaning', canary: earlier.canary}})
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
    server.sessionUserId = 'someone-else'
    // The stage read says owner, as a stale membership might; the flip itself refuses.
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
    return result.report.blockers
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
      expect(await first).toMatchObject({kind: 'stopped'})
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

  it('reports a finished conversion without asking anything', async () => {
    server.flip(WS, (await mintWorkspaceKey(WS)).canary)
    server.setPhase(WS, null)

    expect(await run()).toEqual({kind: 'done'})
    expect(ui.contracts).toEqual([])
  })

  it('resumes from the stage the server shows', async () => {
    const minted = await mintWorkspaceKey(WS)
    await keyStore.put(USER, WS, minted.record)
    server.flip(WS, minted.canary)
    server.setPhase(WS, 'cleaning')

    expect(await run()).toEqual({kind: 'stopped', stage: {kind: 'cleaning', canary: minted.canary}})
    expect(ui.contracts).toEqual(['cleaning'])
    expect(flips()).toBe(0)
  })
})

describe('runConversion: the canary check past the flip', () => {
  let saved: Awaited<ReturnType<typeof mintWorkspaceKey>>

  beforeEach(async () => {
    saved = await mintWorkspaceKey(WS)
    server.flip(WS, saved.canary)
  })

  it('asks for the saved key when this device holds none, and stores it', async () => {
    ui.pastes = ['not a key', (await mintWorkspaceKey(WS)).displayed, saved.displayed]

    expect(await run()).toMatchObject({kind: 'stopped', stage: {kind: 'cleaning'}})
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
