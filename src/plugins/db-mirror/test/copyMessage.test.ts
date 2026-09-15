/**
 * The mirror's default export seam, which every other test replaces.
 *
 * Its own file because the module mock is hoisted per file, and `mirror.test.ts`
 * needs the real seam to drive the write path.
 */
import {describe, expect, it, vi} from 'vitest'
import type {Repo} from '@/data/repo'
import {exportRawSqliteDbToFile} from '@/utils/exportSqliteDb.js'
import {runDbMirror} from '../mirror.js'
import {FakeDirectoryHandle} from './fakeFileSystem.js'

vi.mock('@/utils/exportSqliteDb.js', () => ({
  exportRawSqliteDbToFile: vi.fn(
    async (_repo: Repo, handle: FileSystemFileHandle) => {
      const writable = await handle.createWritable()
      await new Blob([new Uint8Array(256)]).stream().pipeTo(writable)
      return {filename: handle.name, size: 256}
    },
  ),
}))

const repo = {
  user: {id: 'alice'},
  db: {getAll: async () => [{marker: 1, n: 0, last: null}]},
} as unknown as Repo

describe('the mirror’s copy', () => {
  it('asks the export for a deadline message written for a background job', async () => {
    // Left to the default the user would be told to close their other tabs and
    // reload — advice for someone waiting on a button, and wrong for the cause
    // a scheduled copy actually hits.
    await runDbMirror({
      repo,
      directory: new FakeDirectoryHandle().asHandle(),
      keepCount: 1,
      now: Date.UTC(2026, 8, 4),
      installId: 'a1b2c3d4',
      incarnation: '1700000000000',
    })

    expect(exportRawSqliteDbToFile).toHaveBeenCalledWith(
      repo,
      expect.anything(),
      {timeoutMessage: expect.stringContaining('background copy')},
    )
  })
})
