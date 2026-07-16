// @vitest-environment node
/**
 * row_events v2 format — trigger behavior + stateAt reader
 * (docs/row-events-optimization.html §3/§4; slices A of §13).
 *
 * Uses `node:sqlite` like clientSchema.test.ts — same SQLite C library as
 * wa-sqlite, so trigger semantics match the browser. Payload-shape
 * assertions install DETERMINISTIC anchor-coin variants (p = 1 / p = 0) via
 * `buildBlocksUpdateRowEventTriggerSql`; the default random-coin trigger is
 * only asserted on anchor-agnostic properties (the shape test), never on
 * "this event is compact" — that would be flaky at p = 1/64.
 *
 * The randomized I1/I2 sweep lives in rowEventsV2.fuzz.test.ts; this file
 * pins the example-shaped behaviors and the traps called out in the design:
 * identical-update skip, projected userUpdatedAt diff, id-rewrite forced
 * full, source-gated scope stamp, one-coin side agreement, and stateAt's
 * gap/terminator edge cases.
 */

import {beforeEach, afterEach, describe, expect, it} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {
  BLOCK_STORAGE_COLUMNS,
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_TABLE_SQL,
} from '@/data/blockSchema'
import {
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
} from '@/data/workspaceSchema'
import {
  ANCHOR_COIN_ALWAYS_SQL,
  ANCHOR_COIN_NEVER_SQL,
  CLIENT_SCHEMA_STATEMENTS,
  CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL,
  CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL,
  CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL,
  ROW_EVENTS_FORMAT_VERSION,
  blockJsonObjectSql,
  buildBlocksUpdateRowEventTriggerSql,
  ensureRowEventsV2Columns,
} from './clientSchema'
import {HistoryWalkError, stateAt, type RowEventsHistoryDb} from './rowEventsHistory'

const DOMAIN_KEYS = [
  'id', 'workspaceId', 'parentId', 'orderKey', 'content', 'properties', 'references',
  'createdAt', 'updatedAt', 'userUpdatedAt', 'createdBy', 'updatedBy', 'deleted',
] as const

interface RowEventRow {
  id: number
  tx_id: string | null
  block_id: string
  kind: string
  before_json: string | null
  after_json: string | null
  source: string
  created_at: number
  group_id: string | null
  v: number | null
  full: number | null
  scope: string | null
}

interface BlockInsert {
  id: string
  workspace_id: string
  parent_id: string | null
  order_key: string
  content: string
  properties_json: string
  references_json: string
  created_at: number
  updated_at: number
  user_updated_at: number | null
  created_by: string
  updated_by: string
  deleted: 0 | 1
}

const defaultBlock: BlockInsert = {
  id: 'b1',
  workspace_id: 'ws1',
  parent_id: null,
  order_key: 'a0',
  content: 'hello',
  properties_json: '{}',
  references_json: '[]',
  created_at: 1700000000000,
  updated_at: 1700000000000,
  user_updated_at: 1700000000000,
  created_by: 'u1',
  updated_by: 'u1',
  deleted: 0,
}

const setupDb = () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE ps_crud (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, tx_id INTEGER)')
  db.exec(CREATE_BLOCKS_TABLE_SQL)
  db.exec(CREATE_BLOCKS_SYNCED_TABLE_SQL)
  db.exec(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) db.exec(stmt)
  return db
}

const historyDb = (db: DatabaseSync): RowEventsHistoryDb => ({
  getAll: <T,>(sql: string, params: unknown[] = []) =>
    Promise.resolve(db.prepare(sql).all(...(params as (string | number)[])) as T[]),
})

/** Swap the update-trigger body for a deterministic-coin variant. */
const installUpdateTrigger = (db: DatabaseSync, coinSql?: string) => {
  db.exec('DROP TRIGGER IF EXISTS blocks_row_event_update')
  db.exec(coinSql === undefined
    ? CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL
    : buildBlocksUpdateRowEventTriggerSql(coinSql))
}

let db: DatabaseSync
beforeEach(() => { db = setupDb() })
afterEach(() => { db.close() })

