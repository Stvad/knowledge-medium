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
          : sql.includes('MIN(created_at)')
            ? answers.born
            : answers.blocks
      if (answer instanceof Error) throw answer
      return answer ?? []
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
  it('identifies the database by when its log first recorded anything', async () => {
    expect(await readDatabaseIncarnation(source({born: [{born: 1700000000000}]}))).toBe(
      '1700000000000',
    )
  })

  it('differs for a database the app rebuilt after the browser wiped the store', async () => {
    // The re-download writes fresh events, so the rebuilt database's log starts
    // at the moment of the rebuild rather than inheriting the old one's.
    const before = await readDatabaseIncarnation(source({born: [{born: 1700000000000}]}))
    const rebuilt = await readDatabaseIncarnation(source({born: [{born: 1788558892401}]}))
    expect(rebuilt).not.toBe(before)
  })

  it('has no answer for an empty log, rather than inventing one', async () => {
    expect(await readDatabaseIncarnation(source({born: [{born: null}]}))).toBeUndefined()
  })

  it('has no answer when the log cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await readDatabaseIncarnation(source({born: new Error('no such table')}))).toBeUndefined()
  })
})
