// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WRITE_AHEAD_HEADROOM_BYTES,
  awaitWriteAheadHeadroom,
  checkpointResultPages,
  drainWriteAheadLog,
  onWriteAheadPause,
  type WriteAheadPause,
} from './writeAheadLog.ts'

/** What `OPFSWriteAheadVFS` answers `PRAGMA wal_checkpoint`: one cell whose
 *  column NAME is also its value, the approximate un-checkpointed page count. */
const vfsPages = (pages: number) => ({rows: {_array: [{[String(pages)]: String(pages)}]}})
/** SQLite's own answer in rollback-journal mode — every CoopSync device. */
const SQLITE_ROLLBACK_ANSWER = {rows: {_array: [{busy: 0, log: -1, checkpointed: -1}]}}

const FRAME_HEADER_BYTES = 32

/** A writer whose answers are scripted per statement; records every statement. */
const scriptedDb = (answers: {
  noop?: unknown
  pageSize?: number
  truncate?: () => Promise<unknown>
}) => {
  const executed: string[] = []
  const db = {
    execute: vi.fn(async (sql: string) => {
      executed.push(sql)
      if (sql === 'PRAGMA wal_checkpoint=noop') return answers.noop
      if (sql === 'PRAGMA page_size') return {rows: {_array: [{page_size: answers.pageSize ?? 4096}]}}
      if (sql === 'PRAGMA wal_checkpoint=truncate') return answers.truncate?.()
      return undefined
    }),
  }
  return {db, executed}
}

const pagesOver = (limitBytes: number, pageSize = 4096) =>
  Math.ceil(limitBytes / (pageSize + FRAME_HEADER_BYTES)) + 1

const recordPauses = () => {
  const pauses: (WriteAheadPause | null)[] = []
  const off = onWriteAheadPause(pause => { pauses.push(pause) })
  return {pauses, off}
}

afterEach(() => { vi.restoreAllMocks() })

describe('checkpointResultPages', () => {
  it('reads the VFS\'s page count, and SQLite\'s own answer as nothing outstanding', () => {
    expect(checkpointResultPages(vfsPages(1234))).toBe(1234)
    expect(checkpointResultPages(SQLITE_ROLLBACK_ANSWER)).toBe(0)
  })

  it('is null for an answer it cannot read, so each caller picks its own safe side', () => {
    expect(checkpointResultPages(undefined)).toBeNull()
    expect(checkpointResultPages({rows: {_array: []}})).toBeNull()
    expect(checkpointResultPages({rows: {_array: [{n: 'many'}]}})).toBeNull()
  })
})

describe('awaitWriteAheadHeadroom', () => {
  it('lets the next batch through without checkpointing while the log is under the limit', async () => {
    const {db, executed} = scriptedDb({noop: vfsPages(1000)})
    const {pauses, off} = recordPauses()

    await awaitWriteAheadHeadroom(db)
    off()

    expect(executed).not.toContain('PRAGMA wal_checkpoint=truncate')
    expect(pauses).toEqual([])
  })

  it('holds the writer in a truncate checkpoint once the log passes the limit, and says so for exactly that long', async () => {
    let finish!: () => void
    const truncating = new Promise<void>(resolve => { finish = resolve })
    const pages = pagesOver(WRITE_AHEAD_HEADROOM_BYTES)
    const {db, executed} = scriptedDb({noop: vfsPages(pages), truncate: () => truncating})
    const {pauses, off} = recordPauses()

    let returned = false
    const waiting = awaitWriteAheadHeadroom(db).then(() => { returned = true })
    await vi.waitFor(() => expect(executed).toContain('PRAGMA wal_checkpoint=truncate'))

    // The checkpoint waits out every read still in flight; the batch must too.
    expect(returned).toBe(false)
    expect(pauses).toEqual([{logBytes: pages * (4096 + FRAME_HEADER_BYTES)}])

    finish()
    await waiting
    off()
    expect(pauses).toEqual([{logBytes: pages * (4096 + FRAME_HEADER_BYTES)}, null])
  })

  it('measures the limit in bytes of the database\'s own page size', async () => {
    // Under the limit at 4 KiB pages, over it at 64 KiB.
    const pages = pagesOver(WRITE_AHEAD_HEADROOM_BYTES, 65536)
    expect(pages * (4096 + FRAME_HEADER_BYTES)).toBeLessThan(WRITE_AHEAD_HEADROOM_BYTES)

    const small = scriptedDb({noop: vfsPages(pages), pageSize: 4096})
    await awaitWriteAheadHeadroom(small.db)
    expect(small.executed).not.toContain('PRAGMA wal_checkpoint=truncate')

    const large = scriptedDb({noop: vfsPages(pages), pageSize: 65536})
    await awaitWriteAheadHeadroom(large.db)
    expect(large.executed).toContain('PRAGMA wal_checkpoint=truncate')
  })

  it('never pauses where the answer is SQLite\'s own, or unreadable', async () => {
    for (const noop of [SQLITE_ROLLBACK_ANSWER, undefined, {rows: {_array: [{n: 'many'}]}}]) {
      const {db, executed} = scriptedDb({noop})
      await awaitWriteAheadHeadroom(db, 1)
      expect(executed).not.toContain('PRAGMA wal_checkpoint=truncate')
    }
  })

  it('a checkpoint that fails does not fail the write it was protecting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const {db} = scriptedDb({
      noop: vfsPages(pagesOver(WRITE_AHEAD_HEADROOM_BYTES)),
      truncate: () => Promise.reject(new Error('checkpoint failed')),
    })
    const {pauses, off} = recordPauses()

    await expect(awaitWriteAheadHeadroom(db)).resolves.toBeUndefined()
    off()

    expect(pauses.at(-1)).toBeNull()
    expect(console.warn).toHaveBeenCalled()
  })
})

