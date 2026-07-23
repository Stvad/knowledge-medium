// @vitest-environment node
/**
 * The synced-table SQL recognizer used to exist TWICE: once in TypeScript
 * (`src/data/syncedTableWriteGuard.ts`, used by the runtime guard and the agent
 * bridge) and once in plain JS (`eslint-rules/no-raw-synced-table-writes.js`),
 * because ESLint loads rule files natively with no transpile step and the
 * app's tsconfigs don't enable `allowJs` — so neither side could import the
 * other. Three separate review rounds found a hole in that recognizer (CTE
 * prefixes, schema qualifiers, multi-statement scripts), and each fix had to
 * be applied to both copies by hand; this file used to just assert the two
 * copies agreed, without pinning what the agreed-upon answer should BE.
 *
 * As of 2026-07-20 there is exactly one implementation
 * (`src/data/syncedTableSqlRecognizer.js`, plain JS + a co-located `.d.ts` —
 * see that file's module doc for why no `allowJs` is needed): the guard
 * re-exports it, and the ESLint rule imports it directly. So this is now a
 * plain behavioral test of that single parser, pinning `syncedWriteTarget`'s
 * verdict for each case in the corpus that used to keep the two copies
 * honest — the corpus's coverage (every hole three review rounds found)
 * survives the merge.
 *
 * It still also runs the corpus through the ESLint rule's own report path
 * (`lintRuleTarget`), not just through `syncedWriteTarget` directly: a wiring
 * mistake — the rule importing a stale copy, or the guard's re-export
 * dropping a name — would otherwise go undetected even though there's only
 * one algorithm now.
 */

import { describe, expect, it } from 'vitest'
import { syncedWriteTarget } from '@/data/syncedTableWriteGuard.ts'
// The rule module doesn't export its internals, so exercise it the way ESLint
// does — through a report — and read the table name out of the message data.
// Plain JS with no declaration file, same as the rule's own test.
// @ts-expect-error no declaration file for the local rule module
import noRawSyncedTableWrites from '../../eslint-rules/no-raw-synced-table-writes.js'

/** Run the lint rule's recognizer over one SQL string, returning the synced
 *  table it would report, or null. */
const lintRuleTarget = (sql: string): string | null => {
  const rule = (noRawSyncedTableWrites as {
    rules: Record<string, {create: (ctx: unknown) => unknown}>
  }).rules['no-raw-synced-table-writes']
  let reported: string | null = null
  const context = {
    report: ({data}: {data?: {table?: string}}) => {
      reported = data?.table ?? null
    },
  }

  const visitors = rule.create(context) as {Literal: (node: unknown) => void}
  visitors.Literal({type: 'Literal', value: sql})
  return reported
}

/** [sql, expected synced-write target (or null)]. Expected values are what
 *  the recognizer actually returns for each case — see the case-by-case
 *  rationale comments below for WHY each one lands where it does. */