const insertBlock = (overrides: Partial<BlockInsert> = {}) => {
  const row = {...defaultBlock, ...overrides}
  const names = BLOCK_STORAGE_COLUMNS.map(c => c.name)
  db.prepare(`INSERT INTO blocks (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    .run(...names.map(n => row[n]))
}

const updateBlock = (id: string, set: Record<string, string | number | null>) => {
  const cols = Object.keys(set)
  db.prepare(`UPDATE blocks SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map(c => set[c]), id)
}

const rowEvents = (): RowEventRow[] =>
  db.prepare('SELECT * FROM row_events ORDER BY id').all() as unknown as RowEventRow[]

const lastEvent = (): RowEventRow => {
  const events = rowEvents()
  expect(events.length).toBeGreaterThan(0)
  return events[events.length - 1]
}

const parsedKeys = (json: string | null): string[] =>
  json === null ? [] : Object.keys(JSON.parse(json) as Record<string, unknown>).sort()

describe('v2 create/delete events', () => {
  it('create stamps v=2, full=1, NULL before, full 13-key domain snapshot after', () => {
    insertBlock()
    const e = lastEvent()
    expect(e).toMatchObject({kind: 'create', v: ROW_EVENTS_FORMAT_VERSION, full: 1, before_json: null})
    const after = JSON.parse(e.after_json!) as Record<string, unknown>
    expect(Object.keys(after).sort()).toEqual([...DOMAIN_KEYS].sort())
    expect(after).toMatchObject({
      id: 'b1', workspaceId: 'ws1', parentId: null, content: 'hello',
      properties: {}, references: [], deleted: false, userUpdatedAt: 1700000000000,
    })
  })

  it('hard delete stamps v=2, full=1, full before snapshot, NULL after', () => {
    insertBlock()
    db.prepare('DELETE FROM blocks WHERE id = ?').run('b1')
    const e = lastEvent()
    expect(e).toMatchObject({kind: 'delete', v: ROW_EVENTS_FORMAT_VERSION, full: 1, after_json: null})
    expect(parsedKeys(e.before_json)).toEqual([...DOMAIN_KEYS].sort())
  })
})

