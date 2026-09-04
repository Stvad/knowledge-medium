import {describe, expect, it, vi} from 'vitest'
import type {Repo} from '@/data/repo'
import {dbFilenameForUser} from '@/data/localDbStorage.js'
import {runDbMirror} from '../mirror.js'
import {dbMirrorFilename} from '../filenames.js'
import {FakeDirectoryHandle} from './fakeFileSystem.js'

const USER = 'alice'
const DB = dbFilenameForUser(USER)
const AT = Date.UTC(2026, 8, 4, 13, 45, 2)
const HOUR = 3_600_000

/** A repo stub: the mirror only reads `user.id` and the change-marker query. */
const stubRepo = (marker: number | null = 42): Repo =>
  ({
    user: {id: USER},
    db: {getAll: async () => [{marker}]},
  } as unknown as Repo)

/** Stands in for `exportRawSqliteDbToFile`: writes `bytes` of payload through
 *  the handle exactly as the real checkpointed export does. */
const fakeExport = (bytes: number) =>
  vi.fn(async (_repo: Repo, handle: FileSystemFileHandle) => {
    const writable = await handle.createWritable()
    await new Blob([new Uint8Array(bytes)]).stream().pipeTo(writable)
    return {filename: handle.name, size: bytes}
  })

const run = (over: Partial<Parameters<typeof runDbMirror>[0]> = {}) =>
  runDbMirror({
    repo: stubRepo(),
    directory: new FakeDirectoryHandle().asHandle(),
    keepCount: 3,
    now: AT,
    exportToFile: fakeExport(1024),
    ...over,
  })

