import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryWorkspaceKeyStore } from '../keys/keyStore.js'
import { mintWorkspaceKey, type MintedWorkspaceKey } from '../keys/mintWorkspaceKey.js'
import type { BundleFolder } from './bundle/bundleParts.js'
import { InMemoryBundleRecordStore, type BundleRecord, type BundleRecordStore } from './bundle/bundleRecord.js'
import { BUNDLE_PARTS } from './bundle/manifest.js'
import { verifyBundle } from './bundle/verifyBundle.js'
import { runConversion, type ConversionFlowDeps, type ConversionUi } from './runConversion.js'
import { contentColumnsOf, isSealedRow } from './sealing.js'
import type { BundleRetakeReason } from './sealingStage.js'
import { openRow, seedPlaintext, WS } from './test/conversionFixtures.js'
import { fakeMediaHashOf } from './test/fakeAttachmentStorage.js'
import { FakeConversionServer, notSealedRefusal, type FakeBlockRow } from './test/fakeConversionServer.js'
import { flowDeps, USER } from './test/flowFixtures.js'
import { MemoryBundleFolder } from './test/memoryBundleFolder.js'

/** The user past the flip: confirms the contract, picks a folder when asked. */
class SealingUi implements ConversionUi {
  constructor(private readonly bundles: BundleRecordStore) {}
  readonly parent = new MemoryBundleFolder('picked')
  /** The bundle record as the finish prompt found it. */
  atFinish: BundleRecord | null = null
  readonly folderReasons: Array<BundleRetakeReason | null> = []
  reopened = 0
  readonly problems: Array<string | null> = []
  /** What the user hands back when asked for the folder again; by default the recorded one. */
  reopenWith: (recorded: BundleFolder) => BundleFolder | null = recorded => recorded
  async confirmContract() {}
  async confirmPreflight() {}
  async saveKey(): Promise<string> {
    throw new Error('no key is minted past the flip')
  }
  async enterSavedKey(): Promise<string> {
    throw new Error('this device holds the key')
  }
  async chooseBundleFolder({reason}: {reason: BundleRetakeReason | null}) {
    this.folderReasons.push(reason)
    return this.parent
  }
  async reopenBundleFolder({recorded, problem}: {recorded: BundleFolder; problem: string | null}) {
    this.reopened++
    this.problems.push(problem)
    return this.reopenWith(recorded)
  }
  async confirmNoVerifiedSource() {}
  async chooseExistingBundle(): Promise<BundleFolder> {
    throw new Error('this device took the bundle')
  }
  async confirmFinish() {
    this.atFinish = await this.bundles.get(USER, WS)
  }
  readonly statuses: string[] = []
  status(status: {kind: string}) {
    this.statuses.push(status.kind)
  }
}

let server: FakeConversionServer
let seeded: FakeBlockRow[]
let key: MintedWorkspaceKey
let keyStore: InMemoryWorkspaceKeyStore
let bundles: InMemoryBundleRecordStore
let ui: SealingUi
let upgraded: number

beforeEach(async () => {
  server = new FakeConversionServer()
  seeded = seedPlaintext(server, 5)
  key = await mintWorkspaceKey(WS)
  keyStore = new InMemoryWorkspaceKeyStore()
  await keyStore.put(USER, WS, key.record)
  server.flip(WS, key.canary)
  bundles = new InMemoryBundleRecordStore()
  ui = new SealingUi(bundles)
  upgraded = 0
})

const run = (overrides: Partial<ConversionFlowDeps> = {}) =>
  runConversion(flowDeps(server, ui, {
    keyStore,
    bundles,
    upgradePin: async () => {
      upgraded++
      return {ok: true}
    },
    ...overrides,
  }))

const phase = async () => {
  const read = await server.conversionState(WS)
  return read.kind === 'read' ? read.state.conversionPhase : null
}
const bundleFolders = () => [...ui.parent.folders.values()]
const record = () => bundles.get(USER, WS)
const patchCalls = () => server.calls.filter(call => call.method === 'applyBlockPatches').length

