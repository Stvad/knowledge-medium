import { beforeEach, describe, expect, it } from 'vitest'
import { mintWorkspaceKey, type MintedWorkspaceKey } from '../keys/mintWorkspaceKey.js'
import { attachmentCleanerLockName } from './attachmentCleaner.js'
import { rawNameOf } from './bundle/attachmentParts.js'
import { sha256Hex, type BundleFolder } from './bundle/bundleParts.js'
import { bundleRecordOf, InMemoryBundleRecordStore, type BundleRecord } from './bundle/bundleRecord.js'
import { takeBundle } from './bundle/takeBundle.js'
import { verifyBundle } from './bundle/verifyBundle.js'
import {
  conversionBundleOf,
  runCleaningPass,
  type CleaningDeps,
  type CleaningPass,
  type FinishPrompt,
} from './cleaningStage.js'
import { seedMedia, seedPlaintext, WS } from './test/conversionFixtures.js'
import { createFakeAttachmentStorage, fakeMediaHashOf, type FakeAttachmentStorage } from './test/fakeAttachmentStorage.js'
import { FakeConversionServer } from './test/fakeConversionServer.js'
import { freeLock, USER, writeFakeLocalDb } from './test/flowFixtures.js'
import { MemoryBundleFolder } from './test/memoryBundleFolder.js'

const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)
const utf8Hex = (text: string): string => sha256Hex(bytesOf(text))
const PROBLEM = 'The recovery bundle folder could not be read.'

let server: FakeConversionServer
let storage: FakeAttachmentStorage
let minted: MintedWorkspaceKey
let folder: MemoryBundleFolder
let record: BundleRecord
let bundles: InMemoryBundleRecordStore
let rawHash: string
let localHash: string
let lostHash: string

/** What the scripted UI was asked, in order. */
let events: string[]
let finishPrompts: FinishPrompt[]
let reopenPrompts: Array<{problem: string | null; purpose: string; recorded: BundleFolder}>
let choosePrompts: Array<string | null>
let chooseAnswers: BundleFolder[]
let reopenAnswers: Array<BundleFolder | null>
let confirmFinish: () => Promise<void>
let canRead: (folder: BundleFolder) => Promise<boolean>
let lock: CleaningDeps['lock']
let awake: {held: number; released: number}

const deps = (overrides: Partial<CleaningDeps> = {}): CleaningDeps => ({
  userId: USER,
  workspaceId: WS,
  server,
  bundles,
  attachments: storage.io,
  canReadFolder: folder => canRead(folder),
  keepAwake: async () => {
    awake.held++
    events.push('awake')
    return () => {
      awake.released++
      events.push('release')
    }
  },
  lock: (name, run) => lock(name, run),
  ui: {
    status: () => {},
    chooseExistingBundle: async ({problem}) => {
      events.push('choose')
      choosePrompts.push(problem)
      const answer = chooseAnswers.shift()
      if (!answer) throw new Error('unscripted chooseExistingBundle')
      return answer
    },
    reopenBundleFolder: async prompt => {
      events.push('reopen')
      reopenPrompts.push({problem: prompt.problem, purpose: prompt.purpose, recorded: prompt.recorded})
      if (reopenAnswers.length === 0) throw new Error('unscripted reopenBundleFolder')
      return reopenAnswers.shift() ?? null
    },
    confirmFinish: async prompt => {
      events.push('confirmFinish')
      finishPrompts.push(prompt)
      await confirmFinish()
    },
  },
  ...overrides,
})

const run = (overrides: Partial<CleaningDeps> = {}): Promise<CleaningPass> =>
  runCleaningPass(deps(overrides), minted.record, minted.canary)

