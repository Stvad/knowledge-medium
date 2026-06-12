// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { aliasesProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { getOrCreateDailyNote } from '../dailyNotes.ts'
import { dailyNoteDateValue } from '../dailyNotes.ts'
import { dailyNotesDataExtension } from '../dataExtension.ts'
import { dailyNoteDateProp } from '../schema.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

let sharedDb: TestDb
let env: Harness

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  let id = 0
  const repo = new Repo({
    db: sharedDb.db,
    cache: new BlockCache(),
    user: USER,
    newId: () => `gen-${++id}`,
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension, dailyNotesDataExtension]))
  repo.setActiveWorkspaceId(WS)
  return {h: sharedDb, repo}
}

/** Create a daily note then strip its `daily-note:date` — the shape of a row
 *  authored before the property existed: daily-note typed, ISO alias present,
 *  date absent. */
const makeLegacyDailyNote = async (repo: Repo, iso: string): Promise<string> => {
  const note = await getOrCreateDailyNote(repo, WS, iso)
  await repo.tx(async tx => {
    const block = await tx.get(note.id)
    if (!block) throw new Error('note vanished')
    const props = {...block.properties}
    delete props[dailyNoteDateProp.name]
    await tx.update(note.id, {properties: props})
  }, {scope: ChangeScope.BlockDefault})
  await repo.awaitProcessors()
  return note.id
}

/** Raw stored `daily-note:date`, decoded to a Date — or null when absent. */
const readDate = async (id: string): Promise<Date | null> => {
  const row = await env.h.db.getOptional<{v: string | null}>(
    `SELECT json_extract(properties_json, '$."${dailyNoteDateProp.name}"') AS v FROM blocks WHERE id = ?`,
    [id],
  )
  return row?.v == null ? null : (dailyNoteDateProp.codec.decode(row.v) ?? null)
}

const runBackfill = async (repo: Repo): Promise<void> => {
  repo.scheduleWorkspaceBackfills(WS)
  await vi.runAllTimersAsync()
  await repo.awaitWorkspaceBackfills()
}

/** ps_crud ops for a block id — proof the write reached the upload queue. A
 *  raw `db.execute` write (the original bug) would leave this empty. */
const uploadOps = async (id: string): Promise<string[]> =>
  (await env.h.db.getAll<{data: string}>('SELECT data FROM ps_crud ORDER BY id'))
    .map(r => JSON.parse(r.data) as {op: string; id: string})
    .filter(e => e.id === id)
    .map(e => e.op)

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 4, 13, 12))
  env = await setup()
})
afterEach(async () => {
  vi.useRealTimers()
  env.repo.stopSyncObserver()
})

describe('dailyNoteDateBackfill', () => {
  it('derives daily-note:date from the ISO alias for a legacy note, and the write uploads', async () => {
    const id = await makeLegacyDailyNote(env.repo, '2026-05-13')
    expect(await readDate(id)).toBeNull()
    await env.h.db.execute('DELETE FROM ps_crud') // drop the setup PUTs so we observe only the backfill

    await runBackfill(env.repo)

    expect(await readDate(id)).toEqual(dailyNoteDateValue('2026-05-13'))
    // Went through repo.tx → source='user' → upload trigger fired (a raw write
    // would not have — the daily-note:date sync gap this restores).
    expect(await uploadOps(id)).toContain('PATCH')
  })

  it('leaves a note that already has daily-note:date untouched (no clobber, no upload)', async () => {
    const note = await getOrCreateDailyNote(env.repo, WS, '2026-05-13')
    await env.repo.awaitProcessors()
    const before = await readDate(note.id)
    expect(before).not.toBeNull()
    await env.h.db.execute('DELETE FROM ps_crud')

    await runBackfill(env.repo)

    expect(await readDate(note.id)).toEqual(before)
    expect(await uploadOps(note.id)).toEqual([]) // skipped — no redundant write
  })

  it('ignores a non-daily-note block that merely carries a date-shaped alias', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'plain', workspaceId: WS, parentId: null, orderKey: 'a', content: 'plain'})
      await tx.setProperty('plain', aliasesProp, ['2026-01-01'])
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await runBackfill(env.repo)

    expect(await readDate('plain')).toBeNull()
  })

  it('runs once per workspace — a note created after the first run is not retro-filled', async () => {
    const first = await makeLegacyDailyNote(env.repo, '2026-05-13')
    await runBackfill(env.repo)
    expect(await readDate(first)).not.toBeNull()

    // Marker landed; a legacy note that appears later is the creation path's
    // job, not the backfill's. Scheduling again is a no-op for it.
    const later = await makeLegacyDailyNote(env.repo, '2026-05-14')
    await runBackfill(env.repo)
    expect(await readDate(later)).toBeNull()
  })

  it('does not write into a read-only workspace', async () => {
    const id = await makeLegacyDailyNote(env.repo, '2026-05-13')
    env.repo.setReadOnly(true)

    await runBackfill(env.repo)

    expect(await readDate(id)).toBeNull()
  })
})
