import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A chainable stand-in for `supabase.from(table).select(…).eq(…).abortSignal(…).maybeSingle()`.
// Each terminal call takes the next scripted result, and the table each query
// started from is recorded in order.
const query = vi.hoisted(() => ({
  results: [] as Array<{data: unknown; error: unknown} | Error>,
  tables: [] as string[],
}))
vi.mock('@/services/supabase', () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    abortSignal: () => builder,
    maybeSingle: async () => {
      const next = query.results.shift()
      if (next instanceof Error) throw next
      return next ?? {data: null, error: null}
    },
  }
  return {supabase: {from: (table: string) => {
    query.tables.push(table)
    return builder
  }}}
})

import { BLOCKS_TABLE_COLUMN_NAMES, blockToRowParams } from '@/data/blockSchema'
import type { BlockData } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  fetchWorkspaceConversionState,
  hasCopiedCiphertext,
  parseConversionPhase,
} from './workspaceConversion'

const workspaceRow = (over: Record<string, unknown> = {}) => ({
  encryption_mode: 'e2ee',
  wk_canary: 'enc:v1:canary',
  owner_user_id: 'owner-1',
  ...over,
})

beforeEach(() => {
  query.results = []
  query.tables = []
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
  it('reads the mode, canary and owner from workspaces, and the phase from workspace_conversions', async () => {
    query.results.push({data: workspaceRow(), error: null}, {data: {phase: 'cleaning'}, error: null})
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

  it('reads the workspace row BEFORE the conversion row', async () => {
    // The phase only moves forward, so a phase read after the mode can only be
    // later, never earlier. The other order could pair a pre-flip "no row" with a
    // post-flip "e2ee" and open a workspace that is sealing.
    query.results.push({data: workspaceRow(), error: null}, {data: null, error: null})
    await fetchWorkspaceConversionState('ws')
    expect(query.tables).toEqual(['workspaces', 'workspace_conversions'])
  })

  it('no conversion row means no conversion is running', async () => {
    query.results.push({data: workspaceRow(), error: null}, {data: null, error: null})
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'read', state: {conversionPhase: null}})
  })

  it('a phase value this build does not know reads as sealing', async () => {
    query.results.push({data: workspaceRow(), error: null}, {data: {phase: 'verifying'}, error: null})
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'read', state: {conversionPhase: 'sealing'}})
  })

  it('a PostgREST error on either read is unavailable, never a guess', async () => {
    query.results.push({data: null, error: {code: 'PGRST301', message: 'JWT expired'}})
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'unavailable'})
    query.results.push({data: workspaceRow(), error: null}, {data: null, error: {code: 'PGRST301', message: 'JWT expired'}})
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'unavailable'})
  })

  it('a thrown fetch (offline) is unavailable', async () => {
    query.results.push(new TypeError('Failed to fetch'))
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'unavailable'})
  })

  it('no workspace row (RLS-hidden or deleted) is unavailable', async () => {
    query.results.push({data: null, error: null})
    const read = await fetchWorkspaceConversionState('ws')
    expect(read).toMatchObject({kind: 'unavailable'})
    expect(String((read as {error: unknown}).error)).toMatch(/not visible/)
  })

  it.each(['PGRST205', '42P01'])(
    'a server without the conversions table (%s) predates the migration, so no conversion is running',
    async code => {
      query.results.push(
        {data: workspaceRow(), error: null},
        {data: null, error: {code, message: "Could not find the table 'public.workspace_conversions'"}},
      )
      expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'read', state: {conversionPhase: null}})
    },
  )
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
