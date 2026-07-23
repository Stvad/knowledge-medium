import { RuleTester } from 'eslint'
import { describe } from 'vitest'
import tseslint from 'typescript-eslint'
// The local ESLint plugin is plain JS because eslint.config.js imports it directly.
// @ts-expect-error no declaration file for the local rule module
import noRawSyncedTableWrites from '../../eslint-rules/no-raw-synced-table-writes.js'

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2020,
    sourceType: 'module',
  },
})

describe('no-raw-synced-table-writes ESLint rule', () => {
  ruleTester.run(
    'no-raw-synced-table-writes',
    noRawSyncedTableWrites.rules['no-raw-synced-table-writes'],
    {
      valid: [
        // A recursive-CTE READ (the shape treeQueries.ts is full of) must not
        // be flagged just because it mentions blocks.
        `db.getAll('WITH RECURSIVE up(id, depth) AS (SELECT id, 0 FROM blocks) SELECT * FROM up')`,
        // Reads are unaffected.
        { code: `db.execute('SELECT * FROM blocks WHERE id = ?')` },
        // The write TARGET is a local index table even though `blocks` is
        // mentioned in a FROM/subquery — the real target is what matters.
        { code: `db.execute('INSERT INTO block_aliases (block_id) SELECT id FROM blocks')` },
        // Tables that merely share a name prefix with `blocks` are local and
        // exact-name matched, so never flagged.
        { code: `db.execute('DELETE FROM blocks_synced_changes WHERE seq <= ?')` },
        { code: `db.execute("INSERT OR REPLACE INTO blocks_synced (id) VALUES (?)")` },
        { code: `db.execute('UPDATE blocks_fts SET content = ? WHERE rowid = ?')` },
        // Local derived-index / bookkeeping tables.
        { code: `db.execute('INSERT OR REPLACE INTO client_schema_state (key, completed_at) VALUES (?, ?)')` },
        { code: `db.execute('DELETE FROM block_references WHERE source_id = ?')` },
        // Non-DML statements mentioning a synced table are not writes.
        { code: `db.execute('CREATE INDEX idx_blocks_parent ON blocks (parent_id)')` },
        { code: `db.execute('PRAGMA table_info(blocks)')` },
        // A template literal write to a local table.
        { code: 'db.execute(`UPDATE tx_context SET source = ? WHERE id = 1`)' },
        // A dynamic write target can't be resolved statically — the
        // interpolation breaks the match rather than being guessed at, so
        // this correctly isn't flagged (known limitation of a literal-text
        // rule, not a gap this rule tries to close).
        { code: 'db.execute(`INSERT OR REPLACE INTO ${tableName} (id) VALUES (?)`)' },
        // A `+` concat with a dynamic table operand can't be folded — same
        // documented limitation as `${interp}`; the literal parts alone carry
        // no complete write, so nothing is flagged.
        { code: `db.execute('UPDATE ' + tableName + ' SET x = ?')` },
        // A fully-static concat that resolves to a LOCAL table is folded and
        // correctly not flagged (the fold feeds the same exact-name matcher).
        { code: `db.execute('UPDATE ' + 'tx_context' + ' SET source = ?')` },
        // Unrelated string/template literals.
        { code: `const greeting = 'hello world'` },
        { code: 'const label = `count: ${n}`' },
      ],
      invalid: [
        {
          // Schema-qualified target — still the synced table.
          code: `db.execute('UPDATE main.blocks SET content = ?')`,
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        {
          // SQLite allows a WITH clause to prefix DML — the write is real
          // even though the statement's first token is `WITH`.
          code: 'db.execute(`WITH ids AS (SELECT id FROM blocks_synced) UPDATE blocks SET content = ?`)',
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        {
          code: `db.execute('INSERT INTO blocks (id) VALUES (?)')`,
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        {
          code: `db.execute('UPDATE blocks SET content = ? WHERE id = ?')`,
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        {
          code: `db.execute('DELETE FROM blocks WHERE id = ?')`,
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        {
          code: `db.execute("INSERT OR REPLACE INTO workspaces (id) VALUES (?)")`,
          errors: [{ messageId: 'rawWorkspaceWrite', data: { table: 'workspaces' } }],
        },
        {
          code: `db.execute('DELETE FROM workspace_members WHERE id = ?')`,
          errors: [{ messageId: 'rawWorkspaceWrite', data: { table: 'workspace_members' } }],
        },
        // A quoted identifier is unwrapped before matching.
        {
          code: `db.execute('UPDATE "blocks" SET deleted = 1 WHERE id = ?')`,
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        // Multi-line template literal, matching the real call-site shape.
        {
          code: 'tx.execute(`\n  UPDATE blocks SET content = ? WHERE id = ?\n`, [content, id])',
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        // Fully-static `+` concatenation that SPLITS the keyword from the table
        // — the bypass the fold closes (previously each literal alone matched
        // nothing, so the write slipped past).
        {
          code: `db.execute('UPDATE ' + 'blocks' + ' SET content = ?')`,
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        // A dynamic operand doesn't fold, but the keyword+table surviving in one
        // literal is still caught by the per-literal pass (coverage preserved).
        {
          code: `db.execute('DELETE FROM blocks WHERE id = ' + id)`,
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        // A static prefix that carries the whole keyword+table ahead of a
        // DYNAMIC suffix — the outer `+` can't fold, but the inner static
        // sub-chain `'UPDATE ' + 'blocks'` is checked at its largest static
        // boundary, so the known `blocks` target is still caught (and reported
        // exactly once, not doubled by the fully-static case above).
        {
          code: `db.execute('UPDATE ' + 'blocks' + setClause)`,
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
        // The target hidden inside a STATIC template interpolation — the quasis
        // carry the keyword, `${'blocks'}` carries the table. Folding the static
        // interpolation reconstructs `UPDATE blocks SET …` (the dynamic `?` param
        // isn't in the SQL string, only in the args), so it's flagged.
        {
          code: "db.execute(`UPDATE ${'blocks'} SET content = ? WHERE id = ?`)",
          errors: [{ messageId: 'rawSyncedWrite', data: { table: 'blocks' } }],
        },
      ],
    },
  )
})
