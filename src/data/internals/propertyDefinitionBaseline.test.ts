// @vitest-environment node
/**
 * The durable definitions baseline (#780) as its own unit: the fold semantics
 * and the stored-blob contract, neither of which the integration tests can
 * reach — they only ever see the one shape the app writes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { PROPERTY_DEFINITION_BASELINE_PREFIX } from './clientSchema'
import { PropertyDefinitionBaselineStore, type BaselineDb } from './propertyDefinitionBaseline'
import type { PropertyDefinitionFacts } from './propertyDefinitionMigrations'

const WS = 'ws-baseline'
const KEY = `${PROPERTY_DEFINITION_BASELINE_PREFIX}${WS}`

/** One-row stand-in for `client_schema_state`, recording every write so a
 *  skipped one is observable. */
const fakeDb = (initial: string | null = null) => {
  const state = {value: initial, writes: [] as Array<string | null>}
  const db: BaselineDb = {
    writeTransaction: async <R,>(fn: (tx: {
      getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
      execute(sql: string, params?: unknown[]): Promise<unknown>
    }) => Promise<R>): Promise<R> => fn({
      getOptional: async <T,>(_sql: string, params?: unknown[]): Promise<T | null> => {
        expect(params?.[0]).toBe(KEY)
        return state.value === null ? null : ({value: state.value} as T)
      },
      execute: async (_sql: string, params?: unknown[]) => {
        state.value = params?.[1] as string
        state.writes.push(state.value)
      },
    }),
  }
  return {db, state}
}

const facts = (entries: Record<string, PropertyDefinitionFacts>) =>
  new Map(Object.entries(entries))

const storedFields = (raw: string | null) =>
  raw === null ? null : (JSON.parse(raw) as {fields: Record<string, PropertyDefinitionFacts>}).fields

describe('PropertyDefinitionBaselineStore.foldIn', () => {
  it('reports NO baseline the first time, and records one', async () => {
    const {db, state} = fakeDb()
    const store = new PropertyDefinitionBaselineStore(db)

    expect(await store.foldIn(WS, facts({f: {name: 'a'}}))).toBeNull()
    expect(storedFields(state.value)).toEqual({f: {name: 'a'}})
  })

  it('returns the PRE-fold baseline, so the caller diffs against what it replaced', async () => {
    const {db} = fakeDb()
    const store = new PropertyDefinitionBaselineStore(db)
    await store.foldIn(WS, facts({f: {name: 'a'}}))

    const previous = await store.foldIn(WS, facts({f: {name: 'b'}}))

    expect(previous && [...previous]).toEqual([['f', {name: 'a'}]])
  })

  it('unions over fieldIds: a build that observes a subset forgets nothing', async () => {
    const {db, state} = fakeDb()
    const store = new PropertyDefinitionBaselineStore(db)
    await store.foldIn(WS, facts({f1: {name: 'a'}, f2: {name: 'b'}}))

    await store.foldIn(WS, facts({f1: {name: 'a2'}}))

    expect(storedFields(state.value)).toEqual({f1: {name: 'a2'}, f2: {name: 'b'}})
  })

  it('keeps a known codecType when the observation carries none', async () => {
    const {db, state} = fakeDb()
    const store = new PropertyDefinitionBaselineStore(db)
    await store.foldIn(WS, facts({f: {name: 'a', codecType: 'number'}}))

    // The shape `userSchemasService` publishes while a preset plugin is still
    // loading: metadata, no schema. Losing the codec here would make the next
    // build diff a codec change into nothing.
    await store.foldIn(WS, facts({f: {name: 'a'}}))

    expect(storedFields(state.value)).toEqual({f: {name: 'a', codecType: 'number'}})
    const previous = await store.foldIn(WS, facts({f: {name: 'a', codecType: 'text'}}))
    expect(previous?.get('f')).toEqual({name: 'a', codecType: 'number'})
  })

  it('writes nothing when the fold changes nothing, whatever order the facts arrive in', async () => {
    const {db, state} = fakeDb()
    const store = new PropertyDefinitionBaselineStore(db)
    await store.foldIn(WS, facts({f1: {name: 'a'}, f2: {name: 'b'}}))
    expect(state.writes).toHaveLength(1)

    await store.foldIn(WS, facts({f2: {name: 'b'}, f1: {name: 'a'}}))

    expect(state.writes).toHaveLength(1)
  })

  it('replaces an unparseable blob rather than reading it', async () => {
    const {db, state} = fakeDb('not json at all')
    const store = new PropertyDefinitionBaselineStore(db)

    expect(await store.foldIn(WS, facts({f: {name: 'a'}}))).toBeNull()
    expect(storedFields(state.value)).toEqual({f: {name: 'a'}})
  })

  it('leaves a blob from a LATER version alone, and diffs against nothing', async () => {
    const future = JSON.stringify({version: 2, fields: {f: {name: 'a'}}})
    const {db, state} = fakeDb(future)
    const store = new PropertyDefinitionBaselineStore(db)

    // An old tab open across a deploy must not cost the new build a generation
    // of observations, and must not migrate against a shape it can't read.
    expect(await store.foldIn(WS, facts({f: {name: 'b'}}))).toBeNull()
    expect(state.writes).toEqual([])
    expect(state.value).toBe(future)
  })
})

describe('PropertyDefinitionBaselineStore — one row, many Repos', () => {
  let sharedDb: TestDb
  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => { await resetTestDb(sharedDb.db) })

  it('does not drop the fieldIds only the OTHER tab has seen', async () => {
    // Each tab is its own Repo with its own store over ONE `client_schema_state`
    // row. A tab whose registry is a strict subset (`?safeMode` drops every
    // plugin-contributed definition) must not delete what the full tab recorded
    // — the next prime would read the missing fieldId as a brand-new definition
    // and swallow its rename, which is #780 again.
    const fullTab = new PropertyDefinitionBaselineStore(sharedDb.db)
    const safeModeTab = new PropertyDefinitionBaselineStore(sharedDb.db)

    await fullTab.foldIn(WS, facts({kernel: {name: 'a'}, plugin: {name: 'b'}}))
    await safeModeTab.foldIn(WS, facts({kernel: {name: 'a2'}}))

    const row = await sharedDb.db.getOptional<{value: string}>(
      'SELECT value FROM client_schema_state WHERE key = ?', [KEY],
    )
    expect(storedFields(row?.value ?? null)).toEqual({kernel: {name: 'a2'}, plugin: {name: 'b'}})
  })
})