/** Fails the re-seal's second batch, as a crash would. */
const crashMidReseal = () => {
  let calls = 0
  server.beforePatch = () => {
    if (++calls === 2) throw new Error('crash mid re-seal')
  }
}

describe('the sealing stage', () => {
  it('takes and verifies a bundle, re-seals, verifies, purges, then upgrades the pin', async () => {
    const through = Math.max(...server.history(WS).map(row => row.event_id))

    expect(await run()).toMatchObject({kind: 'done'})

    expect(await phase()).toBeNull()
    expect(server.history(WS)).toEqual([])
    expect(server.workspaceRows(WS).every(isSealedRow)).toBe(true)
    for (const row of seeded) expect(await openRow(key.record.wk, server.row(row.id))).toEqual(contentColumnsOf(row))
    expect(ui.folderReasons).toEqual([null])
    expect(bundleFolders()).toHaveLength(1)
    // The read-back of the new bundle shows as its own step, before the re-seal.
    const steps = ui.statuses.filter((kind, i, all) => kind !== all[i - 1])
    expect(steps.slice(steps.indexOf('taking-bundle'), steps.indexOf('resealing') + 1)).toEqual(['taking-bundle', 'checking-bundle', 'resealing'])
    // The record outlives the purge, for the attachment cleaner, and goes once the conversion is done.
    expect(ui.atFinish).toMatchObject({through, historyRows: 5, blockRows: 5})
    const {manifestSha256} = await verifyBundle({folder: bundleFolders()[0], workspaceId: WS, mediaHashOf: fakeMediaHashOf})
    expect(ui.atFinish?.manifestSha256).toBe(manifestSha256)
    expect(await record()).toBeNull()
    expect(upgraded).toBe(1)
  })

  it('resumes a crashed re-seal under the bundle it already took', async () => {
    server.maxRows = 2
    crashMidReseal()
    await expect(run()).rejects.toThrow('crash mid re-seal')
    expect(await record()).not.toBeNull()
    server.beforePatch = undefined

    expect(server.workspaceRows(WS).filter(isSealedRow)).toHaveLength(2)

    expect(await run()).toMatchObject({kind: 'done'})
    expect(ui.folderReasons).toEqual([null])
    expect(bundleFolders()).toHaveLength(1)
  })

  it('never starts the re-seal without a verified bundle', async () => {
    const folder = new MemoryBundleFolder('truncating')
    const close = folder.getFileHandle.bind(folder)
    // The disk keeps only part of blocks.jsonl.
    folder.getFileHandle = async (name, options) => {
      const file = await close(name, options)
      if (name !== BUNDLE_PARTS.blocks) return file
      return {
        getFile: async () => {
          const bytes = folder.files.get(name)!
          return new Blob([bytes.slice(0, bytes.length - 10)])
        },
        createWritable: file.createWritable,
      }
    }
    ui.parent.getDirectoryHandle = async (_name, options) => {
      if (!options?.create) throw new DOMException('not found', 'NotFoundError')
      return folder
    }
    const removed: string[] = []
    ui.parent.removeEntry = async name => void removed.push(name)

    await expect(run()).rejects.toThrow(/doesn't check out/)
    expect(await record()).toBeNull()
    expect(patchCalls()).toBe(0)
    // The half-written plaintext copy is not left behind.
    expect(removed).toEqual([folder.name])
  })

  it('re-takes a bundle edited during the re-seal, and the new one holds plaintext for rows already sealed', async () => {
    server.afterPatch = () => {
      const [folder] = bundleFolders()
      folder.setText(BUNDLE_PARTS.blocks, folder.text(BUNDLE_PARTS.blocks).replace('text 0', 'edited'))
    }

    expect(await run()).toMatchObject({kind: 'done'})

    expect(ui.folderReasons).toEqual([null, 'changed'])
    // The server is as the first pass left it, so the re-seal and verify don't run again.
    expect(server.calls.filter(call => call.method === 'readBlockPage')).toHaveLength(4)
    const retaken = bundleFolders()[1]
    expect(retaken.text(BUNDLE_PARTS.blocks).split('\n').filter(Boolean).map(line => contentColumnsOf(JSON.parse(line))))
      .toEqual(seeded.map(contentColumnsOf))
    expect(ui.atFinish?.manifestSha256).toBe((await verifyBundle({folder: retaken, workspaceId: WS, mediaHashOf: fakeMediaHashOf})).manifestSha256)
  })

  it('asks for the folder again when this device lost access to it', async () => {
    let calls = 0
    await run({canReadFolder: async () => ++calls > 1})

    expect(ui.reopened).toBe(1)
    expect(await phase()).toBeNull()
  })

  it('records the folder the user picks when the bundle has moved', async () => {
    let moved: MemoryBundleFolder | null = null
    ui.reopenBundleFolder = async ({recorded}) => {
      moved ??= (recorded as MemoryBundleFolder).copy('moved')
      return moved
    }

    await run({canReadFolder: async folder => folder === moved})

    expect(ui.atFinish?.folder).toBe(moved)
  })

  /** The recorded folder, gone: moved, deleted, or on a drive that was unplugged. */
  const loseRecordedFolder = () => {
    server.afterPatch = () => {
      const [folder] = bundleFolders()
      folder.getFileHandle = async () => {
        throw new DOMException('gone', 'NotFoundError')
      }
    }
  }

  it('asks for a folder it can no longer read rather than drop the bundle', async () => {
    let moved: MemoryBundleFolder | null = null
    loseRecordedFolder()
    ui.reopenWith = () => (moved ??= original!.copy())
    let original: MemoryBundleFolder | null = null
    server.beforePatch = () => { original ??= bundleFolders()[0].copy() }

    expect(await run()).toMatchObject({kind: 'done'})
    expect(ui.folderReasons).toEqual([null])
    expect(ui.problems).toEqual([expect.stringMatching(/can't be read/)])
    expect(ui.atFinish?.folder).toBe(moved)
  })

  it('asks again after a wrong pick, and finds the bundle inside the folder it was made in', async () => {
    loseRecordedFolder()
    let original: MemoryBundleFolder | null = null
    server.beforePatch = () => { original ??= bundleFolders()[0].copy() }
    const picks: BundleFolder[] = []
    ui.reopenWith = () => {
      // A regression that never finds the bundle stops here rather than looping.
      if (picks.length >= 3) return null
      // First an unrelated folder; then the parent the bundle was made in.
      const pick = picks.length === 0 ? new MemoryBundleFolder('elsewhere') : (() => {
        const parent = new MemoryBundleFolder('picked-again')
        parent.folders.set(original!.name, original!)
        return parent
      })()
      picks.push(pick)
      return pick
    }

    expect(await run()).toMatchObject({kind: 'done'})
    expect(ui.reopened).toBe(2)
    expect(ui.atFinish?.folder).toBe(original)
  })

  it('takes a new bundle when the user asks for one', async () => {
    ui.reopenWith = () => null
    let checks = 0

    await run({canReadFolder: async () => ++checks > 1})

    expect(ui.folderReasons).toEqual([null, 'requested'])
  })

  it('takes a new bundle when a part no longer decodes', async () => {
    server.afterPatch = () => {
      const [folder] = bundleFolders()
      const bytes = folder.files.get(BUNDLE_PARTS.blocks)!.slice()
      bytes[10] = 0xff
      folder.files.set(BUNDLE_PARTS.blocks, bytes)
    }

    expect(await run()).toMatchObject({kind: 'done'})
    expect(ui.folderReasons).toEqual([null, 'changed'])
  })

  it('counts a pass as stuck only while the server still shows sealing', async () => {
    const purge = server.purgeWorkspaceHistory.bind(server)
    let calls = 0
    server.purgeWorkspaceHistory = async (...args) => {
      calls++
      // Two refusals, then a purge that lands with its response lost.
      if (calls <= 2) throw notSealedRefusal()
      await purge(...args)
      throw new Error('conversion: purge_workspace_history failed: the request timed out')
    }

    // The retry of the lost one meets the phase already moved on.
    expect(await run()).toMatchObject({kind: 'done'})
  })

  it('re-seals and retries under the same bundle after a not-sealed refusal', async () => {
    const purge = server.purgeWorkspaceHistory.bind(server)
    let refusals = 1
    server.purgeWorkspaceHistory = async (...args) => {
      if (refusals-- > 0) {
        throw notSealedRefusal()
      }
      return purge(...args)
    }

    expect(await run()).toMatchObject({kind: 'done'})
    expect(ui.folderReasons).toEqual([null])
  })

  it('re-takes the bundle when the purge finds history it lacks', async () => {
    const purge = server.purgeWorkspaceHistory.bind(server)
    let wrote = false
    // Another client's write lands after the bundle: history the bundle lacks.
    server.purgeWorkspaceHistory = async (...args) => {
      if (!wrote) {
        wrote = true
        server.write(seeded[0].id, {deleted: true})
      }
      return purge(...args)
    }

    expect(await run()).toMatchObject({kind: 'done'})
    expect(ui.folderReasons).toEqual([null, 'stale'])
    // Something wrote the workspace, so the second pass re-seals and verifies again.
    expect(server.calls.filter(call => call.method === 'readBlockPage')).toHaveLength(8)
  })

  it('stops after repeated refusals rather than retry for ever', async () => {
    server.purgeWorkspaceHistory = async () => {
      throw notSealedRefusal()
    }

    expect(await run()).toMatchObject({kind: 'sealing-stuck', pass: {kind: 'purge-refused'}})
    expect(await phase()).toBe('sealing')
    expect(await record()).not.toBeNull()
  })

  it('carries on past a purge whose response was lost', async () => {
    const purge = server.purgeWorkspaceHistory.bind(server)
    let lost = false
    server.purgeWorkspaceHistory = async (...args) => {
      await purge(...args)
      if (!lost) {
        lost = true
        throw new Error('conversion: purge_workspace_history failed: the request timed out')
      }
    }

    expect(await run()).toMatchObject({kind: 'done'})
    expect(upgraded).toBe(1)
  })

  it('resumes after the purge at the pin upgrade', async () => {
    const purge = server.purgeWorkspaceHistory.bind(server)
    server.purgeWorkspaceHistory = async (...args) => {
      await purge(...args)
      throw new Error('crash right after the purge')
    }
    // The retry sees the phase moved on; this run's own upgrade then crashes.
    await expect(run({upgradePin: async () => { throw new Error('crash before the pin upgrade') }})).rejects.toThrow('crash before the pin upgrade')

    expect(await run()).toMatchObject({kind: 'done'})
    expect(upgraded).toBe(1)
  })

  it('reports a pin upgrade the server refuses', async () => {
    const result = await run({upgradePin: async () => ({ok: false, reason: 'refused', entry: {kind: 'unavailable'}})})

    expect(result).toEqual({kind: 'pin-upgrade-failed', result: {ok: false, reason: 'refused', entry: {kind: 'unavailable'}}})
  })

  it('keeps the screen awake for the whole pass, and lets it sleep after', async () => {
    const awake: string[] = []
    const keepAwake = vi.fn(async () => {
      awake.push('on')
      return () => void awake.push('off')
    })
    ui.chooseBundleFolder = async ({reason}) => {
      awake.push('bundle')
      ui.folderReasons.push(reason)
      return ui.parent
    }

    await run({keepAwake})

    // Then again for the attachment cleanup.
    expect(awake).toEqual(['on', 'bundle', 'off', 'on', 'off'])
  })
})