beforeEach(async () => {
  server = new FakeConversionServer()
  storage = createFakeAttachmentStorage()
  minted = await mintWorkspaceKey(WS)
  bundles = new InMemoryBundleRecordStore()
  events = []
  finishPrompts = []
  reopenPrompts = []
  choosePrompts = []
  chooseAnswers = []
  reopenAnswers = []
  confirmFinish = async () => {}
  canRead = async () => true
  lock = freeLock
  awake = {held: 0, released: 0}

  seedPlaintext(server, 3)
  rawHash = await seedMedia(server, storage, {id: 'm-raw', bytes: bytesOf('raw in storage'), at: {remote: true}})
  localHash = await seedMedia(server, storage, {id: 'm-local', bytes: bytesOf('only on device'), at: {local: true}})
  // Bytes exist nowhere: no local copy, no raw object, so no bundle entry.
  lostHash = await seedMedia(server, storage, {id: 'm-lost', bytes: bytesOf('nowhere'), at: {}})
  storage.objects.set('nested/thing', bytesOf('archived nested'))
  folder = new MemoryBundleFolder('bundle')
  server.flip(WS, minted.canary)
  await takeBundle({
    server,
    workspaceId: WS,
    folder,
    writeLocalDb: writeFakeLocalDb,
    pageSize: 2,
    now: () => new Date(0),
    attachments: {source: storage.io, confirmNoVerifiedSource: async () => {}},
  })
  record = bundleRecordOf(await verifyBundle({folder, workspaceId: WS, mediaHashOf: fakeMediaHashOf}), folder)
  server.setPhase(WS, 'cleaning')
})

const phaseOf = async () => {
  const read = await server.conversionState(WS)
  if (read.kind !== 'read') throw new Error('workspace not visible')
  return read.state.conversionPhase
}
const finishCalls = () => server.calls.filter(call => call.method === 'finishConversion').length

