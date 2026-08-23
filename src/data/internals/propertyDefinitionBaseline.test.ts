// @vitest-environment node
/**
 * The durable definitions baseline (#780) as its own unit: the add-vs-apply
 * rule and the stored-blob contract, neither of which the integration tests can
 * reach — they only ever drive the one shape the app writes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { PROPERTY_DEFINITION_BASELINE_PREFIX } from './clientSchema'
import {
  observePropertyDefinitions,
  recordAppliedPropertyDefinitions,
  type BaselineDb,
  type BaselineTx,
} from './propertyDefinitionBaseline'
import type { PropertyDefinitionFacts } from './propertyDefinitionMigrations'

const WS = 'ws-baseline'
const KEY = `${PROPERTY_DEFINITION_BASELINE_PREFIX}${WS}`

/** One-row stand-in for `client_schema_state`, recording every write so a
 *  skipped one is observable. */
const fakeDb = (initial: string | null = null) => {
  const state = {value: initial, writes: [] as Array<string | null>}
  const db: BaselineDb = {
    writeTransaction: async <R,>(fn: (tx: BaselineTx) => Promise<R>): Promise<R> => fn({
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

describe('observePropertyDefinitions', () => {
  it('reports NO baseline the first time, and records what it saw', async () => {
    const {db, state} = fakeDb()

    expect(await observePropertyDefinitions(db, WS, facts({f: {name: 'a'}}))).toBeNull()
    expect(storedFields(state.value)).toEqual({f: {name: 'a'}})
  })

  it('returns the PRE-update baseline, so the caller diffs against what it knew', async () => {
    const {db} = fakeDb()
    await observePropertyDefinitions(db, WS, facts({f: {name: 'a'}}))

    const previous = await observePropertyDefinitions(db, WS, facts({f: {name: 'b'}}))

    expect(previous && [...previous]).toEqual([['f', {name: 'a'}]])
  })

  it('leaves a KNOWN fieldId alone however many builds observe the new fact', async () => {
    // The drift IS the baseline's disagreement with the registry. Absorbing it
    // — here, or on any of the rebuilds that follow — is #780's silent loss:
    // the next prime would find a matching before-state and never repair.
    const {db, state} = fakeDb()
    await observePropertyDefinitions(db, WS, facts({f: {name: 'a', codecType: 'string'}}))

    for (let build = 0; build < 3; build += 1) {
      await observePropertyDefinitions(db, WS, facts({f: {name: 'b', codecType: 'number'}}))
    }

    expect(storedFields(state.value)).toEqual({f: {name: 'a', codecType: 'string'}})
    expect(state.writes).toHaveLength(1)
  })

  it('still ADDS fieldIds it has never seen', async () => {
    const {db, state} = fakeDb()
    await observePropertyDefinitions(db, WS, facts({f1: {name: 'a'}}))

    await observePropertyDefinitions(db, WS, facts({f1: {name: 'drifted'}, f2: {name: 'b'}}))

    expect(storedFields(state.value)).toEqual({f1: {name: 'a'}, f2: {name: 'b'}})
  })

  it('never forgets a fieldId a build did not observe', async () => {
    const {db, state} = fakeDb()
    await observePropertyDefinitions(db, WS, facts({f1: {name: 'a'}, f2: {name: 'b'}}))

    await observePropertyDefinitions(db, WS, facts({f1: {name: 'a'}}))

    expect(storedFields(state.value)).toEqual({f1: {name: 'a'}, f2: {name: 'b'}})
  })

  it('replaces an unparseable blob rather than reading it', async () => {
    const {db, state} = fakeDb('not json at all')

    expect(await observePropertyDefinitions(db, WS, facts({f: {name: 'a'}}))).toBeNull()
    expect(storedFields(state.value)).toEqual({f: {name: 'a'}})
  })
})

describe('recordAppliedPropertyDefinitions', () => {
  it('is the only thing that advances a known fieldId', async () => {
    const {db, state} = fakeDb()
    await observePropertyDefinitions(db, WS, facts({f: {name: 'a', codecType: 'string'}}))
    await observePropertyDefinitions(db, WS, facts({f: {name: 'b', codecType: 'number'}}))

    await recordAppliedPropertyDefinitions(db, WS, facts({f: {name: 'b', codecType: 'number'}}))

    expect(storedFields(state.value)).toEqual({f: {name: 'b', codecType: 'number'}})
    // ...and the drift is gone, so the next prime finds nothing to redo.
    const previous = await observePropertyDefinitions(db, WS, facts({f: {name: 'b', codecType: 'number'}}))
    expect(previous?.get('f')).toEqual({name: 'b', codecType: 'number'})
  })

  it('writes nothing when there is nothing to record', async () => {
    const {db, state} = fakeDb()
    await observePropertyDefinitions(db, WS, facts({f: {name: 'a'}}))

    await recordAppliedPropertyDefinitions(db, WS, new Map())
    await recordAppliedPropertyDefinitions(db, WS, facts({f: {name: 'a'}}))

    expect(state.writes).toHaveLength(1)
  })
})

describe('the baseline row is shared by every tab', () => {
  let sharedDb: TestDb
  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => { await resetTestDb(sharedDb.db) })

  it('does not drop the fieldIds only the OTHER tab has seen', async () => {
    // Each tab is its own Repo over ONE `client_schema_state` row. A tab whose
    // registry is a strict subset (`?safeMode` drops every plugin-contributed
    // definition) must not delete what the full tab recorded — the next prime
    // would read the missing fieldId as a brand-new definition and swallow its
    // rename, which is #780 again. Both calls go through the same connection
    // here, so this pins the read-modify-write, not cross-connection isolation.
    await observePropertyDefinitions(sharedDb.db, WS, facts({kernel: {name: 'a'}, plugin: {name: 'b'}}))

    await observePropertyDefinitions(sharedDb.db, WS, facts({kernel: {name: 'a'}}))

    const row = await sharedDb.db.getOptional<{value: string}>(
      'SELECT value FROM client_schema_state WHERE key = ?', [KEY],
    )
    expect(storedFields(row?.value ?? null)).toEqual({kernel: {name: 'a'}, plugin: {name: 'b'}})
  })
})
