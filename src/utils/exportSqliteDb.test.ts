// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Zip, ZipPassThrough, unzipSync, zipSync } from 'fflate'
import type { Repo } from '@/data/repo'
import {
  deleteLocalSqliteDb,
  exportRawSqliteDb,
  getRawSqliteDbBackup,
  importRawSqliteDb,
  removeRecoveryBackupTemps,
} from './exportSqliteDb'

// What SQLite actually answers `PRAGMA wal_checkpoint` with in rollback-journal
// mode, i.e. every CoopSync user: busy 0, nothing outstanding.
const DRAINED = {rows: {_array: [{busy: 0, log: -1, checkpointed: -1}]}}

const fakeWriteLock = (checkpointResult: unknown = DRAINED) => {
  const execute = vi.fn(async () => checkpointResult)
  const writeLock = vi.fn(
    async <T,>(fn: (tx: {execute: (sql: string) => Promise<unknown>}) => Promise<T>) => fn({execute}),
  )
  return {execute, writeLock}
}


// Minimal File stand-ins: jsdom's Blob.stream()/arrayBuffer() are unreliable, so
// the fakes carry their own, letting us drive the real streaming-zip code.
const fakeFile = (bytes: Uint8Array) => ({
  size: bytes.byteLength,
  stream: () => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  }),
})
const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

const originalStorage = navigator.storage

afterEach(() => {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: originalStorage,
  })
})

describe('exportRawSqliteDb', () => {
  it('checkpoints, then copies the OPFS file under one write lock, before returning a blob', async () => {
    const snapshotFile = new File(['snapshot-data'], 'snapshot.db')
    const pipeTo = vi.fn(async () => undefined)
    const sourceFile = {
      size: 11,
      stream: vi.fn(() => ({pipeTo})),
      arrayBuffer: vi.fn(async () => {
        throw new Error('arrayBuffer should not be used for SQLite export')
      }),
    } as unknown as File
    const snapshotWritable = {} as FileSystemWritableFileStream

    const sourceHandle = {
      getFile: vi.fn(async () => sourceFile),
    }
    const snapshotHandle = {
      createWritable: vi.fn(async () => snapshotWritable),
      getFile: vi.fn(async () => snapshotFile),
    }
    const getFileHandle = vi.fn(async (name: string) => (
      name.includes('export-snapshot') ? snapshotHandle : sourceHandle
    ))
    const getDirectory = vi.fn(async () => ({getFileHandle}))
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {getDirectory},
    })

    const {execute, writeLock} = fakeWriteLock()
    const result = await exportRawSqliteDb({
      user: {id: 'user-1'},
      db: {writeLock},
    } as unknown as Repo)

    expect(getFileHandle).toHaveBeenCalledWith('kmp-v6-user-1.db')
    expect(getFileHandle).toHaveBeenCalledWith(
      expect.stringMatching(/^\.kmp-v6-user-1\.db\.export-snapshot-/),
      {create: true},
    )
    expect(writeLock).toHaveBeenCalledOnce()
    // Inside the lock, so no writer can commit back into a sidecar between the
    // flush and the byte copy.
    expect(execute).toHaveBeenCalledWith('PRAGMA wal_checkpoint=truncate')
    // Twice: once to size the snapshot, once INSIDE the lock — the pre-checkpoint
    // File would copy the database as it stood before the sidecars were folded in.
    expect(sourceHandle.getFile).toHaveBeenCalledTimes(2)
    expect(sourceFile.arrayBuffer).not.toHaveBeenCalled()
    expect(sourceFile.stream).toHaveBeenCalledOnce()
    expect(snapshotHandle.createWritable).toHaveBeenCalledWith({keepExistingData: false})
    // The signal is what lets a timeout stop the copy rather than merely stop
    // awaiting it, so it has to reach pipeTo.
    expect(pipeTo).toHaveBeenCalledWith(snapshotWritable, {signal: expect.any(AbortSignal)})
    expect(result.blob).toBe(snapshotFile)
    expect(result.filename).toMatch(/^kmp-v6-user-1-export-\d+\.db$/)
  })

  it('fails fast with a storage-space message when free OPFS space is below the DB size', async () => {
    const MiB = 1024 * 1024
    const sourceFile = {size: 100 * MiB, stream: vi.fn()} as unknown as File
    const sourceHandle = {getFile: vi.fn(async () => sourceFile)}
    const getFileHandle = vi.fn(async () => sourceHandle)
    const getDirectory = vi.fn(async () => ({getFileHandle}))
    // quota 120 MiB, usage 100 MiB -> only 20 MiB free, but the snapshot needs 100 MiB.
    const estimate = vi.fn(async () => ({quota: 120 * MiB, usage: 100 * MiB}))
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {getDirectory, estimate},
    })
    const {writeLock} = fakeWriteLock()

    const promise = exportRawSqliteDb({
      user: {id: 'user-1'},
      db: {writeLock},
    } as unknown as Repo)

    await expect(promise).rejects.toThrow(/Not enough browser storage/)
    await expect(promise).rejects.toThrow(/100\.0 MiB/) // required
    await expect(promise).rejects.toThrow(/20\.0 MiB/) // available
    // Bails before locking the DB or creating the doomed snapshot file.
    expect(writeLock).not.toHaveBeenCalled()
    expect(getFileHandle).not.toHaveBeenCalledWith(
      expect.stringContaining('export-snapshot'),
      {create: true},
    )
  })

  it('refuses rather than backing up a database whose log did not drain', async () => {
    // A partial checkpoint does not fail the statement; copying anyway yields a
    // backup that opens cleanly and is missing its most recent writes.
    const {writeLock} = fakeWriteLock({rows: {_array: [{'12': '12'}]}})
    const getFileHandle = vi.fn(async () => ({
      getFile: vi.fn(async () => ({size: 11})),
      createWritable: vi.fn(),
    }))
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        // The refusal drops the partial snapshot on its way out.
        getDirectory: vi.fn(async () => ({getFileHandle, removeEntry: vi.fn(async () => {})})),
        estimate: async () => ({quota: 1e9, usage: 0}),
      },
    })

    await expect(exportRawSqliteDb({
      user: {id: 'user-1'},
      db: {writeLock},
    } as unknown as Repo)).rejects.toThrow(/missing them/)
  })

  it('rewraps a QuotaExceededError from the snapshot write and removes the partial snapshot', async () => {
    const pipeTo = vi.fn(async () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    const sourceFile = {
      size: 10,
      stream: vi.fn(() => ({pipeTo})),
    } as unknown as File
    const sourceHandle = {getFile: vi.fn(async () => sourceFile)}
    const snapshotHandle = {
      createWritable: vi.fn(async () => ({}) as FileSystemWritableFileStream),
      getFile: vi.fn(),
    }
    const getFileHandle = vi.fn(async (name: string) => (
      name.includes('export-snapshot') ? snapshotHandle : sourceHandle
    ))
    const removeEntry = vi.fn(async () => undefined)
    const getDirectory = vi.fn(async () => ({getFileHandle, removeEntry}))
    // Plenty of free space, so the precheck passes and the failure comes from the write itself.
    const estimate = vi.fn(async () => ({quota: 1000, usage: 0}))
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {getDirectory, estimate},
    })
    const {writeLock} = fakeWriteLock()

    const error: Error = await exportRawSqliteDb({
      user: {id: 'user-1'},
      db: {writeLock},
    } as unknown as Repo).then(
      () => { throw new Error('expected export to reject') },
      (e: unknown) => e as Error,
    )

    expect(error.message).toMatch(/Not enough browser storage/)
    // The post-write estimate reports more free space than the failed write
    // needed (the browser's quota figure doesn't reflect the real OPFS limit).
    // Don't quote a contradictory "but only N MiB is available" clause.
    expect(error.message).not.toMatch(/is available/)

    expect(removeEntry).toHaveBeenCalledWith(
      expect.stringMatching(/^\.kmp-v6-user-1\.db\.export-snapshot-/),
    )
    expect(snapshotHandle.getFile).not.toHaveBeenCalled()
  })
})

