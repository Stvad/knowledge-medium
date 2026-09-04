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
/** A pinned run token, so a test can name the file a run will write. */
const TOKEN = 'aaaaaa'

/** A repo stub: the mirror only reads `user.id` and the change-marker query. */
const stubRepo = (marker: number | null = 42, queue = {n: 0, last: null}): Repo =>
  ({
    user: {id: USER},
    db: {
      getAll: async (sql: string) =>
        sql.includes('ps_crud') ? [queue] : [{marker}],
    },
  } as unknown as Repo)

/** What `readChangeMarker` produces for the stub above — tests state the marker
 *  they expect rather than reading it back off the thing under test. */
const MARKER = '42/0.0'

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
    token: TOKEN,
    exportToFile: fakeExport(1024),
    ...over,
  })

describe('runDbMirror', () => {
  it('writes one timestamped copy and reports what it wrote', async () => {
    const dir = new FakeDirectoryHandle()
    const outcome = await run({directory: dir.asHandle()})

    expect(outcome).toMatchObject({
      kind: 'mirrored',
      filename: dbMirrorFilename(DB, AT, TOKEN),
      bytes: 1024,
      marker: MARKER,
    })
    expect(dir.names()).toEqual([dbMirrorFilename(DB, AT, TOKEN)])
    expect(dir.entries.get(dbMirrorFilename(DB, AT, TOKEN))?.bytes.byteLength).toBe(1024)
  })

  it('skips the copy when the change marker equals the last one AND that copy is still there', async () => {
    const dir = new FakeDirectoryHandle()
    const previous = dbMirrorFilename(DB, AT - HOUR, TOKEN)
    dir.seed(previous, 512)
    const exportToFile = fakeExport(1024)

    const outcome = await run({
      directory: dir.asHandle(),
      lastCopy: {marker: MARKER, filename: previous},
      exportToFile,
    })

    expect(outcome).toEqual({kind: 'skipped-unchanged', marker: MARKER, pruned: []})
    expect(exportToFile).not.toHaveBeenCalled()
    expect(dir.names()).toEqual([previous])
  })

  describe('when the copy the marker refers to is gone', () => {
    it('copies again even though the database has not changed', async () => {
      // Deleting the last mirror by hand would otherwise leave a stored marker
      // that skipped every run for good, while the status went on reporting a
      // healthy backup that no longer existed.
      const dir = new FakeDirectoryHandle()

      const outcome = await run({
        directory: dir.asHandle(),
        lastCopy: {marker: MARKER, filename: dbMirrorFilename(DB, AT - HOUR, TOKEN)},
      })

      expect(outcome).toMatchObject({kind: 'mirrored', filename: dbMirrorFilename(DB, AT, TOKEN)})
    })

    it('treats a zero-length leftover as gone rather than as the copy', async () => {
      const dir = new FakeDirectoryHandle()
      const previous = dbMirrorFilename(DB, AT - HOUR, TOKEN)
      dir.seed(previous, 0)

      const outcome = await run({
        directory: dir.asHandle(),
        lastCopy: {marker: MARKER, filename: previous},
      })

      expect(outcome).toMatchObject({kind: 'mirrored'})
    })

    it('copies into a folder the user switched to mid-run, rather than trusting the old record', async () => {
      // The status can name a file in the PREVIOUS folder — a run in flight
      // when the folder changed records it. The new folder does not have it, so
      // the next run copies instead of skipping.
      const elsewhere = new FakeDirectoryHandle('Elsewhere')

      const outcome = await run({
        directory: elsewhere.asHandle(),
        lastCopy: {marker: MARKER, filename: dbMirrorFilename(DB, AT - HOUR, TOKEN)},
      })

      expect(outcome).toMatchObject({kind: 'mirrored'})
      expect(elsewhere.names()).toEqual([dbMirrorFilename(DB, AT, TOKEN)])
    })
  })

  it('copies again once the marker has moved', async () => {
    const dir = new FakeDirectoryHandle()
    const outcome = await run({directory: dir.asHandle(), lastCopy: {marker: '41/0.0', filename: dbMirrorFilename(DB, AT - HOUR, TOKEN)}})
    expect(outcome).toMatchObject({kind: 'mirrored'})
  })

  it('copies when the marker cannot be read at all, rather than skipping blind', async () => {
    const dir = new FakeDirectoryHandle()
    const repo = {
      user: {id: USER},
      db: {getAll: async () => { throw new Error('no such table: row_events') }},
    } as unknown as Repo

    const outcome = await run({repo, directory: dir.asHandle(), lastCopy: {marker: MARKER, filename: dbMirrorFilename(DB, AT - HOUR, TOKEN)}})

    expect(outcome).toMatchObject({kind: 'mirrored', marker: undefined})
    expect(dir.names()).toEqual([dbMirrorFilename(DB, AT, TOKEN)])
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
      const previous = dbMirrorFilename(DB, AT - HOUR, TOKEN)
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
      const older = [3, 2, 1].map(n => dbMirrorFilename(DB, AT - n * HOUR, TOKEN))
      older.forEach(name => dir.seed(name, 512))

      const outcome = await run({directory: dir.asHandle(), keepCount: 2})

      expect(outcome).toMatchObject({kind: 'mirrored', pruned: expect.any(Array)})
      expect(dir.names().sort()).toEqual(
        [dbMirrorFilename(DB, AT, TOKEN), older[2]].sort(),
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
      dir.seed(dbMirrorFilename(DB, AT - HOUR, TOKEN), 512)

      await run({directory: dir.asHandle(), keepCount: 1})

      expect(dir.names()).toEqual([...bystanders, dbMirrorFilename(DB, AT, TOKEN)].sort())
      expect(dir.removed).toEqual([dbMirrorFilename(DB, AT - HOUR, TOKEN)])
    })

    it('discards an empty copy left behind by a crashed run before counting', async () => {
      const dir = new FakeDirectoryHandle()
      const good = dbMirrorFilename(DB, AT - 2 * HOUR, TOKEN)
      const crashed = dbMirrorFilename(DB, AT - HOUR, TOKEN)
      dir.seed(good, 512)
      dir.seed(crashed, 0)

      await run({directory: dir.asHandle(), keepCount: 2})

      // The crashed run's 0-byte file is gone, and it did not push the older
      // GOOD copy out of the two keep slots.
      expect(dir.names().sort()).toEqual([good, dbMirrorFilename(DB, AT, TOKEN)].sort())
    })

    it('still prunes when the database has not changed', async () => {
      // Housekeeping is about the folder, not the copy: lowering the keep count
      // has to take effect even while the database sits unchanged, and a
      // pruning failure has to get retried.
      const dir = new FakeDirectoryHandle()
      const older = [3, 2, 1].map(n => dbMirrorFilename(DB, AT - n * HOUR, TOKEN))
      older.forEach(name => dir.seed(name, 512))

      const outcome = await run({
        directory: dir.asHandle(),
        lastCopy: {marker: MARKER, filename: older[2]},
        keepCount: 1,
      })

      expect(outcome).toMatchObject({kind: 'skipped-unchanged', pruned: [older[1], older[0]]})
      expect(dir.names()).toEqual([older[2]])
    })

    it('keeps the copy this run just wrote even when the clock jumped backwards', async () => {
      // Ordering by the stamp in the name is only as good as the clock that
      // wrote it. Ranked purely by timestamp, a copy written "in the past"
      // would be pruned immediately — while the run still reported success and
      // stored its marker, so later runs would skip with nothing on disk.
      const dir = new FakeDirectoryHandle()
      const fromTheFuture = [1, 2].map(n => dbMirrorFilename(DB, AT + n * HOUR, TOKEN))
      fromTheFuture.forEach(name => dir.seed(name, 512))

      const outcome = await run({directory: dir.asHandle(), keepCount: 2})

      expect(dir.names()).toContain(dbMirrorFilename(DB, AT, TOKEN))
      expect(outcome).toMatchObject({kind: 'mirrored', filename: dbMirrorFilename(DB, AT, TOKEN)})
    })

    it('counts the copy it just wrote against the keep budget', async () => {
      const dir = new FakeDirectoryHandle()
      const older = [2, 1].map(n => dbMirrorFilename(DB, AT - n * HOUR, TOKEN))
      older.forEach(name => dir.seed(name, 512))

      await run({directory: dir.asHandle(), keepCount: 2})

      expect(dir.names().sort()).toEqual([dbMirrorFilename(DB, AT, TOKEN), older[1]].sort())
    })

    it('reports a pruning failure without failing the copy that succeeded', async () => {
      const dir = new FakeDirectoryHandle()
      dir.seed(dbMirrorFilename(DB, AT - HOUR, TOKEN), 512)
      vi.spyOn(dir, 'removeEntry').mockRejectedValue(new Error('file is locked'))

      const outcome = await run({directory: dir.asHandle(), keepCount: 1})

      expect(outcome).toMatchObject({kind: 'mirrored', filename: dbMirrorFilename(DB, AT, TOKEN)})
    })
  })
})
