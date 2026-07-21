// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import type { Repo } from '@/data/repo'
import {
  deleteLocalSqliteDb,
  exportRawSqliteDb,
  getRawSqliteDbBackup,
  importRawSqliteDb,
  removeRecoveryBackupTemps,
} from './exportSqliteDb'

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
  it('copies the OPFS file under PowerSync readLock before returning a blob', async () => {
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

    const readLock = vi.fn(async <T,>(fn: () => Promise<T>) => fn())
    const result = await exportRawSqliteDb({
      user: {id: 'user-1'},
      db: {readLock},
    } as unknown as Repo)

    expect(getFileHandle).toHaveBeenCalledWith('kmp-v6-user-1.db')
    expect(getFileHandle).toHaveBeenCalledWith(
      expect.stringMatching(/^\.kmp-v6-user-1\.db\.export-snapshot-/),
      {create: true},
    )
    expect(readLock).toHaveBeenCalledOnce()
    expect(sourceFile.arrayBuffer).not.toHaveBeenCalled()
    expect(sourceFile.stream).toHaveBeenCalledOnce()
    expect(snapshotHandle.createWritable).toHaveBeenCalledWith({keepExistingData: false})
    expect(pipeTo).toHaveBeenCalledWith(snapshotWritable)
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
    const readLock = vi.fn(async <T,>(fn: () => Promise<T>) => fn())

    const promise = exportRawSqliteDb({
      user: {id: 'user-1'},
      db: {readLock},
    } as unknown as Repo)

    await expect(promise).rejects.toThrow(/Not enough browser storage/)
    await expect(promise).rejects.toThrow(/100\.0 MiB/) // required
    await expect(promise).rejects.toThrow(/20\.0 MiB/) // available
    // Bails before locking the DB or creating the doomed snapshot file.
    expect(readLock).not.toHaveBeenCalled()
    expect(getFileHandle).not.toHaveBeenCalledWith(
      expect.stringContaining('export-snapshot'),
      {create: true},
    )
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
    const readLock = vi.fn(async <T,>(fn: () => Promise<T>) => fn())

    const error: Error = await exportRawSqliteDb({
      user: {id: 'user-1'},
      db: {readLock},
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
    } as unknown as Repo, file)).rejects.toThrow(
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
    } as unknown as Repo, file)

    expect(close).toHaveBeenCalledOnce()
    expect(events.indexOf('db.close')).toBeGreaterThan(events.indexOf('close:staging.db'))
    expect(removeEntry).toHaveBeenCalledWith('kmp-v6-user-1.db-journal')
    expect(removeEntry).toHaveBeenCalledWith('kmp-v6-user-1.db-wal')
    expect(removeEntry).toHaveBeenCalledWith('kmp-v6-user-1.db-shm')
    expect(removeEntry).toHaveBeenCalledWith(expect.stringMatching(/^\.kmp-v6-user-1\.db\.import-staging-/))

    const importedBytes = new Uint8Array(await (await targetHandle.getFile()).arrayBuffer())
    expect([...importedBytes]).toEqual([...sqliteHeader, 1, 2, 3])
  })
})

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
  it('removes the -journal/-wal/-shm siblings BEFORE the .db, nothing else', async () => {
    const removeEntry = vi.fn<(name: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: vi.fn(async () => ({ removeEntry })) },
    })

    await deleteLocalSqliteDb('user-1')

    // Siblings first so the .db is only removed once they're gone — a fresh boot
    // can never find the .db missing next to a replayable -wal/-journal.
    const removed = removeEntry.mock.calls.map(c => c[0])
    expect(removed).toEqual([
      'kmp-v6-user-1.db-journal',
      'kmp-v6-user-1.db-wal',
      'kmp-v6-user-1.db-shm',
      'kmp-v6-user-1.db',
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
    expect(removeEntry).toHaveBeenCalledTimes(4)
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
