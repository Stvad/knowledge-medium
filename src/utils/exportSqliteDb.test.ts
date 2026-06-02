// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import { exportRawSqliteDb, importRawSqliteDb } from './exportSqliteDb'

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
