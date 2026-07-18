// @vitest-environment node
/**
 * row_events v2 — stateful fuzz suite (docs/row-events-optimization.html §13,
 * slice A; conventions per docs/fuzzing.md).
 *
 * Drives random edit sequences (create / update / no-op update / soft-delete /
 * restore / hard-delete / projected-field edits, with the tx source toggling
 * between 'user' and sync-shaped NULL) against a real SQLite DB with the
 * production triggers, and checks two oracle families:
 *
 * - I1/I2 (reconstruction): `stateAt` at every event must equal the state the
 *   model recorded when that event was written. The oracle is ANCHOR-AGNOSTIC
 *   — no property depends on where anchors landed — so SQLite's unseedable
 *   `random()` cannot break seed replay of a failure's semantics. The same
 *   sequence still runs under deterministic p = 1 and p = 0 trigger variants
 *   so both the full and the compact path are exercised on every seed.
 * - Shape (the §4.1 one-coin trap): both payload sides of every event agree
 *   on key set and fullness; compact key sets are exactly the model-predicted
 *   changed-field sets; identical updates write no event at all.
 */

import {describe, expect, it} from 'vitest'
import fc from 'fast-check'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {BLOCK_STORAGE_COLUMNS} from '@/data/blockSchema'
import {
  ANCHOR_COIN_ALWAYS_SQL,
  ANCHOR_COIN_NEVER_SQL,
} from './clientSchema'
import {stateAt, type RowEventRecord} from './rowEventsHistory'
import {DOMAIN_KEYS, setupRowEventsDb} from './test/rowEventsTestDb'

// ── command model ───────────────────────────────────────────────────────────

const IDS = ['b1', 'b2', 'b3'] as const
type BlockId = (typeof IDS)[number]

interface UpdateFields {
  workspace_id?: string
  content?: string
  order_key?: string
  properties_json?: string
  references_json?: string
  created_at?: number
  updated_at?: number
  user_updated_at?: number | null
  created_by?: string
  updated_by?: string
}

type Cmd =
  | {op: 'create'; id: BlockId; content: string; created_at: number; user_updated_at: number | null}
  | {op: 'update'; id: BlockId; fields: UpdateFields}
  | {op: 'noop'; id: BlockId}
  | {op: 'softDelete'; id: BlockId}
  | {op: 'restore'; id: BlockId}
  | {op: 'hardDelete'; id: BlockId}
  | {op: 'setSource'; source: 'user' | null}

const idArb = fc.constantFrom(...IDS)
const tsArb = fc.integer({min: 1, max: 9_999_999})
const contentArb = fc.string({maxLength: 8})
const propsArb = fc
  .dictionary(fc.constantFrom('p1', 'p2', 'p3'), fc.oneof(fc.integer(), fc.string({maxLength: 5}), fc.constant(null)), {maxKeys: 3})
  .map(o => JSON.stringify(o))

const updateFieldsArb: fc.Arbitrary<UpdateFields> = fc
  .record(
    {
      // workspace_id/created_at/created_by don't move in normal app flows,
      // but the WHEN gate must cover EVERY column (I3) — a dropped or
      // typoed predicate on the columns nobody edits casually is exactly
      // the drift that would go unnoticed longest, so the model exercises
      // them like any other field.
      workspace_id: fc.constantFrom('ws1', 'ws2'),
      content: contentArb,
      order_key: fc.constantFrom('a0', 'a1', 'a2'),
      properties_json: propsArb,
      references_json: fc.constantFrom('[]', '[{"id":"r1"}]'),
      created_at: tsArb,
      updated_at: tsArb,
      user_updated_at: fc.option(tsArb, {nil: null}),
      created_by: fc.constantFrom('u1', 'u2'),
      updated_by: fc.constantFrom('u1', 'u2'),
    },
    {requiredKeys: []},
  )
  .filter(fields => Object.keys(fields).length > 0)

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  {weight: 2, arbitrary: fc.record({op: fc.constant('create' as const), id: idArb, content: contentArb, created_at: tsArb, user_updated_at: fc.option(tsArb, {nil: null})})},
  {weight: 5, arbitrary: fc.record({op: fc.constant('update' as const), id: idArb, fields: updateFieldsArb})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('noop' as const), id: idArb})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('softDelete' as const), id: idArb})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('restore' as const), id: idArb})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('hardDelete' as const), id: idArb})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('setSource' as const), source: fc.constantFrom('user' as const, null)})},
)