describe('v2 update events — compact patches (p = 0 coin)', () => {
  beforeEach(() => installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL))

  it('stores changed fields only, old values before / new values after, equal key sets', () => {
    insertBlock()
    updateBlock('b1', {content: 'world', updated_at: 1700000001000})
    const e = lastEvent()
    expect(e).toMatchObject({kind: 'update', v: ROW_EVENTS_FORMAT_VERSION, full: 0})
    // userUpdatedAt is pinned (user_updated_at = 1700000000000), so only the
    // two written columns' domain keys appear.
    expect(JSON.parse(e.before_json!)).toEqual({content: 'hello', updatedAt: 1700000000000})
    expect(JSON.parse(e.after_json!)).toEqual({content: 'world', updatedAt: 1700000001000})
  })

  it('records a cleared nullable field as JSON null (key present = changed)', () => {
    insertBlock({id: 'p1'})
    insertBlock({id: 'b2', parent_id: 'p1'})
    updateBlock('b2', {parent_id: null})
    const e = lastEvent()
    expect(JSON.parse(e.before_json!)).toEqual({parentId: 'p1'})
    expect(JSON.parse(e.after_json!)).toEqual({parentId: null})
  })

  it('identical update writes NO event (the no-op skip), and a real change after it still logs', () => {
    insertBlock()
    const before = rowEvents().length
    updateBlock('b1', {content: 'hello', updated_at: 1700000000000})
    updateBlock('b1', {content: 'hello'})
    expect(rowEvents().length).toBe(before)
    // Control write — proves the trigger is still installed and firing.
    updateBlock('b1', {content: 'changed'})
    expect(rowEvents().length).toBe(before + 1)
  })

  it('soft-delete transition writes kind=soft-delete as a compact patch', () => {
    insertBlock()
    updateBlock('b1', {deleted: 1})
    const e = lastEvent()
    expect(e).toMatchObject({kind: 'soft-delete', full: 0})
    expect(JSON.parse(e.before_json!)).toEqual({deleted: false})
    expect(JSON.parse(e.after_json!)).toEqual({deleted: true})
  })

  it('properties-only update logs, with the whole new cell value (I4: no column exemptions)', () => {
    insertBlock()
    updateBlock('b1', {properties_json: '{"k":1}'})
    const e = lastEvent()
    expect(e).toMatchObject({kind: 'update', full: 0})
    expect(JSON.parse(e.before_json!)).toEqual({properties: {}})
    expect(JSON.parse(e.after_json!)).toEqual({properties: {k: 1}})
  })

  describe('projected userUpdatedAt diff (design §3)', () => {
    it('updated_at-only change while user_updated_at is NULL emits BOTH updatedAt and userUpdatedAt', () => {
      insertBlock({user_updated_at: null})
      updateBlock('b1', {updated_at: 1700000002000})
      const e = lastEvent()
      expect(JSON.parse(e.before_json!)).toEqual({updatedAt: 1700000000000, userUpdatedAt: 1700000000000})
      expect(JSON.parse(e.after_json!)).toEqual({updatedAt: 1700000002000, userUpdatedAt: 1700000002000})
    })

    it('storage-only backfill (user_updated_at NULL → current updated_at) is a domain no-op: no event', () => {
      insertBlock({user_updated_at: null})
      const before = rowEvents().length
      updateBlock('b1', {user_updated_at: 1700000000000})
      expect(rowEvents().length).toBe(before)
    })
  })

  it('a raw id rewrite forces full=1 under the NEW id (design §3 — never vanishes under the skip)', () => {
    insertBlock()
    updateBlock('b1', {id: 'b1-moved'})
    const e = lastEvent()
    expect(e).toMatchObject({kind: 'update', block_id: 'b1-moved', v: ROW_EVENTS_FORMAT_VERSION, full: 1})
    expect(parsedKeys(e.before_json)).toEqual([...DOMAIN_KEYS].sort())
    expect(parsedKeys(e.after_json)).toEqual([...DOMAIN_KEYS].sort())
    expect((JSON.parse(e.before_json!) as {id: string}).id).toBe('b1')
    expect((JSON.parse(e.after_json!) as {id: string}).id).toBe('b1-moved')
  })
})

describe('v2 update events — anchors (p = 1 coin)', () => {
  beforeEach(() => installUpdateTrigger(db, ANCHOR_COIN_ALWAYS_SQL))

  it('anchor carries full before AND after snapshots with full=1', () => {
    insertBlock()
    updateBlock('b1', {content: 'world'})
    const e = lastEvent()
    expect(e).toMatchObject({kind: 'update', v: ROW_EVENTS_FORMAT_VERSION, full: 1})
    expect(parsedKeys(e.before_json)).toEqual([...DOMAIN_KEYS].sort())
    expect(parsedKeys(e.after_json)).toEqual([...DOMAIN_KEYS].sort())
  })

  it('identical update still writes no event even when the coin would hit', () => {
    insertBlock()
    const before = rowEvents().length
    updateBlock('b1', {content: 'hello'})
    expect(rowEvents().length).toBe(before)
  })
})

describe('v2 shape under the PRODUCTION random coin (anchor-agnostic — the one-coin trap)', () => {
  it('both payload sides always agree with the full flag: never a full side paired with a patch side', () => {
    insertBlock()
    // Enough updates that both coin outcomes almost surely occur (p = 1/64;
    // 400 flips miss an anchor with probability ~0.2% — and the property
    // holds either way, this is not a distribution assertion).
    for (let i = 0; i < 400; i++) {
      updateBlock('b1', {content: `c${i}`, updated_at: 1700000000000 + i})
    }
    const fullKeys = [...DOMAIN_KEYS].sort()
    for (const e of rowEvents()) {
      if (e.kind !== 'update') continue
      const beforeKeys = parsedKeys(e.before_json)
      const afterKeys = parsedKeys(e.after_json)
      expect(afterKeys).toEqual(beforeKeys)
      if (e.full === 1) {
        expect(beforeKeys).toEqual(fullKeys)
      } else {
        expect(e.full).toBe(0)
        // user_updated_at is pinned non-NULL, so userUpdatedAt never moves;
        // the first iteration writes the unchanged updated_at value.
        expect([['content'], ['content', 'updatedAt']]).toContainEqual(beforeKeys)
      }
    }
  })
})

