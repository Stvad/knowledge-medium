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

/** This install, and another sharing the same folder. */
const INSTALL_A = 'a1b2c3d4'
const INSTALL_B = 'e5f6a7b8'
/** The database this device holds now, and the one it held before a wipe
 *  replaced it. Separate from the install axis on purpose — conflating the two
 *  is what left the replaced-database case untested. */
const CURRENT = '1799000000000'
const REPLACED = '1700000000000'

/** A repo stub: the mirror only reads `user.id` and the three marker queries. */
const stubRepo = (marker: number | null = 42, queue = {n: 0, last: null}): Repo =>
  ({
    user: {id: USER},
    db: {
      getAll: async (sql: string) => {
        if (sql.includes('ps_crud')) return [queue]
                return [{marker}]
      },
    },
  } as unknown as Repo)

/** What `readChangeMarker` produces for the stub above — tests state the marker
 *  they expect rather than reading it back off the thing under test. */
const MARKER = '42/0.0/0.0'

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
    installId: INSTALL_A,
    incarnation: CURRENT,
    exportToFile: fakeExport(1024),
    ...over,
  })

describe('runDbMirror', () => {
  it('writes one timestamped copy and reports what it wrote', async () => {
    const dir = new FakeDirectoryHandle()
    const outcome = await run({directory: dir.asHandle()})

    expect(outcome).toMatchObject({
      kind: 'mirrored',
      filename: dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN),
      bytes: 1024,
      marker: MARKER,
    })
    expect(dir.names()).toEqual([dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)])
    expect(dir.entries.get(dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN))?.bytes.byteLength).toBe(1024)
  })

  it('skips the copy when the change marker equals the last one AND that copy is still there', async () => {
    const dir = new FakeDirectoryHandle()
    const previous = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)
    dir.seed(previous, 512)
    const exportToFile = fakeExport(1024)

    const outcome = await run({
      directory: dir.asHandle(),
      lastCopy: {marker: MARKER, filename: previous},
      exportToFile,
    })

    expect(outcome).toEqual({kind: 'skipped-unchanged', marker: MARKER, pruned: [], unmanaged: 0})
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
        lastCopy: {marker: MARKER, filename: dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)},
      })

      expect(outcome).toMatchObject({kind: 'mirrored', filename: dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)})
    })

    it('does not accept an unreadable copy as proof a usable one is there', async () => {
      // An offline cloud placeholder is neither deleted nor believed: accepting
      // it would protect the unreadable file while pruning the readable ones
      // behind it, and report success forever.
      const dir = new FakeDirectoryHandle()
      const previous = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)
      dir.seed(previous, 512)
      dir.unreadable.add(previous)

      const outcome = await run({
        directory: dir.asHandle(),
        lastCopy: {marker: MARKER, filename: previous},
      })

      expect(outcome).toMatchObject({kind: 'mirrored'})
      expect(dir.names()).toContain(previous)
    })

    it('treats a copy truncated to a plausible size as gone', async () => {
      // An interrupted cloud sync leaves something that is not empty and not
      // the backup. Calling it present would protect the damaged file while
      // pruning the intact older ones behind it, and report success forever.
      const dir = new FakeDirectoryHandle()
      const previous = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)
      // Well over the header floor, so the size-match clause is what rejects it
      // — at 4 bytes the residue check got there first and this test passed
      // with the truncation guard deleted.
      dir.seed(previous, 300)

      const outcome = await run({
        directory: dir.asHandle(),
        lastCopy: {marker: MARKER, filename: previous, bytes: 65536},
      })

      expect(outcome).toMatchObject({kind: 'mirrored'})
    })

    it('treats a zero-length leftover as gone rather than as the copy', async () => {
      const dir = new FakeDirectoryHandle()
      const previous = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)
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
        lastCopy: {marker: MARKER, filename: dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)},
      })

      expect(outcome).toMatchObject({kind: 'mirrored'})
      expect(elsewhere.names()).toEqual([dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)])
    })
  })

  it('copies again once the marker has moved', async () => {
    const dir = new FakeDirectoryHandle()
    const outcome = await run({directory: dir.asHandle(), lastCopy: {marker: '41/0.0/0.0', filename: dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)}})
    expect(outcome).toMatchObject({kind: 'mirrored'})
  })

  it('copies when the marker cannot be read at all, rather than skipping blind', async () => {
    const dir = new FakeDirectoryHandle()
    const repo = {
      user: {id: USER},
      db: {getAll: async () => { throw new Error('no such table: row_events') }},
    } as unknown as Repo

    const outcome = await run({
      repo,
      directory: dir.asHandle(),
      lastCopy: {marker: MARKER, filename: dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)},
    })

    expect(outcome).toMatchObject({kind: 'mirrored', marker: undefined})
    expect(dir.names()).toEqual([dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)])
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
      const previous = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)
      dir.seed(previous, new Uint8Array([1, 2, 3, 4]))
      dir.failWrites = new DOMException('quota', 'QuotaExceededError')

      await expect(run({directory: dir.asHandle()})).rejects.toThrow(/quota/i)

      expect(dir.names()).toEqual([previous])
      expect([...dir.entries.get(previous)!.bytes]).toEqual([1, 2, 3, 4])
    })

    it('refuses a name that is already taken, rather than adopting and then deleting it', async () => {
      // `getFileHandle(…, {create: true})` adopts an existing file as happily as
      // it creates one, and the failure path deletes the name it was given — so
      // without the probe a collision would destroy whatever held the name.
      const dir = new FakeDirectoryHandle()
      const taken = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)
      dir.seed(taken, new Uint8Array([1, 2, 3, 4]))
      const exportToFile = fakeExport(1024)

      await expect(run({directory: dir.asHandle(), exportToFile})).rejects.toThrow(/already in the folder/)

      expect(exportToFile).not.toHaveBeenCalled()
      expect([...dir.entries.get(taken)!.bytes]).toEqual([1, 2, 3, 4])
      expect(dir.removed).toEqual([])
    })

    it('does not take a probe failure as proof the name is free', async () => {
      // Only NotFoundError proves it. Any other rejection treated as "free"
      // sends the run through `{create: true}`, which ADOPTS the existing file
      // — and the failure path then deletes it. That is exactly the
      // adopt-then-delete the probe exists to prevent.
      const dir = new FakeDirectoryHandle()
      const taken = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)
      dir.seed(taken, new Uint8Array([1, 2, 3, 4]))
      vi.spyOn(dir, 'getFileHandle').mockRejectedValueOnce(
        new DOMException('drive is asleep', 'NotReadableError'),
      )
      const exportToFile = fakeExport(1024)

      await expect(run({directory: dir.asHandle(), exportToFile})).rejects.toThrow(/drive is asleep/)

      expect(exportToFile).not.toHaveBeenCalled()
      expect([...dir.entries.get(taken)!.bytes]).toEqual([1, 2, 3, 4])
      expect(dir.removed).toEqual([])
    })

    it('keeps a copy whose size it merely could not read back', async () => {
      // The bytes are committed by then. A copy that exists but could not be
      // measured is worth more than no copy, and the next run re-checks it
      // anyway — the recorded byte count is part of the skip's presence test.
      const dir = new FakeDirectoryHandle()
      const written = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)
      const exportToFile = vi.fn(async (_repo: Repo, handle: FileSystemFileHandle) => {
        const writable = await handle.createWritable()
        await new Blob([new Uint8Array(1024)]).stream().pipeTo(writable)
        dir.unreadable.add(written)
        return {filename: handle.name, size: 1024}
      })

      const outcome = await run({directory: dir.asHandle(), exportToFile})

      expect(outcome).toMatchObject({kind: 'mirrored', bytes: 1024})
      expect(dir.names()).toContain(written)
      expect(dir.removed).toEqual([])
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
      const older = [3, 2, 1].map(n => dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - n * HOUR, TOKEN))
      older.forEach(name => dir.seed(name, 512))

      const outcome = await run({directory: dir.asHandle(), keepCount: 2})

      expect(outcome).toMatchObject({kind: 'mirrored', pruned: expect.any(Array)})
      expect(dir.names().sort()).toEqual(
        [dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN), older[2]].sort(),
      )
    })

    it('never removes anything outside its own naming pattern', async () => {
      const dir = new FakeDirectoryHandle()
      const bystanders = [
        DB,
        `${DB}-wa0`,
        'kmp-v6-alice-export-1757000000000.db',
        'kmp-v6-bob-mirror-2026-09-04T10-00-00Z-abcdef-abc123.db',
        'family-photos.db',
        // Another device mirroring the same account into the same shared folder.
        dbMirrorFilename(DB, INSTALL_B, CURRENT, AT - HOUR, 'bbbbbb'),
      ]
      bystanders.forEach(name => dir.seed(name, 4096))
      dir.seed(dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN), 512)

      await run({directory: dir.asHandle(), keepCount: 1})

      expect(dir.names()).toEqual([...bystanders, dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)].sort())
      expect(dir.removed).toEqual([dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)])
    })

    it('discards an empty copy left behind by a crashed run before counting', async () => {
      const dir = new FakeDirectoryHandle()
      const good = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - 2 * HOUR, TOKEN)
      const crashed = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)
      dir.seed(good, 512)
      dir.seed(crashed, 0)

      await run({directory: dir.asHandle(), keepCount: 2})

      // The crashed run's 0-byte file is gone, and it did not push the older
      // GOOD copy out of the two keep slots.
      expect(dir.names().sort()).toEqual([good, dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)].sort())
    })

    it('discards a stub too short to be a database, not merely an empty one', async () => {
      // A run that died between claiming the name and finishing the header
      // leaves a few bytes rather than none. Counting that as a copy would let
      // it hold a keep slot and push a real backup out.
      const dir = new FakeDirectoryHandle()
      const good = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - 2 * HOUR, TOKEN)
      const stub = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)
      dir.seed(good, 512)
      dir.seed(stub, 12)

      await run({directory: dir.asHandle(), keepCount: 2})

      expect(dir.names().sort()).toEqual([good, dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)].sort())
    })

    it('still prunes when the database has not changed', async () => {
      // Housekeeping is about the folder, not the copy: lowering the keep count
      // has to take effect even while the database sits unchanged, and a
      // pruning failure has to get retried.
      const dir = new FakeDirectoryHandle()
      const older = [3, 2, 1].map(n => dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - n * HOUR, TOKEN))
      older.forEach(name => dir.seed(name, 512))

      const outcome = await run({
        directory: dir.asHandle(),
        lastCopy: {marker: MARKER, filename: older[2]},
        keepCount: 1,
      })

      expect(outcome).toMatchObject({kind: 'skipped-unchanged', pruned: [older[1], older[0]]})
      expect(dir.names()).toEqual([older[2]])
    })

    it('keeps the copy the marker points at when the clock jumped backwards', async () => {
      // Same rule as for a freshly written copy, at the other call site: the
      // unchanged path prunes too, and ranking by the stamp in the name would
      // otherwise delete the newest real backup in favour of future-stamped
      // ones — leaving the status pointing at a file that is gone.
      const dir = new FakeDirectoryHandle()
      const current = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN)
      const fromTheFuture = [1, 2].map(n => dbMirrorFilename(DB, INSTALL_A, CURRENT, AT + n * HOUR, TOKEN))
      dir.seed(current, 512)
      fromTheFuture.forEach(name => dir.seed(name, 512))

      const outcome = await run({
        directory: dir.asHandle(),
        lastCopy: {marker: MARKER, filename: current},
        keepCount: 2,
      })

      expect(outcome).toMatchObject({kind: 'skipped-unchanged'})
      expect(dir.names()).toContain(current)
    })

    it('keeps the copy this run just wrote even when the clock jumped backwards', async () => {
      // Ordering by the stamp in the name is only as good as the clock that
      // wrote it. Ranked purely by timestamp, a copy written "in the past"
      // would be pruned immediately — while the run still reported success and
      // stored its marker, so later runs would skip with nothing on disk.
      const dir = new FakeDirectoryHandle()
      const fromTheFuture = [1, 2].map(n => dbMirrorFilename(DB, INSTALL_A, CURRENT, AT + n * HOUR, TOKEN))
      fromTheFuture.forEach(name => dir.seed(name, 512))

      const outcome = await run({directory: dir.asHandle(), keepCount: 2})

      expect(dir.names()).toContain(dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN))
      expect(outcome).toMatchObject({kind: 'mirrored', filename: dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)})
    })

    it('counts the copy it just wrote against the keep budget', async () => {
      const dir = new FakeDirectoryHandle()
      const older = [2, 1].map(n => dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - n * HOUR, TOKEN))
      older.forEach(name => dir.seed(name, 512))

      await run({directory: dir.asHandle(), keepCount: 2})

      expect(dir.names().sort()).toEqual([dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN), older[1]].sort())
    })

    it('never touches copies another install wrote into a shared folder', async () => {
      // Same account, one cloud-synced folder, two machines — including the
      // case where the second was seeded by RESTORING this mirror, so both hold
      // the same database. Their Web Locks cannot reach each other, so with
      // keepCount 1 a routine run here would otherwise delete the only copy
      // holding the OTHER machine's unsynced work.
      const dir = new FakeDirectoryHandle()
      const theirs = [1, 2].map(n => dbMirrorFilename(DB, INSTALL_B, CURRENT, AT - n * HOUR, 'bbbbbb'))
      theirs.forEach(name => dir.seed(name, 512))

      await run({directory: dir.asHandle(), keepCount: 1})

      expect(dir.names()).toEqual([...theirs, dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)].sort())
    })

    it('keeps the copies of the database this one replaced', async () => {
      // THE scenario this feature exists for: the browser wiped the local
      // store, the app rebuilt a fresh database under the same filename, and
      // its first copy must not evict the pre-loss copy — which is the only one
      // holding the work the wipe took.
      const dir = new FakeDirectoryHandle()
      const beforeTheLoss = dbMirrorFilename(DB, INSTALL_A, REPLACED, AT - HOUR, 'bbbbbb')
      dir.seed(beforeTheLoss, 4096)

      await run({directory: dir.asHandle(), keepCount: 1})

      expect(dir.names()).toContain(beforeTheLoss)
    })

    it('counts the copies it may not touch, rather than letting the folder grow for no stated reason', async () => {
      const dir = new FakeDirectoryHandle()
      dir.seed(dbMirrorFilename(DB, INSTALL_B, CURRENT, AT - HOUR, 'bbbbbb'), 512)
      dir.seed(dbMirrorFilename(DB, INSTALL_A, REPLACED, AT - HOUR, 'cccccc'), 512)

      const outcome = await run({directory: dir.asHandle(), keepCount: 1})

      expect(outcome).toMatchObject({kind: 'mirrored', pruned: [], unmanaged: 2})
    })

    it('keeps listing the copies it can read when one entry cannot be opened', async () => {
      // An offline cloud placeholder aborting the whole listing would make every
      // run write another copy AND prune nothing, so the folder grows until the
      // disk is full.
      const dir = new FakeDirectoryHandle()
      const unreadable = dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, 'cccccc')
      dir.seed(unreadable, 512)
      dir.unreadable.add(unreadable)
      const stale = [2, 3, 4].map(n => dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - n * HOUR, 'bbbbbb'))
      stale.forEach(name => dir.seed(name, 512))

      const outcome = await run({directory: dir.asHandle(), keepCount: 2})

      // Pruning happened at all, which it could not have if the unreadable
      // entry had aborted the listing.
      expect(outcome).toMatchObject({kind: 'mirrored'})
      // And "cannot tell" did not become "delete it".
      expect(dir.names()).toContain(unreadable)
    })

    it('does not let a copy it cannot open take a keep slot from one it can', async () => {
      // On a cloud folder the NEWEST entries are the ones most likely to be
      // cold, so counting them against the budget spent every slot on files
      // this device cannot open while deleting the ones it can. Neither
      // deleted nor counted: the user asked for N they can actually restore.
      const dir = new FakeDirectoryHandle()
      const cold = [1, 2].map(n => dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - n * HOUR, 'cccccc'))
      cold.forEach(name => { dir.seed(name, 4096); dir.unreadable.add(name) })
      const readable = [3, 4].map(n => dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - n * HOUR, 'bbbbbb'))
      readable.forEach(name => dir.seed(name, 4096))

      const outcome = await run({directory: dir.asHandle(), keepCount: 3})

      // Three openable copies, as asked: the new one and both readable ones.
      const survivors = dir.names()
      expect(survivors).toContain(dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN))
      readable.forEach(name => expect(survivors).toContain(name))
      // The cold ones are still there, and reported as outside the budget.
      cold.forEach(name => expect(survivors).toContain(name))
      expect(outcome).toMatchObject({kind: 'mirrored', unmanaged: 2})
    })

    it('reports a pruning failure without failing the copy that succeeded', async () => {
      const dir = new FakeDirectoryHandle()
      dir.seed(dbMirrorFilename(DB, INSTALL_A, CURRENT, AT - HOUR, TOKEN), 512)
      vi.spyOn(dir, 'removeEntry').mockRejectedValue(new Error('file is locked'))

      const outcome = await run({directory: dir.asHandle(), keepCount: 1})

      expect(outcome).toMatchObject({kind: 'mirrored', filename: dbMirrorFilename(DB, INSTALL_A, CURRENT, AT, TOKEN)})
    })
  })
})
