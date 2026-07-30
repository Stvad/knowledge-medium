import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import ambientAccessors from './eslint-rules/ambient-accessors.js'
import { generatedEntries, manualEntries } from './eslint-rules/ambientAccessors.data.js'
import blockSubscriptions from './eslint-rules/block-subscriptions.js'
import preferCallbackSet from './eslint-rules/prefer-callback-set.js'
import childView from './eslint-rules/child-view.js'
import noRawSyncedTableWrites from './eslint-rules/no-raw-synced-table-writes.js'
import kernelPluginBoundary from './eslint-rules/kernel-plugin-boundary.js'

// DI-lens audit (PR #357) / follow-up (PR #424): every ambient-global
// restriction the audit produced now lives in ambientAccessors.data.js and
// runs through the one generic `ambient/ambient-accessors` rule below —
// adding a restriction is a table edit (or, for a tagged export, just an
// `@ambient` JSDoc tag — see scripts/gen-ambient-accessors.ts), never a new
// rule instance or eslint.config.js override block. It applies EVERYWHERE,
// including test files, same as before.
const ambientAccessorEntries = [...generatedEntries, ...manualEntries]

// Audit B3: the untyped window.CustomEvent UI bus was replaced by typed
// channels. This one stays a plain no-restricted-syntax selector (not a
// table entry) because tests are legitimately EXEMPT from it — see the
// test-file override below — unlike every ambient-accessors entry, which
// applies to tests too.
const b3CustomEventRestriction = {
  selector:
    "CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name='dispatchEvent'] > NewExpression[callee.name='CustomEvent']",
  message:
    'Opening/toggling UI via window.dispatchEvent(new CustomEvent(...)) is the retired plugin-bus pattern (audit B3). Use openDialog for dialogs/pickers, and a useSyncExternalStore toggle store (createToggleStore) flipped from an action for toggle/open intents. For a genuine broadcast, add `// eslint-disable-next-line no-restricted-syntax -- genuine broadcast: <why>`.',
}

// Every USER-INITIATED delete must route through `deleteBlockThroughUi` so the
// deletion guards (`blockDeletionGuardsFacet`) are consulted. Handlers calling
// `block.delete()` and remembering to ask first lasted exactly one commit:
// `delete_block` checked, `cut_selected_blocks` and `delete_empty_block_cm`
// didn't, so `Delete` on a daily note was refused while `d` on the same
// selection destroyed it.
//
// FOUR selectors, because the repo has four ways to destroy a block and each
// earlier version of this rule claimed completeness while missing some:
//   1. `block.delete()` — zero-arg (Set/Map/query-builder deletes all take an
//      argument, so arity alone separates them).
//   2. `repo.mutate.delete({id})` — what `Block.delete()` wraps, and what two
//      user-facing delete buttons actually call. An arity-only rule missed it.
//   3. `tx.delete(id)` inside a `repo.tx(...)` — how `blockMerge`, the agent
//      bridge, `subtreeDelete` and the references processor destroy blocks, so
//      it is the shape a new handler is most likely to copy.
//   4. `deleteSubtreeInTx(tx, id)` — the cascade helper behind (1) and (2).
// Matched on the conventional receiver names for a tx (`tx`/`t`/`trx`); a tx
// bound to some other name slips through, which is why this is a tripwire for
// the common shapes rather than a proof.
//
// Applied to `src/` only (see the files block); ops scripts have no Blocks, so
// their zero-arg `.delete()` calls are Supabase query builders and linting them
// would be noise in files that can't have the defect. Legitimate programmatic
// deletes inside `src/` opt out inline with a reason — that's the point of the
// guard being UI-layer rather than a data-layer rule.
//
// Still not airtight, and deliberately so — the guards are a UI affordance, not
// an immortality bit. A merge also destroys a block (`core.merge` soft-deletes
// its `from`) via `tx.run(mergeMutator, …)`, which no syntactic rule will
// recognise; those call sites are guarded by hand. Aliasing (`const {mutate} =
// repo`), computed access (`block['delete']()`) and detached references all
// slip through as well.
const uiDeleteMessage =
  'A user-initiated delete must go through `deleteBlockThroughUi` / `deleteBlocksThroughUi` / `ensureDeletableThroughUi` (@/utils/deleteBlockThroughUi) so blockDeletionGuardsFacet is consulted — otherwise a new delete path silently skips the guards, as cut_selected_blocks, delete_empty_block_cm and the merge handlers did. For a delete that is deliberately NOT user-initiated, add `// eslint-disable-next-line no-restricted-syntax -- programmatic delete: <why>`.'

const uiDeleteRestriction = {
  selector: "CallExpression[callee.property.name='delete'][arguments.length=0]",
  message: uiDeleteMessage,
}