describe('trigger-spec coverage tripwire', () => {
  it('the update trigger WHEN gate references every blocks storage column (a dropped/typoed predicate would silently unlog that column — I3)', () => {
    // ROW_EVENT_COLUMNS is a hand-maintained projection of
    // BLOCK_STORAGE_COLUMNS; this pins the lockstep rule structurally, so a
    // column added to blocks without a row_events spec entry (or a predicate
    // typoed into OLD.x IS NOT OLD.x) fails here instead of silently
    // vanishing under the identical-update skip.
    const whenClause = CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL.match(/WHEN([\s\S]*?)BEGIN/)?.[1]
    expect(whenClause).toBeTruthy()
    for (const {name} of BLOCK_STORAGE_COLUMNS) {
      expect(whenClause).toContain(`OLD.${name}`)
      expect(whenClause).toContain(`NEW.${name}`)
    }
  })
})

describe('scope stamp (source-gated projection)', () => {
  const setCtx = (fields: Record<string, string | null>) => {
    const cols = Object.keys(fields)
    db.prepare(`UPDATE tx_context SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = 1`)
      .run(...cols.map(c => fields[c]))
  }

  it("copies tx_context.scope on local writes (source IS NOT NULL)", () => {
    setCtx({source: 'user', scope: 'local-ui', tx_id: 't1'})
    insertBlock()
    expect(lastEvent()).toMatchObject({scope: 'local-ui', source: 'user', tx_id: 't1'})
  })

  it('stamps scope = NULL on NULL-source writes even when tx_context.scope is poisoned (design §3 — a mislabeled scope would become sweeper-prunable history)', () => {
    setCtx({source: null, scope: 'local-ui', tx_id: 'stale'})
    insertBlock()
    expect(lastEvent()).toMatchObject({scope: null, tx_id: null, source: 'sync'})
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    updateBlock('b1', {content: 'x'})
    expect(lastEvent()).toMatchObject({scope: null, tx_id: null, source: 'sync', kind: 'update'})
    db.prepare('DELETE FROM blocks WHERE id = ?').run('b1')
    expect(lastEvent()).toMatchObject({scope: null, tx_id: null, source: 'sync', kind: 'delete'})
  })
})

