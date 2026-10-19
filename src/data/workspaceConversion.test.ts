import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A chainable stand-in for `supabase.from('workspaces').select(…).eq(…).abortSignal(…).maybeSingle()`
// whose terminal result each test sets, recording the selected column list.
const query = vi.hoisted(() => ({
  results: [] as Array<{data: unknown; error: unknown} | Error>,
  selects: [] as string[],
}))
vi.mock('@/services/supabase', () => {
  const builder = {
    select: (columns: string) => {
      query.selects.push(columns)
      return builder
    },
    eq: () => builder,
    abortSignal: () => builder,
    maybeSingle: async () => {
      const next = query.results.shift()
      if (next instanceof Error) throw next
      return next ?? {data: null, error: null}
    },
  }
  return {supabase: {from: () => builder}}
})

import { BLOCKS_TABLE_COLUMN_NAMES, blockToRowParams } from '@/data/blockSchema'
import type { BlockData } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  fetchWorkspaceConversionState,
  hasCopiedCiphertext,
  parseConversionPhase,
} from './workspaceConversion'

const row = (over: Record<string, unknown> = {}) => ({
  encryption_mode: 'e2ee',
  wk_canary: 'enc:v1:canary',
  conversion_phase: 'cleaning',
  owner_user_id: 'owner-1',
  ...over,
})

beforeEach(() => {
  query.results = []
  query.selects = []
})

describe('parseConversionPhase', () => {
  it('passes the two phases and null through', () => {
    expect(parseConversionPhase('sealing')).toBe('sealing')
    expect(parseConversionPhase('cleaning')).toBe('cleaning')
    expect(parseConversionPhase(null)).toBeNull()
  })

  it('reads a value it does not know as sealing, the phase that refuses every unlock', () => {
    expect(parseConversionPhase('verifying')).toBe('sealing')
    expect(parseConversionPhase(7)).toBe('sealing')
  })
})

describe('fetchWorkspaceConversionState', () => {
  it('reads the mode, phase, canary and owner from the server row', async () => {
    query.results.push({data: row(), error: null})
    expect(await fetchWorkspaceConversionState('ws')).toEqual({
      kind: 'read',
      state: {
        encryptionMode: 'e2ee',
        conversionPhase: 'cleaning',
        wkCanary: 'enc:v1:canary',
        ownerUserId: 'owner-1',
      },
    })
  })

  it('a PostgREST error is unavailable, never a guess', async () => {
    query.results.push({data: null, error: {code: 'PGRST301', message: 'JWT expired'}})
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'unavailable'})
  })

  it('a thrown fetch (offline) is unavailable', async () => {
    query.results.push(new TypeError('Failed to fetch'))
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'unavailable'})
  })

  it('no row (RLS-hidden or deleted) is unavailable', async () => {
    query.results.push({data: null, error: null})
    const read = await fetchWorkspaceConversionState('ws')
    expect(read).toMatchObject({kind: 'unavailable'})
    expect(String((read as {error: unknown}).error)).toMatch(/not visible/)
  })

  it('before the conversion_phase column exists, no conversion can be running: the phase reads null', async () => {
    query.results.push({data: null, error: {code: '42703', message: 'column workspaces.conversion_phase does not exist'}})
    query.results.push({data: row({conversion_phase: undefined}), error: null})
    const read = await fetchWorkspaceConversionState('ws')
    expect(read).toMatchObject({kind: 'read', state: {conversionPhase: null, encryptionMode: 'e2ee'}})
    expect(query.selects[1]).not.toContain('conversion_phase')
  })
})

describe('hasCopiedCiphertext', () => {
  // Today's schema parses both JSON columns on write (the `blocks` triggers, and
  // for a live row a partial index too), so a copied envelope can't land at all:
  // the materialize write throws. Dropping the triggers and writing tombstones
  // stands in for a schema where the copy could land.
  let shared: TestDb
  beforeAll(async () => {
    shared = await createTestDb()
    const triggers = await shared.db.getAll<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'blocks'",
    )
    for (const {name} of triggers) await shared.db.execute(`DROP TRIGGER ${name}`)
  })
  afterAll(async () => {
    await shared.cleanup()
  })
  beforeEach(async () => {
    await resetTestDb(shared.db)
  })

  const block = (over: Partial<BlockData>): BlockData => ({
    id: 'b1',
    workspaceId: 'ws',
    parentId: null,
    orderKey: 'a0',
    content: 'hello',
    properties: {},
    references: [],
    createdAt: 1,
    updatedAt: 1,
    userUpdatedAt: 1,
    createdBy: 'u',
    updatedBy: 'u',
    deleted: false,
    ...over,
  })
  type SealedColumn = 'content' | 'properties_json' | 'references_json'
  const insert = (b: BlockData, columns: Partial<Record<SealedColumn, string>> = {}) => {
    const params = blockToRowParams(b)
    for (const [column, value] of Object.entries(columns)) {
      params[BLOCKS_TABLE_COLUMN_NAMES.indexOf(column as SealedColumn)] = value
    }
    return shared.db.execute(
      `INSERT INTO blocks (${BLOCKS_TABLE_COLUMN_NAMES.join(', ')}) VALUES (${BLOCKS_TABLE_COLUMN_NAMES.map(() => '?').join(', ')})`,
      params,
    )
  }

  it('is false for a plaintext workspace, even one whose text starts like an envelope', async () => {
    await insert(block({content: 'enc:v1:just something I typed'}))
    expect(await hasCopiedCiphertext(shared.db, 'ws')).toBe(false)
  })

  it('finds a row whose JSON columns hold envelopes (an old build copied the re-seal)', async () => {
    await insert(block({id: 'b-plain'}))
    await insert(block({id: 'b-copied', deleted: true}), {
      content: 'enc:v1:AAAA',
      properties_json: 'enc:v1:BBBB',
      references_json: 'enc:v1:CCCC',
    })
    expect(await hasCopiedCiphertext(shared.db, 'ws')).toBe(true)
  })

  it('is scoped to the workspace', async () => {
    await insert(block({id: 'b-other', workspaceId: 'ws-other', deleted: true}), {properties_json: 'enc:v1:BBBB'})
    expect(await hasCopiedCiphertext(shared.db, 'ws')).toBe(false)
  })
})