// ── harness ─────────────────────────────────────────────────────────────────

interface StorageRow {
  id: string
  workspace_id: string
  content: string
  order_key: string
  properties_json: string
  references_json: string
  created_at: number
  updated_at: number
  user_updated_at: number | null
  created_by: string
  updated_by: string
  deleted: 0 | 1
}

type DomainState = Record<string, unknown>

const domainState = (r: StorageRow): DomainState => ({
  id: r.id,
  workspaceId: r.workspace_id,
  parentId: null,
  orderKey: r.order_key,
  content: r.content,
  properties: JSON.parse(r.properties_json) as unknown,
  references: JSON.parse(r.references_json) as unknown,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  userUpdatedAt: r.user_updated_at ?? r.updated_at,
  createdBy: r.created_by,
  updatedBy: r.updated_by,
  deleted: r.deleted === 1,
})

/** Model twin of the trigger's per-field change detection: storage `IS NOT`
 *  compares, except userUpdatedAt which diffs the coalesce PROJECTION. */
const changedDomainKeys = (before: StorageRow, after: StorageRow): string[] => {
  const keys: string[] = []
  if (before.id !== after.id) keys.push('id')
  if (before.workspace_id !== after.workspace_id) keys.push('workspaceId')
  if (before.created_by !== after.created_by) keys.push('createdBy')
  if (before.order_key !== after.order_key) keys.push('orderKey')
  if (before.content !== after.content) keys.push('content')
  if (before.properties_json !== after.properties_json) keys.push('properties')
  if (before.references_json !== after.references_json) keys.push('references')
  if (before.created_at !== after.created_at) keys.push('createdAt')
  if (before.updated_at !== after.updated_at) keys.push('updatedAt')
  if ((before.user_updated_at ?? before.updated_at) !== (after.user_updated_at ?? after.updated_at)) keys.push('userUpdatedAt')
  if (before.updated_by !== after.updated_by) keys.push('updatedBy')
  if (before.deleted !== after.deleted) keys.push('deleted')
  return keys.sort()
}

interface ExpectedEvent {
  eventId: number
  kind: string
  /** Domain state just after the event (for delete: just before the purge). */
  state: DomainState
  /** Model-predicted compact key set (update/soft-delete only). */
  changedKeys: string[] | null
}

