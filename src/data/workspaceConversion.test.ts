import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A chainable stand-in for `supabase.from(table).select(…).eq(…).abortSignal(…).maybeSingle()`.
// Each terminal call takes the next scripted result; every query's table and
// column list are recorded in order.
const query = vi.hoisted(() => ({
  results: [] as Array<{data: unknown; error: unknown} | Error>,
  calls: [] as Array<{table: string; columns: string}>,
}))
vi.mock('@/services/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call = {table, columns: ''}
      query.calls.push(call)
      const builder = {
        select: (columns: string) => {
          call.columns = columns
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
      return builder
    },
  },
}))

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
  query.calls = []
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
  const read = (phase: unknown) => ({data: workspaceRow({workspace_conversions: phase}), error: null})

  it('reads the mode, canary, owner and phase in ONE statement, so from one snapshot', async () => {
    // Two requests could each hit a different snapshot (a read replica), pairing
    // a post-flip "e2ee" with a pre-flip "no conversion" and opening a sealing
    // workspace.
    query.results.push(read({phase: 'cleaning'}))
    expect(await fetchWorkspaceConversionState('ws')).toEqual({
      kind: 'read',
      state: {
        encryptionMode: 'e2ee',
        conversionPhase: 'cleaning',
        wkCanary: 'enc:v1:canary',
        ownerUserId: 'owner-1',
      },
    })
    expect(query.calls).toHaveLength(1)
    expect(query.calls[0].table).toBe('workspaces')
    expect(query.calls[0].columns).toContain('workspace_conversions(phase)')
  })

  it('accepts the embed as an array too', async () => {
    query.results.push(read([{phase: 'sealing'}]))
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'read', state: {conversionPhase: 'sealing'}})
  })

  it('no conversion row means no conversion is running', async () => {
    query.results.push(read(null))
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'read', state: {conversionPhase: null}})
    query.results.push(read([]))
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'read', state: {conversionPhase: null}})
  })

  it('a phase value this build does not know reads as sealing', async () => {
    query.results.push(read({phase: 'verifying'}))
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'read', state: {conversionPhase: 'sealing'}})
  })

  it.each([
    ['an auth error', {code: 'PGRST301', message: 'JWT expired'}],
    ['a server error', {code: '57014', message: 'canceling statement due to statement timeout'}],
    ['a broken policy naming a missing relation', {code: '42P01', message: 'relation "x" does not exist'}],
  ])('%s is unavailable, never "no conversion"', async (_label, error) => {
    query.results.push({data: null, error})
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'unavailable'})
  })

  it.each([
    ['offline', new TypeError('Failed to fetch')],
    ['the timeout', new DOMException('signal timed out', 'TimeoutError')],
  ])('a thrown fetch (%s) is unavailable', async (_label, thrown) => {
    query.results.push(thrown)
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'unavailable'})
  })

  it('no visible workspace row (RLS-hidden or deleted) is not-visible', async () => {
    query.results.push({data: null, error: null})
    expect(await fetchWorkspaceConversionState('ws')).toEqual({kind: 'not-visible'})
  })

  it('a server with no conversions relationship (PGRST200) predates the migration: no conversion', async () => {
    query.results.push(
      {data: null, error: {code: 'PGRST200', message: "Could not find a relationship between 'workspaces' and 'workspace_conversions'"}},
      {data: workspaceRow(), error: null},
    )
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'read', state: {conversionPhase: null}})
    expect(query.calls[1].columns).not.toContain('workspace_conversions')
  })

  it('the fallback read failing is unavailable too', async () => {
    query.results.push(
      {data: null, error: {code: 'PGRST200', message: 'no relationship'}},
      new TypeError('Failed to fetch'),
    )
    expect(await fetchWorkspaceConversionState('ws')).toMatchObject({kind: 'unavailable'})
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
