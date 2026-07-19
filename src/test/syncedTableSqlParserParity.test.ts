// @vitest-environment node
/**
 * The synced-table SQL recognizer exists TWICE: once in TypeScript
 * (`src/data/syncedTableWriteGuard.ts`, used by the runtime guard and the agent
 * bridge) and once in plain JS (`eslint-rules/no-raw-synced-table-writes.js`),
 * because ESLint loads rule files natively with no transpile step and the app's
 * tsconfigs don't enable `allowJs` — so neither side can import the other.
 *
 * Three separate review rounds have now found a hole in that recognizer (CTE
 * prefixes, schema qualifiers, multi-statement scripts), and each fix had to be
 * applied to both copies by hand. This test makes the fourth divergence a test
 * failure instead of a silently weaker lint rule: both parsers run over one
 * corpus and must agree on every case.
 *
 * It deliberately asserts AGREEMENT, not specific answers — the per-parser
 * behaviour is pinned by `syncedTableWriteGuard.test.ts` and
 * `noRawSyncedTableWritesLintRule.test.ts`. What can't be pinned there is that
 * the two stay the same parser.
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

const CORPUS = [
  // Plain writes
  'UPDATE blocks SET content = ?',
  'INSERT INTO blocks (id) VALUES (?)',
  'DELETE FROM blocks WHERE deleted = 1',
  'INSERT OR REPLACE INTO workspaces (id) VALUES (?)',
  'REPLACE INTO workspace_members (id) VALUES (?)',
  // Reads / DDL
  'SELECT * FROM blocks WHERE deleted = 0',
  'PRAGMA optimize',
  'CREATE INDEX IF NOT EXISTS i ON blocks (x) WHERE deleted = 0',
  'CREATE TRIGGER t AFTER UPDATE ON blocks BEGIN UPDATE blocks SET x=1; END',
  // Local tables that merely look similar
  'INSERT OR IGNORE INTO block_aliases (block_id) SELECT id FROM blocks',
  'INSERT INTO blocks_fts_rowids (block_id) VALUES (?)',
  'DELETE FROM blocks_synced_changes WHERE seq <= ?',
  // Comments / whitespace / quoting
  '\n  UPDATE "blocks" SET x = 1',
  '-- migrate\nUPDATE [blocks] SET x = 1',
  '/* c */ INSERT INTO `blocks` (id) VALUES (?)',
  // Schema qualifiers
  'UPDATE main.blocks SET content = ?',
  'INSERT INTO "main"."blocks" (id) VALUES (?)',
  'DELETE FROM [main].[workspace_members] WHERE id = ?',
  'UPDATE "a.b" SET x = 1',
  'INSERT INTO main.block_aliases (block_id) VALUES (?)',
  // CTE prefixes
  'WITH ids AS (SELECT id FROM blocks_synced) UPDATE blocks SET content = ?',
  'WITH RECURSIVE up(id, depth) AS (SELECT id, 0 FROM blocks) SELECT * FROM up',
  `WITH x AS (SELECT '(' AS c FROM blocks) UPDATE blocks SET content = ?`,
  'WITH updates AS (SELECT 1) SELECT * FROM updates',
  'WITH a AS (SELECT 1), b AS (SELECT 2) INSERT INTO workspaces (id) SELECT 1',
  // Comments between keywords, and DML nested in a trigger body
  'UPDATE /* note */ blocks SET x = 1',
  'INSERT /* note */ INTO blocks (id) VALUES (?)',
  'DELETE /* note */ FROM blocks WHERE id = ?',
  'CREATE TRIGGER t AFTER INSERT ON local_table BEGIN UPDATE blocks SET x = 1; END',
  'CREATE TRIGGER t AFTER UPDATE OF x ON blocks BEGIN SELECT 1; END',
  `INSERT INTO block_aliases (note) VALUES ('update blocks now')`,
  // Multi-statement scripts
  'CREATE INDEX i ON blocks (x); UPDATE blocks SET content = ?',
  'SELECT 1; DELETE FROM blocks WHERE id = ?',
  'INSERT INTO block_aliases (block_id) VALUES (?); SELECT 1',
  `INSERT INTO block_aliases (x) VALUES (';'); SELECT 1`,
  'CREATE INDEX a ON blocks (x); CREATE INDEX b ON blocks (y)',
]

describe('synced-table SQL recognizer: TS and ESLint copies agree', () => {
  it.each(CORPUS)('%s', (sql) => {
    expect(lintRuleTarget(sql)).toBe(syncedWriteTarget(sql))
  })
})
