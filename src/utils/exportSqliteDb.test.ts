// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import { exportRawSqliteDb } from './exportSqliteDb'

const originalStorage = navigator.storage

afterEach(() => {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: originalStorage,
  })
})

describe('exportRawSqliteDb', () => {
  it('exports the OPFS File directly without materializing the database as an ArrayBuffer', async () => {
    const dbFile = new File(['sqlite-data'], 'kmp-v6-user-1.db')
    const arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer should not be used for SQLite export')
    })
    Object.defineProperty(dbFile, 'arrayBuffer', {
      configurable: true,
      value: arrayBuffer,
    })

    const getFile = vi.fn(async () => dbFile)
    const getFileHandle = vi.fn(async () => ({ getFile }))
    const getDirectory = vi.fn(async () => ({ getFileHandle }))
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory },
    })

    const result = await exportRawSqliteDb({
      user: { id: 'user-1' },
    } as unknown as Repo)

    expect(getFileHandle).toHaveBeenCalledWith('kmp-v6-user-1.db')
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(result.blob).toBe(dbFile)
    expect(result.filename).toMatch(/^kmp-v6-user-1-export-\d+\.db$/)
  })
})