const uiMutateDeleteRestriction = {
  selector: "CallExpression[callee.property.name='delete'][callee.object.property.name='mutate']",
  message: uiDeleteMessage,
}

const uiTxDeleteRestriction = {
  selector: "CallExpression[callee.property.name='delete'][callee.object.name=/^(tx|t|trx)$/]",
  message: uiDeleteMessage,
}

const uiDeleteSubtreeRestriction = {
  selector: "CallExpression[callee.name='deleteSubtreeInTx']",
  message: uiDeleteMessage,
}

export default tseslint.config(
  // Top-level ignores. ESLint flat config doesn't honor .gitignore unless
  // you opt in (eslint-config-flat-gitignore), so list ephemeral / agent
  // dirs explicitly. .claude/worktrees/ and .codex/worktrees/ in particular
  // contain full repo copies (from Claude Code and Codex agent runs) that
  // shouldn't be re-linted. docs/**/*.ts are design-sketch
  // files (typechecked via docs/tsconfig.json) — they intentionally have
  // unused stub params and let-vs-const looseness so the prose stays
  // readable; ESLint shouldn't gate on them. **/*.eval.js are agent-bridge
  // eval scripts: the bridge wraps the file body in an async function
  // (top-level `await` + `return` to print back to the CLI), so they aren't
  // standalone ES modules — espree rejects the top-level `return`. Same
  // "runtime code, not a module" carve-out as agent-extensions/**.
  { ignores: ['dist', '**/dist/**', '.claude/**', '.codex/**', '.playwright-mcp/**', 'tmp/**', 'docs/**', 'agent-extensions/**', '**/*.eval.js'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      block: blockSubscriptions,
      'callback-set': preferCallbackSet,
      ambient: ambientAccessors,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Off by design: `only-export-components` guards Vite Fast Refresh, a
      // dev-HMR-only ergonomic. This repo is driven primarily by agents that
      // verify via `pnpm vitest` + the live bridge (not by hand-saving in a
      // running dev server), so the rule only emitted ~47 standing warnings
      // that added noise to every lint/check run with no signal. Turn it back
      // on if interactive HMR becomes part of the loop again.
      'react-refresh/only-export-components': 'off',
      // The React Compiler rules folded into react-hooks v7 are treated
      // as errors so new compiler-incompatible patterns fail CI.
      'react-hooks/set-state-in-effect': 'error',
      'block/no-broad-block-subscriptions': ['error', {
        // Renderer selection still re-runs off the full row because
        // canRender/priority predicates can currently inspect block.peek().
        // That path needs a separate dependency API before this exception
        // can be removed.
        allowUseDataIn: ['src/hooks/useRendererRegistry.tsx'],
      }],
      'block/prefer-semantic-block-hooks': ['error', {
        allowIn: ['src/hooks/block.ts'],
      }],
      'block/no-direct-types-prop-writes': ['error', {
        allowIn: [
          'src/data/properties.ts',
          'src/data/typeTagger.ts',
        ],
      }],
      // Audit B3: the untyped window.CustomEvent UI bus was replaced by
      // typed channels. Block its reintroduction — dialogs/pickers go
      // through `openDialog`, toggle/open surfaces through a
      // `createToggleStore` + an action (reached cross-plugin via
      // `runActionById`). A genuine broadcast keeps a CustomEvent but
      // must opt in explicitly with an inline disable + justification
      // (see runtimeEvents.ts / propertyNavigation.ts / agent-runtime).
      'no-restricted-syntax': ['error', b3CustomEventRestriction],
      // DI-lens audit (PR #357) / table-driven follow-up (PR #424): see
      // ambientAccessors.data.js for the restrictions themselves
      // (getActiveUserId, getLayoutSessionId, navigator.platform, the
      // mobile breakpoint literal) and their allowlists.
      'ambient/ambient-accessors': ['error', { entries: ambientAccessorEntries }],
      // Warn (not error) when a Set of function callbacks reinvents the
      // listener add/notify/unsubscribe loop CallbackSet provides. Soft nudge:
      // new code keeps re-rolling `new Set<() => void>()` because nothing points
      // to the shared util. Silence genuine non-listener function-Sets per-site.
      'callback-set/prefer-callback-set': 'warn',
    },
  },
  {
    // Child-visibility guardrail (PR #288/#386). `tx.childrenOf` /
    // `repo.query.{children,subtree,childIds}` default to the structural
    // everything-view (hidden property field-row machinery included); the
    // visible/outline view is opt-in (`hidePropertyChildren` / the
    // `visibleChildrenOf` helper).
    //
    // Split by ALTITUDE, not by directory (the first cut scoped this to a
    // list of display dirs and two consecutive reviews found bare traversals
    // just outside it — `export_document`, then the agent bridge's
    // `get-subtree`; chasing directories loses that race):
    //
    //   - a `repo.query.{children,subtree,childIds}({id})` is a READ-OUT —
    //     rendered, serialized, or handed to an agent. Every such call site in
    //     `src/` wants the visible view, so guard the query handles EVERYWHERE
    //     and let new consumers inherit the check for free.
    //   - `tx.childrenOf` is the low-level primitive. Mixed data-layer files
    //     (mutators, paste, panelLayoutProjection, agent-runtime) call it
    //     structurally on purpose — order-key and sibling math must see every
    //     row — so it is only guarded in the pure display dirs below, and the
    //     mixed files spell visible intent with the `visibleChildrenOf` helper.
    files: ['src/**/*.{ts,tsx}'],
    plugins: {'child-view': childView},
    rules: {
      'child-view/require-explicit-child-view': ['error', {check: 'query'}],
    },
  },
  {
    // The UI-delete guardrail applies to app code only. `scripts/` and other
    // ops tooling have no Block deletes at all — their zero-arg `.delete()`
    // calls are Supabase query builders — so linting them here would be pure
    // noise in files that can never have the defect.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', b3CustomEventRestriction, uiDeleteRestriction, uiMutateDeleteRestriction],
    },
  },
  {
    // The in-transaction forms, everywhere EXCEPT the data layer. `tx.delete` /
    // `deleteSubtreeInTx` are how deletion is IMPLEMENTED, so `src/data/**` is
    // full of legitimate uses and flagging them would just mean a dozen
    // disable comments explaining that the delete mutator deletes. Outside it,
    // reaching for a raw tx delete is the shape a new UI handler would copy
    // from `blockMerge` — which is exactly the mistake this rule exists to
    // catch. Non-UI callers out here (the agent bridge, processors) opt out
    // inline with a reason, same as the other selectors.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/data/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        b3CustomEventRestriction,
        uiDeleteRestriction,
        uiMutateDeleteRestriction,
        uiTxDeleteRestriction,
        uiDeleteSubtreeRestriction,
      ],
    },
  },
  {
    // Pure outline/display modules: every child traversal is a display read,
    // so `tx.childrenOf` is guarded here too.
    files: [
      'src/components/**/*.{ts,tsx}',
      'src/hooks/**/*.{ts,tsx}',
      'src/plugins/video-player/**/*.{ts,tsx}',
      'src/shortcuts/**/*.{ts,tsx}',
      'src/utils/copy.ts',
      'src/utils/navigation.ts',
    ],
    rules: {
      'child-view/require-explicit-child-view': ['error', {check: 'all'}],
    },
  },
  {
    // THE central architecture principle, as a gate: **core cannot depend on
    // plugins; plugins may depend on core and on each other.** Core declares
    // seams (facets, mutators, queries, actions, renderers) and plugins fill
    // them — the moment a core module names a plugin, that plugin stops being
    // removable and the seam stops being a seam.
    //
    // A lint rule rather than a paragraph because this repo is built primarily
    // by agents, and the erosion is always one line: a core module wants one
    // constant or one type that happens to live in a plugin, and nothing
    // objects. Prose doesn't survive that; a failing gate does.
    //
    // Scoped to `src/` — `scripts/` and `packages/` are top-level consumers
    // sitting ABOVE both layers (like an entry point), so their plugin imports
    // are not core→plugin edges. The rule additionally self-scopes: a file
    // inside `src/plugins/<name>/` is never a violator, so plugin→plugin (113
    // files today) stays allowed even if this `files` glob is later widened.
    //
    // `.js`/`.mjs`/`.cjs` are in the glob even though every other block in this
    // config is `{ts,tsx}`-only. That gap is real, not theoretical:
    // `src/data/syncedTableSqlRecognizer.js` is shipped core code that NO rule
    // in this config currently lints, so renaming a file to `.js` was a
    // one-step way out of this boundary. Widening the whole config is a
    // separate call; widening this one rule is not.
    //
    // See eslint-rules/kernel-plugin-boundary.js for where the boundary is
    // derived from and what counts as a dependency (static import, `export …
    // from`, dynamic `import()`, type-position `import('…')` — type-only
    // imports included, since a contract core NAMES is a contract that belongs
    // in core).
    files: ['src/**/*.{ts,tsx,js,mjs,cjs}'],
    plugins: {boundary: kernelPluginBoundary},
    rules: {
      'boundary/no-core-to-plugin-imports': ['error', {
        // The composition root — the two files whose entire job is registering
        // every plugin with the app. Importing all of them is not a leak here,
        // it is the definition of the file. This is the ONLY blanket exemption;
        // genuine debt elsewhere carries an inline disable + a reason, so a
        // NEW plugin import in an already-compromised file still fails.
        allowIn: [
          'src/extensions/staticAppExtensions.ts',
          'src/extensions/staticDataExtensions.ts',
        ],
      }],
    },
  },
  {
    // Static half of the "raw write to a synced table silently never
    // uploads" bug class (src/data/syncedTableWriteGuard.ts; GitHub issue
    // #404 item 1). Only a `repo.tx(...)` write sets `tx_context.source`,
    // which the upload trigger is gated on — a raw SQL write to
    // blocks/workspaces/workspace_members from outside a tx leaves the row
    // local-only, with no error at write time.
    files: ['src/**/*.{ts,tsx}'],
    plugins: {'synced-write': noRawSyncedTableWrites},
    rules: {
      'synced-write/no-raw-synced-table-writes': 'error',
    },
  },
  {
    // Sites where a raw write to blocks/workspaces/workspace_members is
    // sanctioned, not a regression of the bug class above:
    //   - txEngine.ts is the tx write path itself — writeTransaction sets
    //     tx_context.source before these statements run, so the upload
    //     trigger fires normally.
    //   - syncObserver/** is the sync ARRIVAL path (applying a row that
    //     already came from the server, or projecting a local echo of one)
    //     — local-only is the correct, intended behavior there.
    //   - clientSchema.ts is one-time local-schema migrations/backfills that
    //     intentionally run outside a tx.
    //   - repo.ts writes a local *derived* column only
    //     (reference_target_id), recomputed from content and never uploaded
    //     on its own.
    //   - syncedTableWriteGuard.ts is this bug class's own home (the runtime
    //     guard + docs), not a call site.
    //   - workspaceSchema.ts holds the PowerSync `RawTableType` put/delete SQL
    //     for the workspaces / workspace_members raw tables: the SDK's own
    //     arrival path, same role as syncObserver above (the sibling `put`
    //     statements escape the rule only because their target is
    //     interpolated — an accident of the rule, not a distinction).
    //   - workspaces.ts primes those two rows locally after a workspace RPC.
    //     Neither table has an upload trigger at all, so there is no repo.tx
    //     alternative: server state moves through the Supabase RPCs and comes
    //     back via sync, and the prime just closes the RPC-before-sync window
    //     (see the comment on primeLocalWorkspace for why it must carry every
    //     column). A NEW raw write to these tables should still fail lint.
    files: [
      'src/data/internals/txEngine.ts',
      'src/data/internals/syncObserver/**',
      'src/data/internals/clientSchema.ts',
      'src/data/repo.ts',
      'src/data/syncedTableWriteGuard.ts',
      'src/data/workspaceSchema.ts',
      'src/data/workspaces.ts',
    ],
    rules: {
      'synced-write/no-raw-synced-table-writes': 'off',
    },
  },
  {
    // Tests legitimately dispatch synthetic CustomEvents to drive
    // components, so the B3 selector above doesn't apply to them. (The
    // ambient-accessors table rule, unlike B3, applies to tests too — see
    // the comment on that rule above — so it's deliberately NOT turned off
    // here.) Tests also build throwaway function-Sets for mocks/fakes, so
    // the CallbackSet nudge is off there too. Test fixtures/harnesses also
    // legitimately poke synced tables directly (seeding rows, asserting on
    // raw SQL shapes) without going through repo.tx.
    //
    // The core→plugin boundary is off here for the same reason `scripts/` is
    // out of scope: the invariant is about the SHIPPED module graph, and a test
    // is a top-level consumer sitting above both layers, not part of core's
    // dependency closure. A core integration test proving that core and several
    // plugin data extensions compose (systemPagesCollision.test.ts installs
    // four of them) is the correct shape for such a test, and the type-parity
    // fixture (extensions/test/apiCatalogTypeParity.ts) exists precisely to
    // name every type the catalog advertises — including the two the catalog
    // sources from plugins. Enforcing here would mean ~24 disable comments
    // saying "this is a test", which teaches nothing.
    // The extension list matches the boundary rule's `files` glob above (which
    // includes `.js`/`.mjs`/`.cjs`): a `{ts,tsx}`-only exemption would leave a
    // JavaScript test that legitimately imports a plugin failing the gate as if
    // it were shipped core code. The other rules turned off here never applied
    // to JavaScript in the first place, so widening costs them nothing.
    files: ['**/test/**/*.{ts,tsx,js,mjs,cjs}', '**/*.test.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': 'off',
      'callback-set/prefer-callback-set': 'off',
      'synced-write/no-raw-synced-table-writes': 'off',
      'boundary/no-core-to-plugin-imports': 'off',
    },
  },
)