const CORPUS: ReadonlyArray<readonly [string, string | null]> = [
  // Plain writes
  ['UPDATE blocks SET content = ?', 'blocks'],
  ['INSERT INTO blocks (id) VALUES (?)', 'blocks'],
  ['DELETE FROM blocks WHERE deleted = 1', 'blocks'],
  ['INSERT OR REPLACE INTO workspaces (id) VALUES (?)', 'workspaces'],
  ['REPLACE INTO workspace_members (id) VALUES (?)', 'workspace_members'],
  // Reads / DDL
  ['SELECT * FROM blocks WHERE deleted = 0', null],
  ['PRAGMA optimize', null],
  ['CREATE INDEX IF NOT EXISTS i ON blocks (x) WHERE deleted = 0', null],
  // A trigger HEADER naming blocks isn't a write, but this header's BODY
  // contains a real `UPDATE blocks` — position doesn't matter (module doc),
  // so this is a hit despite living in a "reads" comment block.
  ['CREATE TRIGGER t AFTER UPDATE ON blocks BEGIN UPDATE blocks SET x=1; END', 'blocks'],
  // Destructive DDL — a target, same as DML (PR #386 review)
  ['DROP TABLE blocks', 'blocks'],
  ['DROP TABLE IF EXISTS workspaces', 'workspaces'],
  ["DROP TABLE 'blocks'", 'blocks'],
  ['DROP TABLE main . blocks', 'blocks'],
  // Single-quoted ALTER targets. Proven necessary, not speculative: deleting
  // the quoted-ALTER regex from one parser left all other corpus entries in
  // agreement, so the drift was undetectable without these two.
  ["ALTER TABLE 'workspaces' RENAME TO ws_old", 'workspaces'],
  ["ALTER TABLE 'blocks' DROP COLUMN content", 'blocks'],
  ['ALTER TABLE workspaces RENAME TO ws_old', 'workspaces'],
  ['ALTER TABLE blocks RENAME COLUMN content TO body', 'blocks'],
  ['ALTER TABLE blocks DROP COLUMN content', 'blocks'],
  // Additive DDL + trigger/index maintenance — NOT a target; the bootstrap
  // runs these on synced tables through the guarded handle, so a parser that
  // flags them bricks startup.
  ['ALTER TABLE blocks ADD COLUMN reference_target_id TEXT', null],
  ["ALTER TABLE workspaces ADD COLUMN properties_migration TEXT", null],
  ['DROP TRIGGER IF EXISTS blocks_upload_insert', null],
  ['DROP INDEX IF EXISTS idx_blocks_parent', null],
  ['DROP TABLE block_aliases', null],
  // Local tables that merely look similar
  ['INSERT OR IGNORE INTO block_aliases (block_id) SELECT id FROM blocks', null],
  ['INSERT INTO blocks_fts_rowids (block_id) VALUES (?)', null],
  ['DELETE FROM blocks_synced_changes WHERE seq <= ?', null],
  // Comments / whitespace / quoting
  ['\n  UPDATE "blocks" SET x = 1', 'blocks'],
  ['-- migrate\nUPDATE [blocks] SET x = 1', 'blocks'],
  ['/* c */ INSERT INTO `blocks` (id) VALUES (?)', 'blocks'],
  // Schema qualifiers
  ['UPDATE main.blocks SET content = ?', 'blocks'],
  ['INSERT INTO "main"."blocks" (id) VALUES (?)', 'blocks'],
  ['DELETE FROM [main].[workspace_members] WHERE id = ?', 'workspace_members'],
  ['UPDATE "a.b" SET x = 1', null],
  ['INSERT INTO main.block_aliases (block_id) VALUES (?)', null],
  // CTE prefixes
  ['WITH ids AS (SELECT id FROM blocks_synced) UPDATE blocks SET content = ?', 'blocks'],
  ['WITH RECURSIVE up(id, depth) AS (SELECT id, 0 FROM blocks) SELECT * FROM up', null],
  [`WITH x AS (SELECT '(' AS c FROM blocks) UPDATE blocks SET content = ?`, 'blocks'],
  ['WITH updates AS (SELECT 1) SELECT * FROM updates', null],
  ['WITH a AS (SELECT 1), b AS (SELECT 2) INSERT INTO workspaces (id) SELECT 1', 'workspaces'],
  // Whitespace around the qualifier dot
  ['UPDATE main . blocks SET x = 1', 'blocks'],
  ['INSERT INTO "main" . "blocks" (id) VALUES (?)', 'blocks'],
  ['UPDATE main . block_aliases SET x = 1', null],
  // Comments between keywords, and DML nested in a trigger body
  ['UPDATE /* note */ blocks SET x = 1', 'blocks'],
  ['INSERT /* note */ INTO blocks (id) VALUES (?)', 'blocks'],
  ['DELETE /* note */ FROM blocks WHERE id = ?', 'blocks'],
  ['CREATE TRIGGER t AFTER INSERT ON local_table BEGIN UPDATE blocks SET x = 1; END', 'blocks'],
  ['CREATE TRIGGER t AFTER UPDATE OF x ON blocks BEGIN SELECT 1; END', null],
  [`INSERT INTO block_aliases (note) VALUES ('update blocks now')`, null],
  // Multi-statement scripts
  ['CREATE INDEX i ON blocks (x); UPDATE blocks SET content = ?', 'blocks'],
  ['SELECT 1; DELETE FROM blocks WHERE id = ?', 'blocks'],
  ['INSERT INTO block_aliases (block_id) VALUES (?); SELECT 1', null],
  [`INSERT INTO block_aliases (x) VALUES (';'); SELECT 1`, null],
  ['CREATE INDEX a ON blocks (x); CREATE INDEX b ON blocks (y)', null],
  [`UPDATE 'blocks' SET content = ?`, 'blocks'],
  [`DELETE FROM 'blocks' WHERE id = ?`, 'blocks'],
  [`INSERT INTO 'workspaces' (id) VALUES (?)`, 'workspaces'],
  [`UPDATE 'main'.'blocks' SET x = 1`, 'blocks'],
  [`UPDATE main . 'blocks' SET x = 1`, 'blocks'],
  [`INSERT INTO block_aliases (note) VALUES ('update blocks now')`, null],
  [`UPDATE 'block_aliases' SET x = 1`, null],
  [`UPDATE /* note */ blocks SET x = 1`, 'blocks'],
  ['CREATE TRIGGER t AFTER INSERT ON local BEGIN UPDATE blocks SET x = 1; END', 'blocks'],
  ['CREATE TRIGGER t AFTER UPDATE OF x ON blocks BEGIN SELECT 1; END', null],
]

describe('synced-table SQL recognizer (single shared parser)', () => {
  it.each(CORPUS)('%s', (sql, expected) => {
    expect(syncedWriteTarget(sql)).toBe(expected)
  })

  // Same corpus, through the ESLint rule's own report path — proves the rule
  // is actually wired to the shared parser, not a stale/forked copy.
  it.each(CORPUS)('ESLint rule: %s', (sql, expected) => {
    expect(lintRuleTarget(sql)).toBe(expected)
  })
})
