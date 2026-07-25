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
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
      'callback-set/prefer-callback-set': 'off',
      'synced-write/no-raw-synced-table-writes': 'off',
    },
  },
)