const runSequence = async (cmds: Cmd[], coinSql: string | null): Promise<void> => {
  const harness = setupRowEventsDb()
  if (coinSql !== null) harness.installUpdateTrigger(coinSql)
  const db = harness.db
  try {
    const model = new Map<string, StorageRow>()
    const expected: ExpectedEvent[] = []
    const insertNames = BLOCK_STORAGE_COLUMNS.map(c => c.name)
    const insertStmt = db.prepare(
      `INSERT INTO blocks (${insertNames.join(',')}) VALUES (${insertNames.map(() => '?').join(',')})`,
    )
    const eventCount = () => (db.prepare('SELECT COUNT(*) AS n FROM row_events').get() as {n: number}).n
    const lastEventId = () => (db.prepare('SELECT MAX(id) AS m FROM row_events').get() as {m: number}).m

    const recordEvent = (kind: string, state: DomainState, changedKeys: string[] | null, countBefore: number) => {
      expect(eventCount()).toBe(countBefore + 1)
      expected.push({eventId: lastEventId(), kind, state, changedKeys})
    }

    for (const cmd of cmds) {
      if (cmd.op === 'setSource') {
        db.prepare('UPDATE tx_context SET source = ?, tx_id = ?, scope = ? WHERE id = 1')
          .run(cmd.source, cmd.source === null ? null : 'tx-fuzz', cmd.source === null ? null : 'block-default')
        continue
      }
      const existing = model.get(cmd.id)
      const countBefore = eventCount()

      if (cmd.op === 'create') {
        if (existing) continue // PK collision — model skips
        const row: StorageRow = {
          id: cmd.id,
          workspace_id: 'ws1',
          content: cmd.content,
          order_key: 'a0',
          properties_json: '{}',
          references_json: '[]',
          created_at: cmd.created_at,
          updated_at: cmd.created_at,
          user_updated_at: cmd.user_updated_at,
          created_by: 'u1',
          updated_by: 'u1',
          deleted: 0,
        }
        insertStmt.run(cmd.id, 'ws1', null, row.order_key, row.content, row.properties_json,
          row.references_json, row.created_at, row.updated_at, row.user_updated_at, 'u1', row.updated_by, 0)
        model.set(cmd.id, row)
        recordEvent('create', domainState(row), null, countBefore)
        continue
      }

      if (!existing) continue // update/delete on a missing row — model skips

      if (cmd.op === 'hardDelete') {
        db.prepare('DELETE FROM blocks WHERE id = ?').run(cmd.id)
        model.delete(cmd.id)
        recordEvent('delete', domainState(existing), null, countBefore)
        continue
      }

      // The three UPDATE-shaped ops.
      const after: StorageRow = {...existing}
      let sql: {cols: string[]; vals: (string | number | null)[]}
      if (cmd.op === 'update') {
        Object.assign(after, cmd.fields)
        sql = {cols: Object.keys(cmd.fields), vals: Object.values(cmd.fields) as (string | number | null)[]}
      } else if (cmd.op === 'noop') {
        sql = {cols: ['content'], vals: [existing.content]}
      } else {
        // softDelete / restore
        after.deleted = cmd.op === 'softDelete' ? 1 : 0
        sql = {cols: ['deleted'], vals: [after.deleted]}
      }
      db.prepare(`UPDATE blocks SET ${sql.cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...sql.vals, cmd.id)
      const changed = changedDomainKeys(existing, after)
      model.set(cmd.id, after)
      if (changed.length === 0) {
        expect(eventCount()).toBe(countBefore) // identical update: NO event
        continue
      }
      const kind = existing.deleted === 0 && after.deleted === 1 ? 'soft-delete' : 'update'
      recordEvent(kind, domainState(after), changed, countBefore)
    }

    // ── oracles over the finished log ──
    const events = db.prepare('SELECT id, block_id, kind, before_json, after_json, v, full FROM row_events ORDER BY id')
      .all() as unknown as RowEventRecord[]
    expect(events.length).toBe(expected.length)

    const fullKeys = [...DOMAIN_KEYS].sort()
    for (const [i, e] of events.entries()) {
      const exp = expected[i]
      expect(e.id).toBe(exp.eventId)
      expect(e.kind).toBe(exp.kind)
      expect(e.v).toBe(2)

      // Shape: sides agree with each other and with `full` (the one-coin trap).
      const beforeKeys = e.before_json === null ? null : Object.keys(JSON.parse(e.before_json) as object).sort()
      const afterKeys = e.after_json === null ? null : Object.keys(JSON.parse(e.after_json) as object).sort()
      if (e.kind === 'create') {
        expect(e.full).toBe(1)
        expect(beforeKeys).toBeNull()
        expect(afterKeys).toEqual(fullKeys)
      } else if (e.kind === 'delete') {
        expect(e.full).toBe(1)
        expect(beforeKeys).toEqual(fullKeys)
        expect(afterKeys).toBeNull()
      } else if (e.full === 1) {
        expect(beforeKeys).toEqual(fullKeys)
        expect(afterKeys).toEqual(fullKeys)
      } else {
        expect(e.full).toBe(0)
        expect(beforeKeys).toEqual(afterKeys)
        expect(beforeKeys).toEqual(exp.changedKeys)
      }

      // I1/I2: reconstruction matches the model's timeline exactly.
      expect(await stateAt(harness.history, e.id)).toEqual(exp.state)
    }
  } finally {
    harness.close()
  }
}

// ── properties ──────────────────────────────────────────────────────────────

const COIN_VARIANTS: Array<{name: string; coinSql: string | null}> = [
  {name: 'compact path (p = 0)', coinSql: ANCHOR_COIN_NEVER_SQL},
  {name: 'anchor path (p = 1)', coinSql: ANCHOR_COIN_ALWAYS_SQL},
  {name: 'production coin (p = 1/64, anchor-agnostic oracles)', coinSql: null},
]

describe('row_events v2 stateful fuzz — model oracle (I1/I2) + shape', () => {
  for (const variant of COIN_VARIANTS) {
    it(`${variant.name}: stateAt equals the model timeline at every event; payload shape holds`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(cmdArb, {minLength: 1, maxLength: 40}), async cmds => {
          await runSequence(cmds, variant.coinSql)
        }),
        fuzzParams(25),
      )
    }, fuzzTestTimeout())
  }
})
