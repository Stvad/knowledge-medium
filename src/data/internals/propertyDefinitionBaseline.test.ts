// @vitest-environment node
/**
 * The durable codec baseline (#780) as its own unit: the add-vs-apply rule and
 * the stored-blob contract, neither of which the integration tests can reach —
 * they only ever drive the one shape the app writes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { PROPERTY_DEFINITION_BASELINE_PREFIX } from './clientSchema'
import {
  observePropertyDefinitionCodecs,
  recordAppliedPropertyDefinitionCodecs,
  type BaselineDb,
  type BaselineTx,
} from './propertyDefinitionBaseline'

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

const codecs = (entries: Record<string, string>) => new Map(Object.entries(entries))

const storedCodecs = (raw: string | null) =>
  raw === null ? null : (JSON.parse(raw) as {codecs: Record<string, string>}).codecs

describe('observePropertyDefinitionCodecs', () => {
  it('reports NO baseline the first time, and records what it saw', async () => {
    const {db, state} = fakeDb()

    expect(await observePropertyDefinitionCodecs(db, WS, codecs({f: 'string'}))).toBeNull()
    expect(storedCodecs(state.value)).toEqual({f: 'string'})
  })

  it('returns the PRE-update baseline, so the caller diffs against what it knew', async () => {
    const {db} = fakeDb()
    await observePropertyDefinitionCodecs(db, WS, codecs({f: 'string'}))

    const previous = await observePropertyDefinitionCodecs(db, WS, codecs({f: 'number'}))

    expect(previous && [...previous]).toEqual([['f', 'string']])
  })

  it('leaves a KNOWN fieldId alone however many builds observe the new codec', async () => {
    // The drift IS the baseline's disagreement with the registry. Absorbing it
    // — here, or on any of the rebuilds that follow — is #780's silent loss:
    // the next prime would find a matching before-state and never re-encode.
    const {db, state} = fakeDb()
    await observePropertyDefinitionCodecs(db, WS, codecs({f: 'string'}))

    for (let build = 0; build < 3; build += 1) {
      await observePropertyDefinitionCodecs(db, WS, codecs({f: 'number'}))
    }

    expect(storedCodecs(state.value)).toEqual({f: 'string'})
    expect(state.writes).toHaveLength(1)
  })

  it('ADDS a fieldId whose codec resolves for the first time', async () => {
    // A definition seen while its preset plugin was still loading contributes
    // no codec at all, so it is absent rather than recorded with a placeholder
    // — otherwise its real codec could never be learned.
    const {db, state} = fakeDb()
    await observePropertyDefinitionCodecs(db, WS, codecs({f1: 'string'}))

    await observePropertyDefinitionCodecs(db, WS, codecs({f1: 'string', f2: 'number'}))

    expect(storedCodecs(state.value)).toEqual({f1: 'string', f2: 'number'})
  })

  it('never forgets a fieldId a build did not observe', async () => {
    const {db, state} = fakeDb()
    await observePropertyDefinitionCodecs(db, WS, codecs({f1: 'string', f2: 'number'}))

    await observePropertyDefinitionCodecs(db, WS, codecs({f1: 'string'}))

    expect(storedCodecs(state.value)).toEqual({f1: 'string', f2: 'number'})
  })

  it('replaces an unparseable blob rather than reading it', async () => {
    const {db, state} = fakeDb('not json at all')

    expect(await observePropertyDefinitionCodecs(db, WS, codecs({f: 'string'}))).toBeNull()
    expect(storedCodecs(state.value)).toEqual({f: 'string'})
  })
})

describe('recordAppliedPropertyDefinitionCodecs', () => {
  it('is the only thing that advances a known fieldId', async () => {
    const {db, state} = fakeDb()
    await observePropertyDefinitionCodecs(db, WS, codecs({f: 'string'}))
    await observePropertyDefinitionCodecs(db, WS, codecs({f: 'number'}))

    await recordAppliedPropertyDefinitionCodecs(db, WS, codecs({f: 'number'}))

    expect(storedCodecs(state.value)).toEqual({f: 'number'})
    // ...and the drift is gone, so the next prime finds nothing to redo.
    const previous = await observePropertyDefinitionCodecs(db, WS, codecs({f: 'number'}))
    expect(previous?.get('f')).toBe('number')
  })

  it('writes nothing when there is nothing to record', async () => {
    const {db, state} = fakeDb()
    await observePropertyDefinitionCodecs(db, WS, codecs({f: 'string'}))

    await recordAppliedPropertyDefinitionCodecs(db, WS, new Map())
    await recordAppliedPropertyDefinitionCodecs(db, WS, codecs({f: 'string'}))

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
    // codec change. Both calls go through the same connection here, so this
    // pins the read-modify-write, not cross-connection isolation.
    await observePropertyDefinitionCodecs(
      sharedDb.db, WS, codecs({kernel: 'string', plugin: 'number'}),
    )

    await observePropertyDefinitionCodecs(sharedDb.db, WS, codecs({kernel: 'string'}))

    const row = await sharedDb.db.getOptional<{value: string}>(
      'SELECT value FROM client_schema_state WHERE key = ?', [KEY],
    )
    expect(storedCodecs(row?.value ?? null)).toEqual({kernel: 'string', plugin: 'number'})
  })
})
