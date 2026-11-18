// @vitest-environment node
/**
 * Sync-applied growth owes an ANALYZE: a device that receives a bulk change
 * through sync must record the same `analyze_owed` marker a local bulk writer
 * does, or its planner keeps stats for a table a fraction of its real size.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { constMat, setupObserverTestDb } from './test/harness.js'

const data = (id: string): BlockData => ({
  id, workspaceId: 'ws-plain', parentId: null, orderKey: 'a0', content: id,
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'u',
  updatedBy: 'u', deleted: false,
})

const { env, start, stageRow, seedLocalBlock } = setupObserverTestDb()

/** `blocks` analyzed when it held `rows` rows. */
const statsSay = async (rows: number): Promise<void> => {
  await env.db.execute('ANALYZE')
  await env.db.execute(`DELETE FROM sqlite_stat1 WHERE tbl = 'blocks'`)
  await env.db.execute(
    `INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('blocks', 'sqlite_autoindex_blocks_1', ?)`,
    [`${rows} 1`],
  )
}

const owed = async (): Promise<string[]> =>
  (await env.db.getAll<{key: string}>(
    `SELECT key FROM client_schema_state WHERE key LIKE 'analyze_owed:%' ORDER BY key`,
  )).map(row => row.key)

const arrive = async (ids: readonly string[]): Promise<void> => {
  for (const id of ids) await stageRow(data(id))
}

beforeEach(async () => {
  await env.db.execute(`DELETE FROM client_schema_state WHERE key LIKE 'analyze_owed:%'`)
})

describe('blocksSyncedObserver — sync-applied growth owes an ANALYZE', () => {
  it('records the marker once the rows it inserted reach a quarter of what the stats claim', async () => {
    await statsSay(8)
    const {observer} = start({getMaterializability: constMat('copy')})

    await arrive(['a'])
    await observer.flush()
    expect(await owed()).toEqual([])

    await arrive(['b'])
    await observer.flush()
    expect(await owed()).toContain('analyze_owed:blocks')
  })

  it('counts again from zero after recording, against the stats as they are then', async () => {
    await statsSay(8)
    const {observer} = start({getMaterializability: constMat('copy')})
    await arrive(['a', 'b'])
    await observer.flush()
    expect(await owed()).toContain('analyze_owed:blocks')

    // The owed ANALYZE ran: the marker is settled and the stats moved.
    await env.db.execute(`DELETE FROM client_schema_state WHERE key LIKE 'analyze_owed:%'`)
    await statsSay(12)
    await arrive(['c', 'd'])
    await observer.flush()
    expect(await owed()).toEqual([])

    await arrive(['e'])
    await observer.flush()
    expect(await owed()).toContain('analyze_owed:blocks')
  })

  it('counts only inserts: re-delivering rows it already holds owes nothing', async () => {
    for (const id of ['a', 'b', 'c']) await seedLocalBlock(data(id))
    await statsSay(4)
    const {observer} = start({getMaterializability: constMat('copy')})

    for (const id of ['a', 'b', 'c']) await stageRow({...data(id), content: `${id} edited`, updatedAt: 2})
    await observer.flush()
    expect(await owed()).toEqual([])
  })

  it('records the marker on the first insert into a table with no stats yet', async () => {
    await env.db.execute('ANALYZE')
    await env.db.execute(`DELETE FROM sqlite_stat1 WHERE tbl = 'blocks'`)
    const {observer} = start({getMaterializability: constMat('copy')})

    await arrive(['a'])
    await observer.flush()
    expect(await owed()).toContain('analyze_owed:blocks')
  })

  it('records the marker on a database never analyzed, which has no stats table', async () => {
    await env.db.execute('DROP TABLE IF EXISTS sqlite_stat1')
    const {observer} = start({getMaterializability: constMat('copy')})

    await arrive(['a'])
    await observer.flush()
    expect(await owed()).toContain('analyze_owed:blocks')
  })
})