describe('runCleaningPass with this device\'s bundle record', () => {
  beforeEach(async () => {
    await bundles.put(USER, WS, record)
  })

  it('converts raw media, deletes the archived object, confirms, then finishes', async () => {
    storage.local.delete(rawNameOf(localHash)) // the bundle holds it; the cleaner must read it from there
    const pass = await run()

    expect(pass).toEqual({kind: 'finished'})
    expect(events.filter(e => e === 'confirmFinish' || e === 'choose' || e === 'reopen')).toEqual(['confirmFinish'])
    expect(finishPrompts).toEqual([{unrecoverable: [{contentHash: lostHash, blockIds: ['m-lost']}], left: [], refused: []}])
    // The raw name is gone, a keyed copy took its place for each media hash.
    expect(storage.objects.has(rawNameOf(rawHash))).toBe(false)
    expect(storage.objects.has(rawNameOf(localHash))).toBe(false)
    expect(storage.deletes).toContain(rawNameOf(rawHash))
    expect(storage.deletes).toContain('nested/thing')
    expect(storage.objects.has('nested/thing')).toBe(false)
    expect([...storage.objects.keys()]).toHaveLength(2)
    // The server's phase moved on, after the confirmation.
    expect((await phaseOf())).toBeNull()
    expect(finishCalls()).toBe(1)
  })

  it('asks the user before finishing, and a cancelled confirmation never finishes', async () => {
    confirmFinish = async () => { throw new Error('user cancelled') }

    await expect(run()).rejects.toThrow('user cancelled')

    expect(events.at(-1)).toBe('confirmFinish')
    expect(finishCalls()).toBe(0)
    expect((await phaseOf())).toBe('cleaning')
  })

  it('confirms before it finishes', async () => {
    const order: string[] = []
    confirmFinish = async () => { order.push(`confirm:${finishCalls()}`) }
    await run()
    order.push(`finish:${finishCalls()}`)
    expect(order).toEqual(['confirm:0', 'finish:1'])
  })

  it('shows an object left behind, which stays in Storage', async () => {
    // Uploaded after the bundle was taken: not archived.
    storage.objects.set('late/upload', bytesOf('arrived after the bundle'))

    expect(await run()).toEqual({kind: 'finished'})

    expect(finishPrompts[0].left).toEqual([{path: 'late/upload', reason: 'not-archived'}])
    expect(storage.objects.get('late/upload')).toEqual(bytesOf('arrived after the bundle'))
    expect(storage.deletes).not.toContain('late/upload')
  })

  it('does not delete an archived object whose bytes changed since the bundle', async () => {
    storage.objects.set('nested/thing', bytesOf('changed afterwards'))

    const pass = await run()

    // A kept archived object holds the proof back: nothing to confirm yet.
    expect(pass.kind).toBe('not-proved')
    if (pass.kind === 'not-proved') {
      expect(pass.report.left).toEqual([{path: 'nested/thing', reason: 'archive-mismatch'}])
      expect(pass.report.proof).toMatchObject({kind: 'not-passed', archivedRemaining: ['nested/thing']})
    }
    expect(storage.objects.get('nested/thing')).toEqual(bytesOf('changed afterwards'))
    expect(finishPrompts).toEqual([])
    expect(finishCalls()).toBe(0)
  })

  it('goes to a readable pick when the recorded folder is unreadable, and stores a descended-into folder', async () => {
    canRead = async f => f !== folder
    const parent = new MemoryBundleFolder('parent')
    parent.folders.set('bundle', folder)
    reopenAnswers = [parent]

    expect(await run()).toEqual({kind: 'finished'})

    expect(reopenPrompts).toEqual([{problem: null, purpose: 'cleanup', recorded: folder}])
    // The bundle's own folder inside the pick was used and recorded.
    expect((await bundles.get(USER, WS))?.folder).toBe(folder)
    expect(storage.objects.has('nested/thing')).toBe(false)
  })

  it('stores a picked folder that holds no subfolder of the recorded name, as picked', async () => {
    canRead = async f => f !== folder
    const moved = folder.copy('renamed')
    reopenAnswers = [moved]

    expect(await run()).toEqual({kind: 'finished'})

    expect((await bundles.get(USER, WS))?.folder).toBe(moved)
    expect(storage.objects.has('nested/thing')).toBe(false)
  })

  it('goes on without the bundle when the user declines, leaving what it archived', async () => {
    // The recorded folder still reads: declining must not read it anyway.
    canRead = async () => false
    reopenAnswers = [null]

    const pass = await run()

    expect(pass).toMatchObject({kind: 'not-proved', report: {left: [{path: 'nested/thing', reason: 'bundle-unreadable'}]}})
    expect(reopenPrompts).toHaveLength(1)
    expect(storage.objects.has('nested/thing')).toBe(true)
    expect((await bundles.get(USER, WS))?.folder).toBe(folder)
    expect(finishCalls()).toBe(0)
  })

  describe('when the bundle reads fail mid-pass', () => {
    const breakFolder = (target: MemoryBundleFolder) => {
      target.getDirectoryHandle = async () => { throw new DOMException('denied', 'NotAllowedError') }
    }
    let broken: MemoryBundleFolder
    beforeEach(async () => {
      broken = folder.copy('bundle')
      breakFolder(broken)
      await bundles.put(USER, WS, {...record, folder: broken})
    })

    it('re-asks with the problem message, and a readable answer lets it finish', async () => {
      reopenAnswers = [folder]

      expect(await run()).toEqual({kind: 'finished'})

      expect(reopenPrompts.map(p => p.problem)).toEqual([PROBLEM])
      expect(reopenPrompts[0].purpose).toBe('cleanup')
      expect(storage.objects.has('nested/thing')).toBe(false)
      expect(finishPrompts[0].left).toEqual([])
      expect((await bundles.get(USER, WS))?.folder).toBe(folder)
    })

    it('gives up with not-proved after two re-asks that stay unreadable', async () => {
      const again = folder.copy('bundle')
      breakFolder(again)
      const third = folder.copy('bundle')
      breakFolder(third)
      reopenAnswers = [again, third, folder] // the third answer must never be asked for

      const pass = await run()

      expect(pass.kind).toBe('not-proved')
      expect(reopenPrompts.map(p => p.problem)).toEqual([PROBLEM, PROBLEM])
      expect(reopenAnswers).toEqual([folder])
      if (pass.kind === 'not-proved') {
        expect(pass.report.left).toEqual([{path: 'nested/thing', reason: 'bundle-unreadable'}])
      }
      expect(storage.objects.has('nested/thing')).toBe(true)
      expect(finishCalls()).toBe(0)
    })

    it('does not ask again once the user answers null', async () => {
      reopenAnswers = [null]
      // canReadFolder is true, so the pass runs once first, then asks once.
      const pass = await run()
      // The first run found the broken folder; the ask came with the problem.
      expect(pass.kind).toBe('not-proved')
      expect(reopenPrompts.map(p => p.problem)).toEqual([PROBLEM])
      expect(events.filter(e => e === 'reopen')).toHaveLength(1)
      expect(storage.objects.has('nested/thing')).toBe(true)
      expect(finishCalls()).toBe(0)
    })
  })

  it('returns busy without touching Storage or asking, when the cleaner lock is held', async () => {
    const names: string[] = []
    lock = async name => {
      names.push(name)
      return {acquired: false}
    }
    const before = new Map(storage.objects)

    expect(await run()).toEqual({kind: 'busy'})

    expect(names).toEqual([attachmentCleanerLockName(USER, WS)])
    expect(storage.objects).toEqual(before)
    expect(storage.deletes).toEqual([])
    expect(events.filter(e => e !== 'awake' && e !== 'release')).toEqual([])
    expect(finishCalls()).toBe(0)
  })

  it('holds keepAwake around the cleaner run and releases it', async () => {
    lock = async (_name, runIt) => {
      events.push('lock:start')
      const value = await runIt()
      events.push('lock:end')
      return {acquired: true, value}
    }
    await run()
    expect(events.slice(0, 4)).toEqual(['awake', 'lock:start', 'lock:end', 'release'])
    expect(awake).toEqual({held: 1, released: 1})
  })

  it('releases keepAwake when the cleaner throws', async () => {
    lock = async () => { throw new Error('lock exploded') }
    await expect(run()).rejects.toThrow('lock exploded')
    expect(awake).toEqual({held: 1, released: 1})
    expect(finishCalls()).toBe(0)
  })

  it('refuses a key record without K_id before anything runs', async () => {
    const noHmac = {...minted.record, contentKeyHmac: undefined} as unknown as typeof minted.record
    await expect(runCleaningPass(deps(), noHmac, minted.canary)).rejects.toThrow('K_id')
    expect(events).toEqual([])
    expect(storage.deletes).toEqual([])
  })
})

