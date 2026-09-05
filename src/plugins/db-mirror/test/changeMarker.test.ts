// @vitest-environment node
import {describe, expect, it, vi} from 'vitest'
import {
  readChangeMarker,
  readDatabaseIncarnation,
  type ChangeMarkerSource,
} from '../changeMarker.js'

const source = (
  answers: {blocks?: unknown; queue?: unknown; rejected?: unknown; born?: unknown} = {},
): ChangeMarkerSource => ({
  db: {
    getAll: (async (sql: string) => {
      const answer = sql.includes('ps_crud_rejected')
        ? answers.rejected ?? answers.queue
        : sql.includes('ps_crud')
          ? answers.queue
          : sql.includes('ORDER BY id LIMIT 1')
            ? answers.born
            : answers.blocks
      if (answer instanceof Error) throw answer
      return answer ?? []
    }) as ChangeMarkerSource['db']['getAll'],
  },
})

/** A log with real rows in id order, so the two candidate queries give
 *  DIFFERENT answers — which is the only way a test can say which one the
 *  identity is read with. */
const logSource = (rows: number[]): ChangeMarkerSource => ({
  db: {
    getAll: (async (sql: string) => {
      if (sql.includes('MIN(created_at)')) return [{born: Math.min(...rows)}]
      if (sql.includes('ORDER BY id LIMIT 1')) return [{born: rows[0]}]
      return []
    }) as ChangeMarkerSource['db']['getAll'],
  },
})

describe('readChangeMarker', () => {
  it('moves when a block changes', async () => {
    const before = await readChangeMarker(source({blocks: [{marker: 10}], queue: [{n: 0, last: null}]}))
    const after = await readChangeMarker(source({blocks: [{marker: 11}], queue: [{n: 0, last: null}]}))
    expect(after).not.toBe(before)
  })

  it('moves when the upload queue drains, even though no block changed', async () => {
    // Draining writes nothing to `blocks`, so on the block reading alone a copy
    // taken with an upload still pending would stay the newest one forever once
    // the user stopped editing — and restoring it replays a patch that has
    // already been applied, over a value another device may have changed since.
    const pending = await readChangeMarker(source({blocks: [{marker: 10}], queue: [{n: 1, last: 7}]}))
    const drained = await readChangeMarker(source({blocks: [{marker: 10}], queue: [{n: 0, last: null}]}))
    expect(drained).not.toBe(pending)
  })

  it('moves when a dismissed rejection changes, which the Retry button can re-upload', async () => {
    const before = await readChangeMarker(
      source({blocks: [{marker: 10}], queue: [{n: 0, last: null}], rejected: [{n: 1, last: 3}]}),
    )
    const after = await readChangeMarker(
      source({blocks: [{marker: 10}], queue: [{n: 0, last: null}], rejected: [{n: 0, last: null}]}),
    )
    expect(after).not.toBe(before)
  })

  it('moves when the queue gained and drained an entry between readings', async () => {
    // The count is back to where it was; only the id says anything happened.
    const before = await readChangeMarker(source({blocks: [{marker: 10}], queue: [{n: 1, last: 7}]}))
    const after = await readChangeMarker(source({blocks: [{marker: 10}], queue: [{n: 1, last: 9}]}))
    expect(after).not.toBe(before)
  })

  it('stays put when nothing at all has moved', async () => {
    const answers = {blocks: [{marker: 10}], queue: [{n: 2, last: 7}]}
    expect(await readChangeMarker(source(answers))).toBe(await readChangeMarker(source(answers)))
  })

  it('has no opinion when the block reading fails, so the caller copies', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await readChangeMarker(source({blocks: new Error('no such table')}))).toBeUndefined()
  })

  it('is still stable when only the queue reading fails', async () => {
    // An unreadable queue must not read as a changing one, or every run copies.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = {blocks: [{marker: 10}], queue: new Error('no such table: ps_crud')}
    const first = await readChangeMarker(source(answers))
    expect(first).toBeDefined()
    expect(await readChangeMarker(source(answers))).toBe(first)
  })
})

describe('readDatabaseIncarnation', () => {
  it('identifies the database by its FIRST logged event, not the earliest stamp', async () => {
    // Row 2 carries an EARLIER stamp than row 1, which is what a clock
    // correction leaves behind. Read as a minimum the identity would move —
    // and every copy already in the folder would stop parsing as this
    // database's, falling outside retention for good.
    const afterACorrection = [1700000000000, 1600000000000]

    expect(await readDatabaseIncarnation(logSource(afterACorrection))).toEqual({
      kind: 'known',
      id: '1700000000000',
    })
  })

  it('differs for a database the app rebuilt after the browser wiped the store', async () => {
    // The re-download writes fresh events, so the rebuilt database's log starts
    // at the moment of the rebuild rather than inheriting the old one's.
    const before = await readDatabaseIncarnation(logSource([1700000000000]))
    const rebuilt = await readDatabaseIncarnation(logSource([1788558892401]))
    expect(rebuilt).not.toEqual(before)
  })

  it('calls an empty log EMPTY, which is a fact about the database', async () => {
    // The `row_events` triggers fire on every `blocks` write, so an empty log
    // means no local writes — and therefore nothing in the upload queue. That
    // is the whole of what this feature protects, so there is nothing to copy.
    expect(await readDatabaseIncarnation(source({born: [{born: null}]}))).toEqual({kind: 'empty'})
  })

  it('keeps an unreadable log apart from an empty one, because they call for opposites', async () => {
    // An unreadable log says nothing about whether the FILE copies — the export
    // streams raw bytes and runs no query but the checkpoint — so this case
    // still takes a copy, under a name no run can claim.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await readDatabaseIncarnation(source({born: new Error('no such table')}))).toEqual({
      kind: 'unreadable',
    })
  })
})