describe('runDbMirror', () => {
  it('writes one timestamped copy and reports what it wrote', async () => {
    const dir = new FakeDirectoryHandle()
    const outcome = await run({directory: dir.asHandle()})

    expect(outcome).toMatchObject({
      kind: 'mirrored',
      filename: dbMirrorFilename(DB, AT),
      bytes: 1024,
      marker: '42',
    })
    expect(dir.names()).toEqual([dbMirrorFilename(DB, AT)])
    expect(dir.entries.get(dbMirrorFilename(DB, AT))?.bytes.byteLength).toBe(1024)
  })

  it('skips the copy when the change marker equals the last mirrored one', async () => {
    const dir = new FakeDirectoryHandle()
    const exportToFile = fakeExport(1024)

    const outcome = await run({directory: dir.asHandle(), lastMarker: '42', exportToFile})

    expect(outcome).toEqual({kind: 'skipped-unchanged', marker: '42'})
    expect(exportToFile).not.toHaveBeenCalled()
    expect(dir.names()).toEqual([])
  })

  it('copies again once the marker has moved', async () => {
    const dir = new FakeDirectoryHandle()
    const outcome = await run({directory: dir.asHandle(), lastMarker: '41'})
    expect(outcome).toMatchObject({kind: 'mirrored'})
  })

  it('copies when the marker cannot be read at all, rather than skipping blind', async () => {
    const dir = new FakeDirectoryHandle()
    const repo = {
      user: {id: USER},
      db: {getAll: async () => { throw new Error('no such table: row_events') }},
    } as unknown as Repo

    const outcome = await run({repo, directory: dir.asHandle(), lastMarker: '42'})

    expect(outcome).toMatchObject({kind: 'mirrored', marker: undefined})
    expect(dir.names()).toEqual([dbMirrorFilename(DB, AT)])
  })

  it('does not touch the directory when the folder permission is gone', async () => {
    const dir = new FakeDirectoryHandle()
    dir.permission = 'prompt'
    const exportToFile = fakeExport(1024)

    const outcome = await run({directory: dir.asHandle(), exportToFile})

    expect(outcome).toEqual({kind: 'permission-lost', permission: 'prompt'})
    expect(exportToFile).not.toHaveBeenCalled()
    expect(dir.names()).toEqual([])
  })

  it('never prompts for permission from a run — only queries it', async () => {
    const dir = new FakeDirectoryHandle()
    dir.permission = 'prompt'
    const requestPermission = vi.spyOn(dir, 'requestPermission')

    await run({directory: dir.asHandle()})

    expect(requestPermission).not.toHaveBeenCalled()
  })

  describe('an interrupted run', () => {
    it('leaves the previous copy intact and removes its own empty entry', async () => {
      const dir = new FakeDirectoryHandle()
      const previous = dbMirrorFilename(DB, AT - HOUR)
      dir.seed(previous, new Uint8Array([1, 2, 3, 4]))
      dir.failWrites = new DOMException('quota', 'QuotaExceededError')

      await expect(run({directory: dir.asHandle()})).rejects.toThrow(/quota/i)

      expect(dir.names()).toEqual([previous])
      expect([...dir.entries.get(previous)!.bytes]).toEqual([1, 2, 3, 4])
    })

    it('removes its own entry when the copy comes out the wrong size', async () => {
      const dir = new FakeDirectoryHandle()
      // A writer that reports more bytes than it actually committed — the shape
      // a truncated copy would take.
      const exportToFile = vi.fn(async (_repo: Repo, handle: FileSystemFileHandle) => {
        const writable = await handle.createWritable()
        await new Blob([new Uint8Array(10)]).stream().pipeTo(writable)
        return {filename: handle.name, size: 1024}
      })

      await expect(run({directory: dir.asHandle(), exportToFile})).rejects.toThrow(/size/i)
      expect(dir.names()).toEqual([])
    })
  })

  describe('pruning', () => {
    it('keeps the newest N copies, counting the one just written', async () => {
      const dir = new FakeDirectoryHandle()
      const older = [3, 2, 1].map(n => dbMirrorFilename(DB, AT - n * HOUR))
      older.forEach(name => dir.seed(name, 512))

      const outcome = await run({directory: dir.asHandle(), keepCount: 2})

      expect(outcome).toMatchObject({kind: 'mirrored', pruned: expect.any(Array)})
      expect(dir.names().sort()).toEqual(
        [dbMirrorFilename(DB, AT), older[2]].sort(),
      )
    })

    it('never removes anything outside its own naming pattern', async () => {
      const dir = new FakeDirectoryHandle()
      const bystanders = [
        DB,
        `${DB}-wa0`,
        'kmp-v6-alice-export-1757000000000.db',
        'kmp-v6-bob-mirror-2026-09-04T10-00-00Z.db',
        'family-photos.db',
      ]
      bystanders.forEach(name => dir.seed(name, 4096))
      dir.seed(dbMirrorFilename(DB, AT - HOUR), 512)

      await run({directory: dir.asHandle(), keepCount: 1})

      expect(dir.names()).toEqual([...bystanders, dbMirrorFilename(DB, AT)].sort())
      expect(dir.removed).toEqual([dbMirrorFilename(DB, AT - HOUR)])
    })

    it('discards an empty copy left behind by a crashed run before counting', async () => {
      const dir = new FakeDirectoryHandle()
      const good = dbMirrorFilename(DB, AT - 2 * HOUR)
      const crashed = dbMirrorFilename(DB, AT - HOUR)
      dir.seed(good, 512)
      dir.seed(crashed, 0)

      await run({directory: dir.asHandle(), keepCount: 2})

      // The crashed run's 0-byte file is gone, and it did not push the older
      // GOOD copy out of the two keep slots.
      expect(dir.names().sort()).toEqual([good, dbMirrorFilename(DB, AT)].sort())
    })

    it('reports a pruning failure without failing the copy that succeeded', async () => {
      const dir = new FakeDirectoryHandle()
      dir.seed(dbMirrorFilename(DB, AT - HOUR), 512)
      vi.spyOn(dir, 'removeEntry').mockRejectedValue(new Error('file is locked'))

      const outcome = await run({directory: dir.asHandle(), keepCount: 1})

      expect(outcome).toMatchObject({kind: 'mirrored', filename: dbMirrorFilename(DB, AT)})
    })
  })
})