describe('runCleaningPass without a bundle record', () => {
  it('asks for the bundle, re-asks on a wrong pick, then verifies, stores and uses the right one', async () => {
    const other = new MemoryBundleFolder('other')
    const empty = new MemoryBundleFolder('empty')
    chooseAnswers = [empty, other, folder]
    // Another workspace's bundle: same bytes, wrong workspace id in the manifest.
    const manifestText = folder.text('manifest.json')
    other.setText('manifest.json', manifestText.replace(`"workspaceId": "${WS}"`, '"workspaceId": "ws-other"'))

    expect(await run()).toEqual({kind: 'finished'})

    expect(choosePrompts).toHaveLength(3)
    expect(choosePrompts[0]).toBeNull()
    expect(choosePrompts[1]).toEqual(expect.any(String))
    expect(choosePrompts[2]).toEqual(expect.any(String))
    const stored = await bundles.get(USER, WS)
    expect(stored?.folder).toBe(folder)
    expect(stored?.otherObjectPaths).toEqual(record.otherObjectPaths)
    expect(stored?.workspaceId).toBe(WS)
    // The adopted bundle was used: its archived object was deleted against it.
    expect(storage.deletes).toContain('nested/thing')
    expect(finishCalls()).toBe(1)
  })

  it('rethrows what is not a bundle problem', async () => {
    const broken = folder.copy('bundle')
    broken.getFileHandle = async () => { throw new DOMException('denied', 'NotAllowedError') }
    chooseAnswers = [broken]
    await expect(run()).rejects.toThrow()
    expect(await bundles.get(USER, WS)).toBeNull()
    expect(finishCalls()).toBe(0)
  })
})

describe('conversionBundleOf', () => {
  it('reads archived objects by the digest of their path, and attachments by raw name', async () => {
    const bundle = conversionBundleOf(record, folder)

    expect([...bundle.archivedPaths]).toEqual(['nested/thing'])
    expect(await bundle.readArchivedObject('nested/thing')).toEqual(bytesOf('archived nested'))
    expect(folder.folders.get('other-objects')?.files.has(utf8Hex('nested/thing'))).toBe(true)
    expect(await bundle.readAttachment(rawHash)).toEqual(bytesOf('raw in storage'))
    expect(await bundle.readAttachment(localHash)).toEqual(bytesOf('only on device'))
  })

  it('returns null for a missing entry', async () => {
    const bundle = conversionBundleOf(record, folder)
    expect(await bundle.readArchivedObject('never/archived')).toBeNull()
    expect(await bundle.readAttachment('sha256:' + 'f'.repeat(64))).toBeNull()
  })

  it('throws when the folder or its subfolder cannot be read', async () => {
    const empty = conversionBundleOf(record, new MemoryBundleFolder('empty'))
    await expect(empty.readArchivedObject('nested/thing')).rejects.toThrow()
    await expect(empty.readAttachment(rawHash)).rejects.toThrow()

    const denied = folder.copy('bundle')
    denied.getDirectoryHandle = async () => { throw new DOMException('denied', 'NotAllowedError') }
    await expect(conversionBundleOf(record, denied).readAttachment(rawHash)).rejects.toThrow('denied')
  })
})
