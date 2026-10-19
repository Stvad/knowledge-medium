import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryWorkspaceKeyStore } from '../keys/keyStore.js'
import { mintWorkspaceKey, type MintedWorkspaceKey } from '../keys/mintWorkspaceKey.js'
import type { BundleFolder } from './bundle/bundleParts.js'
import { InMemoryBundleRecordStore } from './bundle/bundleRecord.js'
import { BUNDLE_PARTS } from './bundle/manifest.js'
import { verifyBundle } from './bundle/verifyBundle.js'
import { ConversionErrorCode } from './conversionServer.js'
import { runConversion, type ConversionFlowDeps, type ConversionUi } from './runConversion.js'
import { contentColumnsOf, isSealedRow } from './sealing.js'
import type { BundleRetakeReason } from './sealingStage.js'
import { openRow, seedPlaintext, WS } from './test/conversionFixtures.js'
import { FakeConversionServer, type FakeBlockRow } from './test/fakeConversionServer.js'
import { flowDeps, USER } from './test/flowFixtures.js'
import { MemoryBundleFolder } from './test/memoryBundleFolder.js'

/** The user past the flip: confirms the contract, picks a folder when asked. */
class SealingUi implements ConversionUi {
  readonly parent = new MemoryBundleFolder('picked')
  readonly folderReasons: Array<BundleRetakeReason | null> = []
  reopened = 0
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
  async reopenBundleFolder({recorded}: {recorded: BundleFolder}) {
    this.reopened++
    return recorded
  }
  status() {}
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
  ui = new SealingUi()
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

    expect(await run()).toEqual({kind: 'stopped', stage: {kind: 'cleaning', canary: key.canary}})

    expect(await phase()).toBe('cleaning')
    expect(server.history(WS)).toEqual([])
    expect(server.workspaceRows(WS).every(isSealedRow)).toBe(true)
    for (const row of seeded) expect(await openRow(key.record.wk, server.row(row.id))).toEqual(contentColumnsOf(row))
    expect(ui.folderReasons).toEqual([null])
    expect(bundleFolders()).toHaveLength(1)
    // The record stays after the purge: the attachment cleaner reads the bundle through it.
    expect(await record()).toMatchObject({through, historyRows: 5, blockRows: 5})
    const {manifestSha256} = await verifyBundle({folder: bundleFolders()[0], workspaceId: WS})
    expect((await record())?.manifestSha256).toBe(manifestSha256)
    expect(upgraded).toBe(1)
  })

  it('resumes a crashed re-seal under the bundle it already took', async () => {
    server.maxRows = 2
    crashMidReseal()
    await expect(run()).rejects.toThrow('crash mid re-seal')
    expect(await record()).not.toBeNull()
    server.beforePatch = undefined

    expect(server.workspaceRows(WS).filter(isSealedRow)).toHaveLength(2)

    expect(await run()).toMatchObject({kind: 'stopped', stage: {kind: 'cleaning'}})
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

    await expect(run()).rejects.toThrow(/doesn't check out/)
    expect(await record()).toBeNull()
    expect(patchCalls()).toBe(0)
  })

  it('re-takes a bundle edited during the re-seal, and the new one holds plaintext for rows already sealed', async () => {
    server.afterPatch = () => {
      const [folder] = bundleFolders()
      folder.setText(BUNDLE_PARTS.blocks, folder.text(BUNDLE_PARTS.blocks).replace('text 0', 'edited'))
    }

    expect(await run()).toMatchObject({kind: 'stopped', stage: {kind: 'cleaning'}})

    expect(ui.folderReasons).toEqual([null, 'changed'])
    const retaken = bundleFolders()[1]
    expect(retaken.text(BUNDLE_PARTS.blocks).split('\n').filter(Boolean).map(line => contentColumnsOf(JSON.parse(line))))
      .toEqual(seeded.map(contentColumnsOf))
    expect((await record())?.manifestSha256).toBe((await verifyBundle({folder: retaken, workspaceId: WS})).manifestSha256)
  })

  it('asks for the folder again when this device lost access to it', async () => {
    let calls = 0
    await run({canReadFolder: async () => ++calls > 1})

    expect(ui.reopened).toBe(1)
    expect(await phase()).toBe('cleaning')
  })

  it('records the folder the user picks when the bundle has moved', async () => {
    const moved = new MemoryBundleFolder('moved')
    ui.reopenBundleFolder = async ({recorded}) => {
      for (const [name, bytes] of (recorded as MemoryBundleFolder).files) moved.files.set(name, bytes)
      return moved
    }

    await run({canReadFolder: async folder => folder === moved})

    expect((await record())?.folder).toBe(moved)
  })

  it('re-seals and retries under the same bundle after a not-sealed refusal', async () => {
    const purge = server.purgeWorkspaceHistory.bind(server)
    let refusals = 1
    server.purgeWorkspaceHistory = async (...args) => {
      if (refusals-- > 0) {
        throw Object.assign(new Error('purge_workspace_history: a block row of the workspace is not fully sealed'), {code: ConversionErrorCode.refused})
      }
      return purge(...args)
    }

    expect(await run()).toMatchObject({kind: 'stopped', stage: {kind: 'cleaning'}})
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

    expect(await run()).toMatchObject({kind: 'stopped', stage: {kind: 'cleaning'}})
    expect(ui.folderReasons).toEqual([null, 'stale'])
  })

  it('stops after repeated refusals rather than retry for ever', async () => {
    server.purgeWorkspaceHistory = async () => {
      throw Object.assign(new Error('purge_workspace_history: a block row of the workspace is not fully sealed'), {code: ConversionErrorCode.refused})
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

    expect(await run()).toMatchObject({kind: 'stopped', stage: {kind: 'cleaning'}})
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

    expect(await run()).toEqual({kind: 'stopped', stage: {kind: 'cleaning', canary: key.canary}})
    expect(upgraded).toBe(1)
  })

  it('reports a pin upgrade the server refuses', async () => {
    const result = await run({upgradePin: async () => ({ok: false, reason: 'refused', entry: {kind: 'unavailable'}})})

    expect(result).toEqual({kind: 'pin-upgrade-failed', result: {ok: false, reason: 'refused', entry: {kind: 'unavailable'}}})
  })

  it('keeps the screen awake for the re-seal and the verify only', async () => {
    const release = vi.fn()
    const keepAwake = vi.fn(async () => release)

    await run({keepAwake})

    expect(keepAwake).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