describe('importRawSqliteDb', () => {
  it('validates only the header slice before rejecting a non-SQLite file', async () => {
    const invalidHeader = new Uint8Array(16)
    const file = new File([invalidHeader], 'bad.db')
    const arrayBuffer = vi.fn(async () => {
      throw new Error('whole-file arrayBuffer should not be used for SQLite import')
    })
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: arrayBuffer,
    })
    const close = vi.fn()

    await expect(importRawSqliteDb({
      user: {id: 'user-1'},
      db: {close},
    } as unknown as Repo, [file])).rejects.toThrow(
      'Selected file is not a SQLite database (missing magic header).',
    )

    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('streams import through OPFS staging before closing and replacing the live DB', async () => {
    const sqliteHeader = new Uint8Array([
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20,
      0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
    ])
    const file = fileWithStream([sqliteHeader, new Uint8Array([1, 2, 3])], 'valid.db')
    const arrayBuffer = vi.fn(async () => {
      throw new Error('whole-file arrayBuffer should not be used for SQLite import')
    })
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: arrayBuffer,
    })

    const events: string[] = []
    const stagingHandle = createCapturingFileHandle('staging.db', events)
    const targetHandle = createCapturingFileHandle('kmp-v6-user-1.db', events)
    const getFileHandle = vi.fn(async (name: string) => {
      if (name === 'kmp-v6-user-1.db') return targetHandle
      if (name.startsWith('.kmp-v6-user-1.db.import-staging-')) return stagingHandle
      throw new Error(`unexpected file handle: ${name}`)
    })
    const removeEntry = vi.fn(async (name: string) => {
      events.push(`remove:${name}`)
    })
    const getDirectory = vi.fn(async () => ({getFileHandle, removeEntry}))
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {getDirectory},
    })

    const close = vi.fn(async () => {
      events.push('db.close')
    })

    expect(arrayBuffer).not.toHaveBeenCalled()
    await importRawSqliteDb({
      user: {id: 'user-1'},
      db: {close},
    } as unknown as Repo, [file])

    expect(close).toHaveBeenCalledOnce()
    expect(events.indexOf('db.close')).toBeGreaterThan(events.indexOf('close:staging.db'))
    expect(removeEntry).toHaveBeenCalledWith('kmp-v6-user-1.db-journal')
    expect(removeEntry).toHaveBeenCalledWith('kmp-v6-user-1.db-wal')
    expect(removeEntry).toHaveBeenCalledWith('kmp-v6-user-1.db-shm')
    expect(removeEntry).toHaveBeenCalledWith(expect.stringMatching(/^\.kmp-v6-user-1\.db\.import-staging-/))

    const importedBytes = new Uint8Array(await (await targetHandle.getFile()).arrayBuffer())
    expect([...importedBytes]).toEqual([...sqliteHeader, 1, 2, 3])
  })

  it('restores the write-ahead sidecars alongside the .db, and writes the .db LAST', async () => {
    // The whole defect: a backup taken with committed frames still in the
    // sidecars, restored as a lone `.db`, opens fine and reports
    // integrity_check ok with those transactions gone.
    const opfs = installFakeOpfs()

    await importRawSqliteDb(fakeRepo(), [
      fileWithStream([SQLITE_HEADER_BYTES, new Uint8Array([1, 2, 3])], 'backup.db'),
      fileWithStream([new Uint8Array([9, 9])], 'backup.db-wa0'),
    ], writeAheadSupported)

    expect([...opfs.bytes('kmp-v6-user-1.db')]).toEqual([...SQLITE_HEADER_BYTES, 1, 2, 3])
    expect([...opfs.bytes('kmp-v6-user-1.db-wa0')]).toEqual([9, 9])
    // Order matters on failure: until the `.db` exists the log beside it is
    // inert, so a crash part-way leaves "no database" rather than a database
    // that opens and is missing whatever the log held.
    expect(opfs.writes.indexOf('kmp-v6-user-1.db-wa0'))
      .toBeLessThan(opfs.writes.indexOf('kmp-v6-user-1.db'))
  })

  it('restores a recovery archive whole — the two ends round-trip', async () => {
    const dbBytes = concatChunks([SQLITE_HEADER_BYTES, new Uint8Array([4, 5, 6])])
    const waBytes = new Uint8Array([7, 7, 7, 7])

    const captured = installFakeOpfs({
      'kmp-v6-user-1.db': dbBytes,
      'kmp-v6-user-1.db-wa0': waBytes,
    })
    const backup = await getRawSqliteDbBackup('user-1')
    expect(backup.contents).toEqual(['kmp-v6-user-1.db', 'kmp-v6-user-1.db-wa0'])
    const archiveBytes = new Uint8Array(await backup.blob.arrayBuffer())
    expect(captured.bytes('kmp-v6-user-1.db')).toEqual(dbBytes) // capture read, not moved

    const restored = installFakeOpfs()
    // In small pieces, so the streaming extractor is actually streaming.
    await importRawSqliteDb(fakeRepo(), [fileWithStream(sliceInto(archiveBytes, 7), backup.filename)], writeAheadSupported)

    expect(restored.bytes('kmp-v6-user-1.db')).toEqual(dbBytes)
    expect(restored.bytes('kmp-v6-user-1.db-wa0')).toEqual(waBytes)
    // Staging is transient: nothing but the restored fileset is left behind.
    expect([...restored.names()].sort()).toEqual(['kmp-v6-user-1.db', 'kmp-v6-user-1.db-wa0'])
  })

  it('restores a deflated archive too — an unzip/rezip round trip is not stored', async () => {
    // Without a registered decompressor fflate throws "ctr is not a constructor".
    const dbBytes = concatChunks([SQLITE_HEADER_BYTES, new Uint8Array(64).fill(3)])
    const archive = zipSync({'x.db': dbBytes, 'x.db-wa1': new Uint8Array([8])}, {level: 6})
    const opfs = installFakeOpfs()

    await importRawSqliteDb(fakeRepo(), [fileWithStream(sliceInto(archive, 11), 'backup.zip')], writeAheadSupported)

    expect(opfs.bytes('kmp-v6-user-1.db')).toEqual(dbBytes)
    expect([...opfs.bytes('kmp-v6-user-1.db-wa1')]).toEqual([8])
  })

  it('refuses a truncated archive instead of restoring the members that survived', async () => {
    // fflate's streaming reader does not notice: it reports whatever local
    // headers arrived. Cut here it hands back `x.db` alone, complete and
    // convincing, and the sidecar simply is not there — the silent-subset
    // restore this whole path exists to prevent.
    const archive = zipSync({
      'x.db': concatChunks([SQLITE_HEADER_BYTES, new Uint8Array(200).fill(1)]),
      'x.db-wa0': new Uint8Array(40).fill(2),
    }, {level: 0})
    const opfs = installFakeOpfs()

    await expect(importRawSqliteDb(fakeRepo(), [
      fileWithStream(sliceInto(archive.slice(0, 260), 9), 'backup.zip'),
    ], writeAheadSupported)).rejects.toThrow(/truncated/)
    expect([...opfs.names()]).toEqual([])
  })

  it('refuses an archive whose directory lists a member the stream never carried', async () => {
    // The second member's local record is blanked, leaving every offset and the
    // directory itself intact — so the archive still validates structurally and
    // only the per-member reconciliation notices the gap.
    const dbBytes = concatChunks([SQLITE_HEADER_BYTES, new Uint8Array(120).fill(0x41)])
    const waBytes = new Uint8Array(80).fill(0x42)
    const archive = streamedZip([['x.db', dbBytes], ['x.db-wa0', waBytes]])
    const secondPayloadAt = archive.indexOf(0x42)
    archive.fill(0, secondPayloadAt - 30 - 'x.db-wa0'.length, secondPayloadAt + waBytes.length)
    const opfs = installFakeOpfs({'kmp-v6-user-1.db': new Uint8Array([9])})

    await expect(importRawSqliteDb(fakeRepo(), [fileWithStream(sliceInto(archive, 9), 'backup.zip')], writeAheadSupported))
      .rejects.toThrow(/damaged/)
    expect([...opfs.names()]).toEqual(['kmp-v6-user-1.db'])
  })

  it('refuses an archive whose member was cut short by a signature in its own bytes', async () => {
    // The framing this app actually writes: fflate's STREAMING `Zip` always sets
    // the data-descriptor flag and leaves the local header sizes at zero, so
    // `Unzip` cannot know where a member ends and scans the payload for the next
    // zip signature. A `.db` containing PK\x07\x08 therefore ends there. Silent
    // without this guard — a short `.db` still carries the SQLite magic, and a
    // short log simply reads as end-of-log. On a multi-GB database the sequence
    // is likelier to occur than not.
    //
    // `zipSync` does NOT reproduce it: it writes the sizes. That is exactly why
    // the tests around this one missed it, so build with the real writer.
    const dbBytes = concatChunks([SQLITE_HEADER_BYTES, new Uint8Array(600).fill(0x41)])
    dbBytes.set([0x50, 0x4b, 0x07, 0x08], 300)
    const archive = streamedZip([['x.db', dbBytes]])
    const opfs = installFakeOpfs({'kmp-v6-user-1.db': new Uint8Array([9])})

    await expect(importRawSqliteDb(fakeRepo(), [fileWithStream(sliceInto(archive, 64), 'recovery.zip')], writeAheadSupported))
      .rejects.toThrow(/should hold 616 bytes but 300 could be read/)
    expect([...opfs.names()]).toEqual(['kmp-v6-user-1.db'])
  })

  it('refuses an archive whose member content does not match its recorded checksum', async () => {
    // Same length, different bytes — only the directory's CRC sees this. It is
    // the one check that catches corruption which is neither truncation nor a
    // missing member.
    const dbBytes = concatChunks([SQLITE_HEADER_BYTES, new Uint8Array(400).fill(0x41)])
    const archive = streamedZip([['x.db', dbBytes]])
    const payloadAt = archive.indexOf(0x41)
    expect(payloadAt).toBeGreaterThan(0)
    archive[payloadAt] = 0x42
    const opfs = installFakeOpfs({'kmp-v6-user-1.db': new Uint8Array([9])})

    await expect(importRawSqliteDb(fakeRepo(), [fileWithStream(sliceInto(archive, 64), 'recovery.zip')], writeAheadSupported))
      .rejects.toThrow(/do not match its checksum/)
    expect([...opfs.names()]).toEqual(['kmp-v6-user-1.db'])
  })

  it('round-trips an archive from the real writer, whose framing the guards above are about', async () => {
    const dbBytes = concatChunks([SQLITE_HEADER_BYTES, new Uint8Array(500).fill(0x43)])
    const waBytes = new Uint8Array(300).fill(0x44)
    const archive = streamedZip([['x.db', dbBytes], ['x.db-wa0', waBytes]])
    const opfs = installFakeOpfs()

    await importRawSqliteDb(fakeRepo(), [fileWithStream(sliceInto(archive, 64), 'recovery.zip')], writeAheadSupported)

    expect(opfs.bytes('kmp-v6-user-1.db')).toEqual(dbBytes)
    expect(opfs.bytes('kmp-v6-user-1.db-wa0')).toEqual(waBytes)
  })

  it('refuses an unbootable sibling set inside an ARCHIVE, not just loose files', async () => {
    // The archive is the primary route and the loose files are the fallback,
    // but the whitelist was pinned only on the fallback — deleting its
    // archive-path call left every test green.
    const archive = streamedZip([
      ['x.db', concatChunks([SQLITE_HEADER_BYTES, new Uint8Array(40).fill(1)])],
      ['x.db-journal', new Uint8Array(16).fill(2)],
      ['x.db-wa0', new Uint8Array(16).fill(3)],
    ])
    const opfs = installFakeOpfs({'kmp-v6-user-1.db': new Uint8Array([9])})

    await expect(importRawSqliteDb(fakeRepo(), [fileWithStream(sliceInto(archive, 64), 'recovery.zip')], writeAheadSupported))
      .rejects.toThrow(/cannot be restored together/)
    expect([...opfs.names()]).toEqual(['kmp-v6-user-1.db'])
  })

  it('refuses a write-ahead backup on a browser that cannot open one', async () => {
    // Restoring the pair COMMITS the device to OPFSWriteAheadVFS — sidecar
    // existence outranks the probe at boot — so on Firefox/Safari this trades a
    // working database for one that cannot be opened, on a screen offering only
    // Reload. The recovery UI hands users this archive, and opening it in
    // another browser is a natural next move.
    const opfs = installFakeOpfs({'kmp-v6-user-1.db': new Uint8Array([9])})
    const unsupported = {probeWriteAheadSupport: async () => false}

    await expect(importRawSqliteDb(fakeRepo(), [
      fileWithStream([SQLITE_HEADER_BYTES], 'backup.db'),
      fileWithStream([new Uint8Array([1])], 'backup.db-wa0'),
    ], unsupported)).rejects.toThrow(/Chromium-based browser/)
    expect([...opfs.names()]).toEqual(['kmp-v6-user-1.db'])

    // Everything without sidecars must still restore there — the gate must not
    // become a blanket refusal on those browsers.
    await importRawSqliteDb(fakeRepo(), [
      fileWithStream([SQLITE_HEADER_BYTES], 'backup.db'),
      fileWithStream([new Uint8Array([4])], 'backup.db-journal'),
    ], unsupported)
    expect([...opfs.bytes('kmp-v6-user-1.db-journal')]).toEqual([4])
  })

  it('clears a pre-existing write-ahead log, not just the journals', async () => {
    // Importing a plain checkpointed `.db` over a live write-ahead database. A
    // surviving `-wa0` is NOT truncated on the next open (the `.db` exists, so
    // `isNewDatabase` is false), and the old database's frames get overlaid on
    // the freshly imported one. Nothing binds a frame to a `.db`.
    const opfs = installFakeOpfs({
      'kmp-v6-user-1.db': new Uint8Array([9]),
      'kmp-v6-user-1.db-wa0': new Uint8Array([1, 1]),
      'kmp-v6-user-1.db-wa1': new Uint8Array([2, 2]),
      'kmp-v6-user-1.db-journal': new Uint8Array([3]),
    })

    await importRawSqliteDb(fakeRepo(), [fileWithStream([SQLITE_HEADER_BYTES], 'fresh.db')], writeAheadSupported)

    expect([...opfs.names()]).toEqual(['kmp-v6-user-1.db'])
  })

  it('takes the whole set back down when the .db write fails, journal included', async () => {
    // The write-ahead pair is safe to strand — the VFS truncates orphaned
    // sidecars. A `-journal` is not: SQLite replays it onto the fresh database
    // the next boot creates, which is the corruption `dbFileSiblings` exists to
    // prevent. So a failed restore has to leave nothing, not "no database".
    const opfs = installFakeOpfs({}, {failWriteTo: 'kmp-v6-user-1.db'})

    await expect(importRawSqliteDb(fakeRepo(), [
      fileWithStream([SQLITE_HEADER_BYTES], 'backup.db'),
      fileWithStream([new Uint8Array([1, 2])], 'backup.db-journal'),
    ], writeAheadSupported)).rejects.toThrow(/no space/)

    expect([...opfs.names()]).toEqual([])
  })

  it('leaves a database it could not remove completely alone, journal included', async () => {
    // Another tab still holds the `.db`, so the removal throws and the old
    // database is INTACT. Tearing down its siblings on the way out would strip
    // committed frames from a database the user is then told was untouched —
    // the same loss as the bug this PR fixes, pointed the other way.
    const opfs = installFakeOpfs({
      'kmp-v6-user-1.db': new Uint8Array([9]),
      'kmp-v6-user-1.db-journal': new Uint8Array([8, 8]),
      'kmp-v6-user-1.db-wa0': new Uint8Array([7]),
    }, {failRemoveOf: 'kmp-v6-user-1.db'})

    await expect(importRawSqliteDb(fakeRepo(), [fileWithStream([SQLITE_HEADER_BYTES], 'backup.db')], writeAheadSupported))
      .rejects.toThrow(/locked/)

    expect([...opfs.names()].sort()).toEqual([
      'kmp-v6-user-1.db', 'kmp-v6-user-1.db-journal', 'kmp-v6-user-1.db-wa0',
    ])
    expect([...opfs.bytes('kmp-v6-user-1.db-journal')]).toEqual([8, 8])
  })

  it('restores only sibling sets this app can boot again, and destroys nothing first', async () => {
    // One class, not three cases: a fileset that restores cleanly and then
    // cannot open. Whitelisted rather than enumerated, because each new way to
    // reach it is invisible until someone hits it — a journal beside a
    // write-ahead log (a state no database has, refused at boot by
    // `prepareLocalDbForVfs`), and `-wal`/`-shm`, which only accompany a
    // WAL-mode database `OPFSWriteAheadVFS` cannot open at all.
    const opfs = installFakeOpfs({'kmp-v6-user-1.db': new Uint8Array([9])})
    const db = () => fileWithStream([SQLITE_HEADER_BYTES], 'backup.db')

    for (const rejected of ['backup.db-journal', 'backup.db-wal', 'backup.db-shm']) {
      await expect(importRawSqliteDb(fakeRepo(), [
        db(), fileWithStream([new Uint8Array([1])], rejected), fileWithStream([new Uint8Array([3])], 'backup.db-wa0'),
      ], writeAheadSupported)).rejects.toThrow(/cannot be restored together/)
    }
    await expect(importRawSqliteDb(fakeRepo(), [
      db(), fileWithStream([new Uint8Array([1])], 'backup.db-wal'),
    ], writeAheadSupported)).rejects.toThrow(/cannot be restored together/)

    // Untouched: the refusal comes before anything is destroyed.
    expect([...opfs.bytes('kmp-v6-user-1.db')]).toEqual([9])

    // Both legitimate shapes still restore.
    await importRawSqliteDb(fakeRepo(), [db(), fileWithStream([new Uint8Array([3])], 'backup.db-wa0')], writeAheadSupported)
    expect([...opfs.bytes('kmp-v6-user-1.db-wa0')]).toEqual([3])
    await importRawSqliteDb(fakeRepo(), [db(), fileWithStream([new Uint8Array([4])], 'backup.db-journal')], writeAheadSupported)
    expect([...opfs.bytes('kmp-v6-user-1.db-journal')]).toEqual([4])
  })

  it('refuses the sibling-only archive that capture can emit, database intact', async () => {
    // `getRawSqliteDbBackup` bundles a journal with content even when the `.db`
    // is 0 bytes. That archive is forensic — writing a journal back with no
    // database is the replay-onto-a-fresh-`.db` corruption `dbFileSiblings`
    // exists to prevent — so restore must refuse it, and refuse it before the
    // database on the device is touched.
    const opfs = installFakeOpfs({'kmp-v6-user-1.db': new Uint8Array([9])})
    const archive = zipSync({'kmp-v6-user-1.db-journal': new Uint8Array(32).fill(1)}, {level: 0})

    await expect(importRawSqliteDb(fakeRepo(), [fileWithStream(sliceInto(archive, 9), 'recovery.zip')], writeAheadSupported))
      .rejects.toThrow(/not a SQLite database/)
    expect([...opfs.names()]).toEqual(['kmp-v6-user-1.db'])
  })

  it('refuses a WAL-mode database, which no sibling rule can see', async () => {
    // The mode lives in the `.db` header, so a bare file carries it in with no
    // siblings at all. `OPFSWriteAheadVFS` throws on SQLITE_OPEN_WAL, so this
    // would trade a working database for one that cannot be opened.
    const opfs = installFakeOpfs({'kmp-v6-user-1.db': new Uint8Array([9])})
    const walHeader = new Uint8Array(20)
    walHeader.set(SQLITE_HEADER_BYTES)
    walHeader[18] = 2
    walHeader[19] = 2

    await expect(importRawSqliteDb(fakeRepo(), [fileWithStream([walHeader], 'wal-mode.db')], writeAheadSupported))
      .rejects.toThrow(/WAL journal mode/)
    expect([...opfs.bytes('kmp-v6-user-1.db')]).toEqual([9])

    // The legacy value in the same field must still import.
    const legacy = new Uint8Array(20)
    legacy.set(SQLITE_HEADER_BYTES)
    legacy[18] = 1
    legacy[19] = 1
    await importRawSqliteDb(fakeRepo(), [fileWithStream([legacy], 'rollback.db')], writeAheadSupported)
    expect([...opfs.bytes('kmp-v6-user-1.db')]).toEqual([...legacy])
  })

  it('refuses a selection that is not one database and its own siblings', async () => {
    const opfs = installFakeOpfs()
    const db = fileWithStream([SQLITE_HEADER_BYTES], 'backup.db')

    await expect(importRawSqliteDb(fakeRepo(), [db, fileWithStream([new Uint8Array([1])], 'notes.txt')], writeAheadSupported))
      .rejects.toThrow(/together with the/)
    // A second copy of the same name would silently restore one of the two.
    await expect(importRawSqliteDb(fakeRepo(), [db, db], writeAheadSupported)).rejects.toThrow(/together with the/)
    expect([...opfs.names()]).toEqual([])
  })
})