/**
 * The rules of wa-sqlite 1.7.0's `WriteAhead.js` that decide which log file
 * holds bytes, as a model the drain's statements can be replayed against:
 *
 *  - A write first swaps to the other file, but only when the un-checkpointed
 *    page count has reached `journal_size_limit` (≤ 0 means 1000) AND the
 *    other file is empty (`write`, `#isInactiveFileEmpty`).
 *  - After each commit a PASSIVE checkpoint copies the inactive file's
 *    transactions and truncates that file — unless a read is still in flight
 *    (`checkpoint` with `isPassive`).
 *  - A TRUNCATE checkpoint first waits out every read, then copies every
 *    transaction in both files, and truncates only the INACTIVE one.
 *
 * So the active file keeps whatever bytes it has until a swap moves the writer
 * off it. The model leaves out what the drain cannot change: transaction ids,
 * page contents, which reader holds what.
 */
class WriteAheadModel {
  static readonly FILE_HEADER = 32
  static readonly FRAME = 4096 + FRAME_HEADER_BYTES
  readonly files: {bytes: number; pendingPages: number}[]
  active: number
  journalSizeLimit = -1
  readHeld: boolean

  constructor(state: {files: {bytes: number; pendingPages: number}[]; active: number; readHeld: boolean}) {
    this.files = state.files.map(file => ({...file}))
    this.active = state.active
    this.readHeld = state.readHeld
  }

  get inactive() { return this.files[1 - this.active]! }
  get pendingPages() { return this.files.reduce((sum, file) => sum + file.pendingPages, 0) }

  write(pages: number): void {
    const limit = this.journalSizeLimit > 0 ? this.journalSizeLimit : 1000
    if (this.pendingPages >= limit && this.inactive.bytes === 0) {
      this.active = 1 - this.active
      this.files[this.active] = {bytes: WriteAheadModel.FILE_HEADER, pendingPages: 0}
    }
    const file = this.files[this.active]!
    file.bytes += pages * WriteAheadModel.FRAME
    file.pendingPages += pages
    if (!this.readHeld && this.inactive.pendingPages > 0) {
      this.inactive.pendingPages = 0
      this.inactive.bytes = 0
    }
  }

  truncateCheckpoint(): void {
    this.readHeld = false
    for (const file of this.files) file.pendingPages = 0
    this.inactive.bytes = 0
  }

  execute = async (sql: string): Promise<unknown> => {
    const limit = /^PRAGMA journal_size_limit=(-?\d+)$/.exec(sql)
    if (limit) { this.journalSizeLimit = Number(limit[1]); return undefined }
    if (sql === 'PRAGMA wal_checkpoint=truncate') { this.truncateCheckpoint(); return undefined }
    if (sql === 'PRAGMA wal_checkpoint=noop') return vfsPages(this.pendingPages)
    if (/^(INSERT|UPDATE|DELETE)\b/.test(sql)) {
      // Page 1 (the change counter) plus the leaf the row lives on.
      this.write(2)
      return undefined
    }
    throw new Error(`the model does not know: ${sql}`)
  }
}

describe('drainWriteAheadLog', () => {
  const GB = 1024 ** 3
  // Where a held read leaves things: the writer stuck on a file of
  // gigabytes, the other file still owed to a checkpoint the read blocked.
  const afterAHeldRead = {
    files: [{bytes: 5_000_000, pendingPages: 1_200}, {bytes: 1.8 * GB, pendingPages: 400_000}],
    active: 1,
    readHeld: true,
  }

  it('leaves both log files small, however large the active one was', async () => {
    const model = new WriteAheadModel(afterAHeldRead)

    await drainWriteAheadLog(model)

    expect(model.files[model.active]!.bytes).toBeLessThan(64 * 1024)
    expect(model.inactive.bytes).toBe(0)
    expect(model.pendingPages).toBe(0)
  })

  it('also when the read had ended before the drain began', async () => {
    const model = new WriteAheadModel({...afterAHeldRead, readHeld: false})

    await drainWriteAheadLog(model)

    expect(model.files[model.active]!.bytes).toBeLessThan(64 * 1024)
    expect(model.inactive.bytes).toBe(0)
  })

  it('hands the writer back its normal swap threshold', async () => {
    const model = new WriteAheadModel(afterAHeldRead)

    await drainWriteAheadLog(model)

    expect(model.journalSizeLimit).toBeLessThanOrEqual(0)
  })

  it('hands it back even when a write fails partway', async () => {
    const model = new WriteAheadModel(afterAHeldRead)
    const execute = model.execute
    const db = {
      execute: async (sql: string) => {
        if (sql.startsWith('DELETE')) throw new Error('disk full')
        return execute(sql)
      },
    }

    await expect(drainWriteAheadLog(db)).rejects.toThrow('disk full')

    expect(model.journalSizeLimit).toBeLessThanOrEqual(0)
  })
})
