// @vitest-environment node
import {describe, expect, it, vi} from 'vitest'
import {readChangeMarker, type ChangeMarkerSource} from '../changeMarker.js'

const source = (
  answers: {blocks?: unknown; queue?: unknown} = {},
): ChangeMarkerSource => ({
  db: {
    getAll: (async (sql: string) => {
      const answer = sql.includes('ps_crud') ? answers.queue : answers.blocks
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