describe('stateAt (design §4.3)', () => {
  const suspendRowEventTriggers = (fn: () => void) => {
    db.exec('DROP TRIGGER IF EXISTS blocks_row_event_insert')
    db.exec('DROP TRIGGER IF EXISTS blocks_row_event_update')
    db.exec('DROP TRIGGER IF EXISTS blocks_row_event_delete')
    try {
      fn()
    } finally {
      db.exec(CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL)
      db.exec(buildBlocksUpdateRowEventTriggerSql(ANCHOR_COIN_NEVER_SQL))
      db.exec(CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL)
    }
  }

  it('answers full events (create / anchor / delete) from their own payload', async () => {
    installUpdateTrigger(db, ANCHOR_COIN_ALWAYS_SQL)
    insertBlock()
    updateBlock('b1', {content: 'v2'})
    db.prepare('DELETE FROM blocks WHERE id = ?').run('b1')
    const [create, anchor, del] = rowEvents()
    expect(await stateAt(historyDb(db), create.id)).toMatchObject({content: 'hello'})
    expect(await stateAt(historyDb(db), anchor.id)).toMatchObject({content: 'v2'})
    // delete: the tombstone content (state just before the purge)
    expect(await stateAt(historyDb(db), del.id)).toMatchObject({content: 'v2'})
  })

  it('reconstructs every compact event of a live chain (walks may go either direction)', async () => {
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    insertBlock()
    const contents = ['a', 'b', 'c', 'd', 'e']
    for (const c of contents) updateBlock('b1', {content: c})
    const events = rowEvents()
    expect(events.map(e => e.kind)).toEqual(['create', 'update', 'update', 'update', 'update', 'update'])
    const expected = ['hello', ...contents]
    for (const [i, e] of events.entries()) {
      expect((await stateAt(historyDb(db), e.id)).content).toBe(expected[i])
    }
  })

  it('reconstructs compact events after the live row is hard-deleted (delete event terminates the walk)', async () => {
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    insertBlock()
    updateBlock('b1', {content: 'a'})
    updateBlock('b1', {content: 'b'})
    db.prepare('DELETE FROM blocks WHERE id = ?').run('b1')
    const events = rowEvents()
    expect((await stateAt(historyDb(db), events[1].id)).content).toBe('a')
    expect((await stateAt(historyDb(db), events[2].id)).content).toBe('b')
  })

  it('walks backward from the live row across a pre-log gap (no create event exists)', async () => {
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    suspendRowEventTriggers(() => insertBlock())
    updateBlock('b1', {content: 'a'})
    updateBlock('b1', {content: 'b'})
    const events = rowEvents()
    expect(events.map(e => e.kind)).toEqual(['update', 'update'])
    expect((await stateAt(historyDb(db), events[0].id)).content).toBe('a')
    expect((await stateAt(historyDb(db), events[1].id)).content).toBe('b')
  })

  it('throws HistoryWalkError when no full state is reachable on either side (corruption signal, never a guess)', async () => {
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    suspendRowEventTriggers(() => insertBlock())
    updateBlock('b1', {content: 'a'})
    const [compact] = rowEvents()
    // Purge the live row with the delete trigger suspended too: the chain now
    // has no older base (pre-log create), no newer terminator, no live row.
    suspendRowEventTriggers(() => db.prepare('DELETE FROM blocks WHERE id = ?').run('b1'))
    await expect(stateAt(historyDb(db), compact.id)).rejects.toThrow(HistoryWalkError)
  })

  it('reconstructs compact events after an UNLOGGED delete+recreate (backward walk from the new live generation)', async () => {
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    insertBlock()                                              // create(1)
    db.prepare('DELETE FROM blocks WHERE id = ?').run('b1')    // delete(2)
    suspendRowEventTriggers(() => insertBlock({content: 'g2'})) // unlogged recreate
    updateBlock('b1', {content: 'g2a'})                        // compact(3)
    updateBlock('b1', {content: 'g2b'})                        // compact(4)
    const events = rowEvents()
    expect(events.map(e => e.kind)).toEqual(['create', 'delete', 'update', 'update'])
    // The compact events are NEWER than the gap — the backward walk from the
    // live row is exact, and must not be poisoned by (or throw on) the old
    // generation's create/delete on the forward side.
    expect((await stateAt(historyDb(db), events[2].id)).content).toBe('g2a')
    expect((await stateAt(historyDb(db), events[3].id)).content).toBe('g2b')
  })

  it('falls back to the forward walk when an unlogged purge+recreate makes the live generation unreachable', async () => {
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    insertBlock()                                              // create(1)
    for (const c of ['a', 'b', 'c']) updateBlock('b1', {content: c}) // compact(2,3,4)
    suspendRowEventTriggers(() => db.prepare('DELETE FROM blocks WHERE id = ?').run('b1'))
    insertBlock({content: 'gen2'})                             // create(5), live
    const events = rowEvents()
    expect(events.map(e => e.kind)).toEqual(['create', 'update', 'update', 'update', 'create'])
    // Backward from the live row is severed by the gen-2 create; the forward
    // walk from gen-1's own create still answers exactly.
    expect((await stateAt(historyDb(db), events[1].id)).content).toBe('a')
    expect((await stateAt(historyDb(db), events[2].id)).content).toBe('b')
    expect((await stateAt(historyDb(db), events[3].id)).content).toBe('c')
    expect((await stateAt(historyDb(db), events[4].id)).content).toBe('gen2')
  })

  it('handles a v1/v2 INTERLEAVED log — a stale-tab v1 full update serves as terminator and base', async () => {
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    insertBlock()                                              // v2 create(1)
    updateBlock('b1', {content: 'a'})                          // compact(2)
    // Stale tab on old code reinstalls the v1 body (full both sides, no
    // v/full/scope columns) — recreate that exact shape.
    db.exec('DROP TRIGGER IF EXISTS blocks_row_event_update')
    db.exec(`
      CREATE TRIGGER blocks_row_event_update AFTER UPDATE ON blocks BEGIN
        INSERT INTO row_events (tx_id, block_id, kind, before_json, after_json, source, created_at)
        VALUES (NULL, NEW.id, 'update', ${blockJsonObjectSql('OLD')}, ${blockJsonObjectSql('NEW')}, 'sync',
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
      END
    `)
    updateBlock('b1', {content: 'v1write'})                    // v1 full(3)
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    updateBlock('b1', {content: 'z'})                          // compact(4)
    const events = rowEvents()
    expect(events[2].v).toBeNull()
    expect((await stateAt(historyDb(db), events[1].id)).content).toBe('a')       // v1 before side terminates
    expect((await stateAt(historyDb(db), events[2].id)).content).toBe('v1write') // v1 answers itself
    expect((await stateAt(historyDb(db), events[3].id)).content).toBe('z')       // v1 after side is a base
  })

  it('id-rewrite chains: the NEW id reads via the forced-full pair; the orphaned old-id chain recovers via its older-side fulls', async () => {
    installUpdateTrigger(db, ANCHOR_COIN_NEVER_SQL)
    insertBlock()                                              // create b1 (1)
    updateBlock('b1', {content: 'a'})                          // compact b1 (2)
    updateBlock('b1', {id: 'b1-moved'})                        // forced full, block_id b1-moved (3)
    updateBlock('b1-moved', {content: 'c'})                    // compact b1-moved (4)
    const events = rowEvents()
    expect((await stateAt(historyDb(db), events[3].id)).content).toBe('c')
    expect((await stateAt(historyDb(db), events[2].id)).id).toBe('b1-moved')
    // Old-id chain: no live b1 row, no newer b1 events — forward from create.
    expect((await stateAt(historyDb(db), events[1].id)).content).toBe('a')
  })

  it('reads v1 rows (v IS NULL) as full snapshots', async () => {
    db.prepare(`
      INSERT INTO row_events (tx_id, block_id, kind, before_json, after_json, source, created_at)
      VALUES (NULL, 'b-v1', 'update', '{"content":"old"}', '{"content":"new"}', 'sync', 1700000000000)
    `).run()
    expect((await stateAt(historyDb(db), lastEvent().id)).content).toBe('new')
  })
})