const SQLITE_HEADER_BYTES = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20,
  0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
])

const fakeRepo = () => ({user: {id: 'user-1'}, db: {close: vi.fn(async () => {})}} as unknown as Repo)

/**
 * Restoring a write-ahead pair is refused where the browser cannot open one, so
 * every test that is not ABOUT that gate states the supported answer rather
 * than reaching for the real probe worker.
 */
const writeAheadSupported = {probeWriteAheadSupport: async () => true}

/**
 * An archive built the way `streamStoredZipToOpfs` builds one — streaming `Zip`
 * with `ZipPassThrough`, which frames members with DATA DESCRIPTORS. `zipSync`
 * writes the sizes into each local header instead, a framing the reader handles
 * very differently, so it cannot stand in for the real writer here.
 */
const streamedZip = (entries: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array<ArrayBuffer> => {
  const parts: Array<Uint8Array<ArrayBuffer>> = []
  const zip = new Zip((err, chunk) => {
    if (err) throw err
    if (chunk?.length) parts.push(new Uint8Array(chunk))
  })
  for (const [name, bytes] of entries) {
    const passthrough = new ZipPassThrough(name)
    zip.add(passthrough)
    passthrough.push(bytes, true)
  }
  zip.end()
  return concatChunks(parts) as Uint8Array<ArrayBuffer>
}

const sliceInto = (bytes: Uint8Array, size: number): Array<Uint8Array<ArrayBuffer>> => {
  const chunks: Array<Uint8Array<ArrayBuffer>> = []
  for (let i = 0; i < bytes.length; i += size) chunks.push(new Uint8Array(bytes.subarray(i, i + size)))
  return chunks
}

/**
 * An in-memory OPFS root, installed on `navigator.storage`. The import path
 * creates, streams into, reads back and removes real files across several
 * names, which the per-test hand-rolled handles above cannot express.
 */
const installFakeOpfs = (
  initial: Record<string, Uint8Array> = {},
  {failWriteTo, failRemoveOf}: {failWriteTo?: string; failRemoveOf?: string} = {},
) => {
  const files = new Map(Object.entries(initial).map(([n, b]) => [n, b] as const))
  const writes: string[] = []

  const root = {
    getFileHandle: async (name: string, opts?: {create?: boolean}) => {
      if (!files.has(name)) {
        if (!opts?.create) throw new DOMException('not found', 'NotFoundError')
        files.set(name, new Uint8Array(0))
      }
      return {
        // Both surfaces the real FileSystemWritableFileStream has: a
        // WritableStream for `pipeTo`, plus direct write/close/abort, which is
        // what the streaming zip paths use.
        createWritable: async () => {
          const chunks: Uint8Array[] = []
          const stream = new WritableStream<Uint8Array>({
            write: chunk => {
              if (name === failWriteTo) throw new DOMException('no space', 'QuotaExceededError')
              chunks.push(new Uint8Array(chunk))
            },
            close: () => {
              files.set(name, concatChunks(chunks))
              writes.push(name)
            },
          })
          let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
          const held = () => (writer ??= stream.getWriter())
          return Object.assign(stream, {
            write: (chunk: Uint8Array) => held().write(chunk),
            close: () => held().close(),
            abort: () => held().abort(),
          }) as unknown as FileSystemWritableFileStream
        },
        getFile: async () => fileWithStream([new Uint8Array(files.get(name)!)], name),
      }
    },
    removeEntry: async (name: string) => {
      // What another tab holding the OPFS sync access handle produces.
      if (name === failRemoveOf) throw new DOMException('locked', 'NoModificationAllowedError')
      if (!files.delete(name)) throw new DOMException('not found', 'NotFoundError')
    },
  }

  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {getDirectory: async () => root, estimate: async () => ({quota: 1e9, usage: 0})},
  })

  return {
    writes,
    names: () => [...files.keys()],
    bytes: (name: string) => files.get(name)!,
  }
}

