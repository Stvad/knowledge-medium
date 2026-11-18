// @vitest-environment node
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
} from '@/data/blockSchema.js'
import {
  CREATE_BLOCK_REFERENCES_TABLE_SQL,
  CREATE_BLOCK_REFERENCES_WS_ALIAS_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,
} from '@/plugins/references/localSchema.js'
import type { AuditDb } from '../audit.js'
import { runReferencesMirrorCheck } from '../referencesMirror.js'

let sqlite: DatabaseSync
const db: AuditDb = {
  getAll: async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    sqlite.prepare(sql).all(...params as SQLInputValue[]) as T[],
}

const block = (id: string, references: string, workspace = 'ws', properties = '{}', deleted = 0) =>
  sqlite.prepare(`INSERT INTO blocks
    (id, workspace_id, order_key, properties_json, references_json,
     created_at, updated_at, created_by, updated_by, deleted)
    VALUES (?, ?, 'a0', ?, ?, 1, 1, 'user', 'user', ?)`)
    .run(id, workspace, properties, references, deleted)

const edge = (source: string, target: string, alias: string, workspace = 'ws', sourceField = '') =>
  sqlite.prepare(`INSERT INTO block_references (source_id, target_id, workspace_id, alias, source_field)
    VALUES (?, ?, ?, ?, ?)`).run(source, target, workspace, alias, sourceField)

beforeAll(() => {
  sqlite = new DatabaseSync(':memory:')
  // The tables have their production indexes, but no triggers to repair the fixtures.
  sqlite.exec(CREATE_BLOCKS_TABLE_SQL)
  sqlite.exec(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  sqlite.exec(CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL)
  sqlite.exec(CREATE_BLOCK_REFERENCES_TABLE_SQL)
  sqlite.exec(CREATE_BLOCK_REFERENCES_WS_ALIAS_INDEX_SQL)
})
beforeEach(() => sqlite.exec('DELETE FROM block_references; DELETE FROM blocks'))
afterAll(() => sqlite.close())

it('counts each missing occurrence and each duplicate tuple while scoping both directions', async () => {
  block('tuples', JSON.stringify([
    { id: 'a', alias: 'missing' },
    { id: 'a', alias: 'missing', sourceField: '' },
    { id: 'b', alias: 'present', sourceField: 'topic' },
    { id: 'b', alias: 'present', sourceField: 'topic' },
    { id: 'b', alias: 'present', sourceField: 'topic' },
    { id: 'b', alias: 'present', sourceField: 'other-topic' },
    { id: 'c', alias: 'nullable-field', sourceField: null },
    { id: 'ignored', alias: 'invalid-field', sourceField: 7 },
  ]))
  edge('tuples', 'b', 'present', 'other-ws', 'topic')
  edge('tuples', 'c', 'nullable-field')
  edge('tuples', 'ignored', 'invalid-field', 'ws', '7')
  edge('tuples', 'a', 'different alias', 'other-ws')
  edge('tuples', 'ignored', 'stale-index', 'other-ws')

  block('foreign-live', '[{"id":"a","alias":"matched"},{"id":"b","alias":"out of scope"}]', 'other-ws')
  edge('foreign-live', 'a', 'matched')
  edge('foreign-live', 'a', 'extra')
  block('deleted', 'unparseable', 'ws', '{}', 1)
  edge('deleted', 'a', 'orphan')
  edge('gone', 'a', 'orphan')

  expect(await runReferencesMirrorCheck(db, 'ws', 8)).toEqual({
    status: 'anomaly',
    missingIndexRows: 3,
    extraIndexRows: 1,
    orphanSourceRows: 2,
    duplicateTuples: 2,
    malformedJson: 0,
    malformedRefsShape: 0,
    samples: ['tuples', 'foreign-live', 'deleted', 'gone'],
  })
})

it('counts unparseable storage and non-array JSON separately', async () => {
  block('invalid-refs-and-properties', 'unparseable', 'ws', 'unparseable')
  edge('invalid-refs-and-properties', 'a', 'extra')
  block('invalid-properties', '[]', 'ws', 'unparseable')
  block('scalar-shape', 'null')
  edge('scalar-shape', 'a', 'extra')
  block('array-shape', '[null,{"id":"a","alias":"missing"}]')
  edge('array-shape', 'b', 'extra')
  block('foreign-shape', '"out of scope"', 'other-ws')

  expect(await runReferencesMirrorCheck(db, 'ws', 8)).toEqual({
    status: 'anomaly',
    missingIndexRows: 1,
    extraIndexRows: 3,
    orphanSourceRows: 0,
    duplicateTuples: 0,
    malformedJson: 2,
    malformedRefsShape: 1,
    samples: ['scalar-shape', 'array-shape', 'invalid-refs-and-properties'],
  })
})

it('surfaces unreadable reference elements as a check error', async () => {
  block('bad-element', '["unreadable"]')
  await expect(runReferencesMirrorCheck(db, 'ws', 8)).rejects.toThrow(/malformed JSON/i)
})

it('opens a source reference array only once for a page of outgoing index entries', async () => {
  const refs = Array.from({ length: 64 }, (_, n) => ({ id: String(n), alias: 'link' }))
  const sourceJson = JSON.stringify(refs)
  block('source', sourceJson, 'other-ws')
  for (const ref of refs) edge('source', ref.id, ref.alias)
  let sourceReads = 0
  // Only the reverse scan visits this source. Count evaluations of the input
  // to json_each rather than measuring wall time.
  sqlite.function('json_valid', value => {
    if (value === sourceJson) sourceReads++
    try {
      JSON.parse(String(value))
      return 1
    } catch {
      return 0
    }
  })

  expect(await runReferencesMirrorCheck(db, 'ws', 8)).toMatchObject({ status: 'ok' })
  expect(sourceReads).toBe(1)
})

it('checks foreign index tuples independently of unrelated unreadable source elements', async () => {
  block('foreign', '[{"id":"a","alias":"valid"},"unreadable"]', 'other-ws')
  edge('foreign', 'a', 'valid')
  edge('foreign', 'b', 'extra')
  expect(await runReferencesMirrorCheck(db, 'ws', 8)).toMatchObject({
    status: 'anomaly', extraIndexRows: 1, samples: ['foreign'],
  })
  await expect(runReferencesMirrorCheck(db, 'other-ws', 8)).rejects.toThrow(/malformed JSON/i)
})

it('continues after full ranges in other workspaces and caps distinct samples', async () => {
  sqlite.exec(`WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 4100)
    INSERT INTO blocks (id, workspace_id, order_key, created_at, updated_at, created_by, updated_by)
    SELECT 'outside-' || n, 'other-ws', 'a0', 1, 1, 'user', 'user' FROM numbers`)
  sqlite.exec(`WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 4100)
    INSERT INTO block_references (source_id, target_id, workspace_id, alias)
    SELECT 'outside-1', 'target-' || n, 'other-ws', 'alias' FROM numbers`)
  block('late-missing', '[{"id":"a","alias":"missing"}]')
  edge('orphan-1', 'a', 'extra')
  edge('orphan-1', 'b', 'extra')
  edge('orphan-2', 'a', 'extra')
  edge('orphan-3', 'a', 'extra')

  expect(await runReferencesMirrorCheck(db, 'ws', 3)).toMatchObject({
    status: 'anomaly',
    missingIndexRows: 1,
    orphanSourceRows: 4,
    samples: ['late-missing', 'orphan-1', 'orphan-2'],
  })
})