describe('ensureRowEventsV2Columns', () => {
  it('adds v/full/scope to an old-shape table, idempotently', async () => {
    const old = new DatabaseSync(':memory:')
    old.exec(`
      CREATE TABLE row_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id       TEXT,
        block_id    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        before_json TEXT,
        after_json  TEXT,
        source      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        group_id    TEXT
      )
    `)
    const facade = {
      execute: async (sql: string) => { old.exec(sql) },
      getAll: async <T,>(sql: string): Promise<T[]> => old.prepare(sql).all() as T[],
    }
    await ensureRowEventsV2Columns(facade)
    await ensureRowEventsV2Columns(facade) // second run: no duplicate-column throw
    const names = (old.prepare('PRAGMA table_info(row_events)').all() as Array<{name: string}>).map(c => c.name)
    expect(names).toEqual([
      'id', 'tx_id', 'block_id', 'kind', 'before_json', 'after_json', 'source',
      'created_at', 'group_id', 'v', 'full', 'scope',
    ])
    old.close()
  })

  it('skips a missing table (fresh DB — CREATE carries the columns, appended last in the same order)', async () => {
    const executed: string[] = []
    await ensureRowEventsV2Columns({
      execute: async (sql: string) => { executed.push(sql) },
      getAll: async <T,>(): Promise<T[]> => [],
    })
    expect(executed).toEqual([])
  })
})