const createCapturingFileHandle = (name: string, events: string[]) => {
  let chunks: BlobPart[] = []
  return {
    createWritable: vi.fn(async () => {
      chunks = []
      return new WritableStream({
        write(chunk) {
          events.push(`write:${name}`)
          chunks.push(chunk as BlobPart)
        },
        close() {
          events.push(`close:${name}`)
        },
      }) as FileSystemWritableFileStream
    }),
    getFile: vi.fn(async () => fileWithStream(chunks, name)),
  } as unknown as FileSystemFileHandle & { getFile: () => Promise<File> }
}

const fileWithStream = (parts: BlobPart[], name: string): File => {
  const file = new File(parts, name)
  Object.defineProperty(file, 'stream', {
    configurable: true,
    value: () => new ReadableStream({
      start(controller) {
        for (const part of parts) {
          if (part instanceof Uint8Array) {
            controller.enqueue(part)
          } else if (typeof part === 'string') {
            controller.enqueue(new TextEncoder().encode(part))
          } else {
            throw new Error('test fileWithStream only supports string and Uint8Array parts')
          }
        }
        controller.close()
      },
    }),
  })
  return file
}

describe('getRawSqliteDbBackup', () => {
  it('returns a plain .db when there are no journal siblings', async () => {
    const dbFile = fakeFile(new Uint8Array([1, 2, 3, 4]))
    const getFileHandle = vi.fn(async (name: string) => {
      if (name === 'kmp-v6-user-1.db') return { getFile: async () => dbFile }
      throw new DOMException('not found', 'NotFoundError') // siblings absent
    })
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: async () => ({ getFileHandle }) },
    })

    const result = await getRawSqliteDbBackup('user-1')

    expect(result.contents).toEqual(['kmp-v6-user-1.db'])
    expect(result.filename).toMatch(/^kmp-v6-user-1-export-\d+\.db$/)
    expect(result.blob).toBe(dbFile)
    expect(result.cleanup).toBeUndefined()
  })

  it('bundles the .db plus existing journal siblings into a .zip with original names', async () => {
    const dbBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const journalBytes = new Uint8Array([9, 9, 9])
    const files: Record<string, Uint8Array> = {
      'kmp-v6-user-1.db': dbBytes,
      'kmp-v6-user-1.db-journal': journalBytes,
    }
    const written: Uint8Array[] = []
    const removeEntry = vi.fn(async () => {})
    const getFileHandle = vi.fn(async (name: string, opts?: { create?: boolean }) => {
      if (opts?.create) {
        // The OPFS temp zip target: capture the streamed bytes, hand them back.
        return {
          createWritable: async () => ({
            write: async (chunk: Uint8Array) => { written.push(chunk.slice()) },
            close: async () => {},
          }),
          getFile: async () => ({ arrayBuffer: async () => concatChunks(written).buffer }),
        }
      }
      if (name in files) return { getFile: async () => fakeFile(files[name]) }
      throw new DOMException('not found', 'NotFoundError') // -wal / -shm absent
    })
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: async () => ({ getFileHandle, removeEntry }),
        estimate: async () => ({ quota: 1e9, usage: 0 }),
      },
    })

    const result = await getRawSqliteDbBackup('user-1')

    expect(result.filename).toMatch(/^kmp-v6-user-1-recovery-\d+\.zip$/)
    expect(result.contents).toEqual(['kmp-v6-user-1.db', 'kmp-v6-user-1.db-journal'])
    // The bundle is a real, valid zip — round-trip it and check the bytes.
    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    expect(Object.keys(unzipped).sort()).toEqual([
      'kmp-v6-user-1.db',
      'kmp-v6-user-1.db-journal',
    ])
    expect(unzipped['kmp-v6-user-1.db']).toEqual(dbBytes)
    expect(unzipped['kmp-v6-user-1.db-journal']).toEqual(journalBytes)
  })

  it('throws only when the .db AND every sibling are empty', async () => {
    const getFileHandle = vi.fn(async (name: string) => {
      if (name === 'kmp-v6-user-1.db') return { getFile: async () => fakeFile(new Uint8Array(0)) }
      throw new DOMException('not found', 'NotFoundError') // siblings absent
    })
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: async () => ({ getFileHandle }) },
    })

    await expect(getRawSqliteDbBackup('user-1')).rejects.toThrow(/empty/)
  })

  it('still backs up a non-empty journal when the main .db is 0 bytes', async () => {
    // The reset deletes the siblings, so an empty .db next to a journal with
    // recoverable pages must NOT reject — bundle the journal (the .db is omitted).
    const journalBytes = new Uint8Array([7, 7, 7, 7])
    const written: Uint8Array[] = []
    const getFileHandle = vi.fn(async (name: string, opts?: { create?: boolean }) => {
      if (opts?.create) {
        return {
          createWritable: async () => ({
            write: async (chunk: Uint8Array) => { written.push(chunk.slice()) },
            close: async () => {},
          }),
          getFile: async () => ({ arrayBuffer: async () => concatChunks(written).buffer }),
        }
      }
      if (name === 'kmp-v6-user-1.db') return { getFile: async () => fakeFile(new Uint8Array(0)) }
      if (name === 'kmp-v6-user-1.db-journal') return { getFile: async () => fakeFile(journalBytes) }
      throw new DOMException('not found', 'NotFoundError') // -wal / -shm absent
    })
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: async () => ({ getFileHandle, removeEntry: vi.fn(async () => {}) }),
        estimate: async () => ({ quota: 1e9, usage: 0 }),
      },
    })

    const result = await getRawSqliteDbBackup('user-1')

    expect(result.filename).toMatch(/\.zip$/)
    expect(result.contents).toEqual(['kmp-v6-user-1.db-journal']) // empty .db excluded
    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    expect(Object.keys(unzipped)).toEqual(['kmp-v6-user-1.db-journal'])
    expect(unzipped['kmp-v6-user-1.db-journal']).toEqual(journalBytes)
  })
})

