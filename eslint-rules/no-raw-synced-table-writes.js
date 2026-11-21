/**
 * no-raw-synced-table-writes — static half of the "raw write to a synced
 * table silently never uploads" bug class (GitHub issue #404 item 1). See
 * `src/data/syncedTableWriteGuard.ts` for the full writeup and the runtime
 * guard.
 *
 * The recognizer itself — `syncedWriteTarget` and its design rationale (why
 * it's position-independent, the single-quote second pass, the
 * destructive-DDL narrowing) — lives in `src/data/syncedTableSqlRecognizer.js`
 * and is imported directly, not mirrored: it's plain JS with no TypeScript
 * syntax, so ESLint (which loads rule files untranspiled) can `import` it
 * with no build step, the same way this rule file itself loads. The runtime
 * guard consumes the identical file via a co-located `.d.ts`. One parser, two
 * callers — see that module's doc for the algorithm.
 *
 * The rule flags any string / template literal in `src/` whose SQL writes to
 * `blocks`, `workspaces`, or `workspace_members`, so a new raw-write
 * regression fails lint instead of failing silently at sync time.
 *
 * A dynamic write target (e.g. `` `INSERT INTO ${tableName} (…)` ``) can't be
 * resolved statically — the interpolation is dropped rather than guessed at,
 * so the site isn't flagged. Known limitation of a literal-text rule. The same
 * goes for a `+` concatenation with a NON-static operand (`'UPDATE ' + name`):
 * the fold gives up (returns null) at that boundary, and the literal parts are
 * re-examined on their own, so a statement whose keyword+table survive in one
 * literal is still caught. A `+` chain is checked at its LARGEST static
 * boundary, so both a fully-static split (`'UPDATE ' + 'blocks'`) AND a static
 * prefix carrying the target ahead of a dynamic suffix
 * (`'UPDATE ' + 'blocks' + setClause`) are reconstructed and flagged; only a
 * split that scatters the keyword and table across a dynamic operand
 * (`'UPDATE ' + name + 'blocks'`) escapes.
 *
 * A small handful of files are legitimately exempt — see the `files`-scoped
 * overrides in eslint.config.js, each with a comment explaining why.
 */

import { syncedWriteTarget } from '../src/data/syncedTableSqlRecognizer.js'

/** The static text an expression contributes, for target matching only. A
 *  template literal's STATIC interpolations are folded in (`${'blocks'}` →
 *  `blocks`) and its dynamic ones drop out; a `+` concatenation is folded when
 *  BOTH sides are static, so a synced write split across string literals —
 *  `'UPDATE ' + 'blocks' + …` — or hidden in a static interpolation —
 *  `UPDATE ${'blocks'} …` — is still seen as one statement. Any dynamic operand
 *  contributes nothing (see the module doc on why dropping beats guessing). */
const literalSqlText = (node) => {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null
  if (node.type === 'TemplateLiteral') {
    // Interleave the static quasis with any STATICALLY-foldable interpolation
    // (`${'blocks'}`, a static `+` sub-chain, a nested static template). A
    // dynamic `${expr}` folds to null and drops out — the same "give up on the
    // dynamic part, keep the literal parts" contract as a `+` with a dynamic
    // operand. Folding static interpolations catches a target that lives inside
    // one, e.g. `UPDATE ${'blocks'} SET …`, which dropping every `${…}` missed.
    let out = node.quasis[0].value.raw
    for (let i = 0; i < node.expressions.length; i++) {
      out += (literalSqlText(node.expressions[i]) ?? '') + node.quasis[i + 1].value.raw
    }
    return out
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = literalSqlText(node.left)
    if (left === null) return null
    const right = literalSqlText(node.right)
    if (right === null) return null
    return left + right
  }
  return null
}

const noRawSyncedTableWrites = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag raw SQL writes (INSERT/UPDATE/DELETE) to synced tables (blocks, workspaces, workspace_members) outside repo.tx.',
    },
    schema: [],
    messages: {
      rawSyncedWrite:
        'Raw SQL write to synced table "{{table}}". Only a repo.tx(...) write sets '
        + 'tx_context.source, and the upload trigger is gated on that being non-NULL — a '
        + 'raw write here leaves source = NULL, so the upload trigger never fires and the '
        + 'row is silently local-only (see src/data/syncedTableWriteGuard.ts). It also '
        + 'skips the kernel derivations the pipeline runs (block_types, reference '
        + 'normalization, property projection), so derived state desyncs too. Route this '
        + 'write through repo.tx instead.',
      // Deliberately different advice: these two have no upload trigger at all,
      // so "route it through repo.tx" is not a fix that exists. Server state
      // for them changes via the Supabase RPCs and comes back through sync.
      rawWorkspaceWrite:
        'Raw SQL write to "{{table}}". This table has no upload path — the local row is '
        + 'a replica: server state changes through the workspace Supabase RPCs and '
        + 'arrives via PowerSync. A write here is local-only priming that the next sync '
        + 'replay overwrites, so it must be a deliberate, documented pre-sync prime '
        + '(see primeLocalWorkspace in src/data/workspaces.ts) — never the way to '
        + 'change workspace state.',
    },
  },
  create(context) {
    const check = (node) => {
      const text = literalSqlText(node)
      if (text === null) return
      const table = syncedWriteTarget(text)
      if (table !== null) {
        const messageId = table === 'blocks' ? 'rawSyncedWrite' : 'rawWorkspaceWrite'
        context.report({node, messageId, data: {table}})
      }
    }
    return {
      Literal: check,
      TemplateLiteral: check,
      // Fold `+` concatenations at the LARGEST statically-foldable boundary:
      // check a `+` node when it folds to static text AND its parent `+` (if
      // any) does NOT — the parent's own fold would already cover it otherwise.
      //   - fully-static chain `a+b+c`: only the outermost folds under a
      //     non-`+` parent, so it reports ONCE (no double-report from `a+b`);
      //   - static prefix + dynamic suffix `'UPDATE ' + 'blocks' + setClause`:
      //     the outer `+` folds to null (dynamic `setClause`) and is skipped,
      //     but the inner `'UPDATE ' + 'blocks'` folds to static text under a
      //     null-folding parent, so its known `blocks` target is still caught.
      // Operand literals are also visited individually (the Literal handler),
      // preserving coverage when the target survives whole in one literal.
      "BinaryExpression[operator='+']"(node) {
        if (literalSqlText(node) === null) return
        const parent = node.parent
        if (
          parent?.type === 'BinaryExpression' && parent.operator === '+'
          && literalSqlText(parent) !== null
        ) return
        check(node)
      },
    }
  },
}

export default {
  rules: {
    'no-raw-synced-table-writes': noRawSyncedTableWrites,
  },
}