describe('removeRecoveryBackupTemps', () => {
  it('removes only this user\'s recovery-zip temp files, nothing else', async () => {
    const names = [
      '.kmp-v6-user-1.db.recovery-zip-123-abc.tmp', // match
      '.kmp-v6-user-1.db.recovery-zip-456-def.tmp', // match
      '.kmp-v6-user-1.db.export-snapshot-1-x.tmp', // different purpose → keep
      '.kmp-v6-user-2.db.recovery-zip-1-y.tmp', // other user → keep
      'kmp-v6-user-1.db', // the db itself → keep
    ]
    const removed: string[] = []
    const removeEntry = vi.fn(async (n: string) => { removed.push(n) })
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: async () => ({
          keys: async function* () { for (const n of names) yield n },
          removeEntry,
        }),
      },
    })

    await removeRecoveryBackupTemps('user-1')

    expect(removed.sort()).toEqual([
      '.kmp-v6-user-1.db.recovery-zip-123-abc.tmp',
      '.kmp-v6-user-1.db.recovery-zip-456-def.tmp',
    ])
  })
})

describe('deleteLocalSqliteDb', () => {
  it('removes SQLite journals before the .db and the write-ahead pair after it', async () => {
    const removeEntry = vi.fn<(name: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: vi.fn(async () => ({ removeEntry })) },
    })

    await deleteLocalSqliteDb('user-1')

    // SQLite's journals before the .db, because a fresh boot must never find the
    // .db missing next to a replayable one. The write-ahead pair goes AFTER,
    // because the other order strips committed frames from a database that
    // survives — and a surviving log is harmless, the VFS truncates both when it
    // opens a .db that does not exist.
    const removed = removeEntry.mock.calls.map(c => c[0])
    expect(removed).toEqual([
      'kmp-v6-user-1.db-journal',
      'kmp-v6-user-1.db-wal',
      'kmp-v6-user-1.db-shm',
      'kmp-v6-user-1.db',
      'kmp-v6-user-1.db-wa0',
      'kmp-v6-user-1.db-wa1',
    ])
  })

  it('tolerates missing files (NotFoundError) on siblings and the .db', async () => {
    const removeEntry = vi.fn<(name: string) => Promise<void>>(async () => {
      throw new DOMException('not found', 'NotFoundError')
    })
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: vi.fn(async () => ({ removeEntry })) },
    })

    await expect(deleteLocalSqliteDb('user-1')).resolves.toBeUndefined()
    expect(removeEntry).toHaveBeenCalledTimes(6)
  })

  it('leaves the .db in place (and throws) when a journal sibling cannot be deleted', async () => {
    const removeEntry = vi.fn<(name: string) => Promise<void>>(async (name) => {
      if (name.endsWith('-wal')) {
        throw new DOMException('locked', 'NoModificationAllowedError')
      }
    })
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: vi.fn(async () => ({ removeEntry })) },
    })

    await expect(deleteLocalSqliteDb('user-1')).rejects.toThrow(/locked by another open tab/)
    // Critical: the main .db must NOT be deleted, or a fresh boot would replay -wal.
    const removed = removeEntry.mock.calls.map(c => c[0])
    expect(removed).not.toContain('kmp-v6-user-1.db')
  })
})
