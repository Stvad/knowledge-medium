// @vitest-environment jsdom
/**
 * Interaction fuzz suite: random sequences of DEFAULT ACTION dispatches
 * (the handler layer between keystrokes and mutators) against a real
 * test repo. See `src/test/fuzz.ts` for tier mechanics. jsdom (not
 * node) because the fake editor view and a few handlers touch DOM
 * globals — same environment as defaultShortcuts.test.ts, whose
 * harness (fake CodeMirror view, uiStateBlock wiring) this reuses.
 *
 * What this exercises that repoMutators.fuzz.test.ts (raw mutator
 * sequences) cannot: the HANDLER layer — structural-edit policy gating
 * (scope-root protection, canIndent/canOutdent/canMergeUp), visible-
 * block walks over collapse state, split-at-cursor case analysis,
 * focus handoff, and selection-state writes — dispatched through
 * `invokeAction` (the real choke point, actionDispatch.ts:46-49) with
 * deps synthesized the way the UI builds them.
 *
 * Deps synthesis (types.ts:121-166, mirroring useShortcutSurfaceActivations):
 *  - `uiStateBlock`: a dedicated UI-state block carrying focus/editing/
 *    selection properties, `topLevelBlockIdProp` = ROOT.
 *  - `block`: the currently focused block (peekFocusedBlockLocation).
 *    The UI only dispatches block actions for a rendered (live) block;
 *    when a prior op leaves focus on a deleted/missing block this
 *    harness re-focuses the first live block first — simulating
 *    PanelFocusRecovery (referenced in delete_block's handler,
 *    blockActions.ts) — so dispatches stay in the UI's contract.
 *  - `editorView`: a headless fake over the block's CURRENT content
 *    with a random caret — the included EDIT_MODE_CM handlers read only
 *    `state.selection.main`/`state.doc` and dispatch changes
 *    (defaultShortcuts.test.ts's `codeMirrorEditorView`).
 *  - multi-select deps: derived from `selectionStateProp` on the
 *    uiStateBlock, which the extend_selection actions themselves write.
 *
 * Action pool: the structural/navigation core that is jsdom-safe and
 * deps-synthesizable. Deliberately EXCLUDED (docs to future editors):
 *  - move_up/down/left/right_from_cm_* — gated on
 *    isOnFirstVisualLine/getCaretRect → EditorView.coordsAtPos,
 *    browser-layout-only (src/utils/codemirror.ts).
 *  - the copy, cut, and paste families — navigator.clipboard.
 *  - zoom/panel/navigation/export/import/preferences — need panel
 *    layout projection, window.location, file pickers, or dialogs.
 *
 * Oracles after every dispatch:
 *  - only domain rejections (same LEGAL_ERRORS as the kernel fuzzer)
 *    or a decline (`false`) — any TypeError & co. is a bug in a
 *    handler's own logic.
 *  - structural invariants: no cycles, no live orphans, no order-key
 *    collisions, single workspace.
 *  - scope-root protection: ROOT stays live at the workspace root —
 *    every structural handler must refuse to indent/outdent/delete/
 *    merge-away the scope root (structuralEditPolicyForBlock;
 *    blockActions.ts indent/outdent guards, split_block_cm's
 *    isScopeRoot branch, delete_empty_block_cm's canMergeUp).
 *
 * Undo/redo run as ACTIONS inside sequences (handler-level paths); the
 * exact undo-all snapshot round-trip stays the kernel fuzzer's job —
 * handlers fire-and-forget focus writes (e.g. delete_block's
 * `void focusBlock(...)`), so this suite treats UI-state props as
 * eventually-consistent and never snapshot-compares them. For the same
 * reason every dispatch is followed by a microtask drain + a write
 * fence tx (PowerSync serializes write transactions, so the fence
 * resolving means previously ENQUEUED handler writes committed); the
 * end-of-case fence keeps stragglers from bleeding into the next
 * case's reset (§6-adjacent hazard, here even without an fc interrupt).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { EditorView } from '@codemirror/view'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  BlockNotFoundError,
  ChangeScope,
  CycleError,
  DeletedConflictError,
  DuplicateIdError,
  MergeIntoDescendantError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  ProcessorRejection,
  WorkspaceMismatchError,
} from '@/data/api'
import {
  focusBlock,
  peekFocusedBlockLocation,
  selectionStateProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { invokeAction } from '@/shortcuts/actionDispatch'
import { bindBlockActionContext, createSharedBlockActions } from '@/shortcuts/blockActions'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextType,
  type ActionTrigger,
  type BaseShortcutDependencies,
} from '@/shortcuts/types'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { cycleScanSql } from '@/data/internals/treeQueries'
import type { Repo } from '@/data/repo'

const WS = 'ws-1'
const ROOT = 'root'
const UI = 'ui'

// ──── the action pool ────
//
// Sources mirror production registration (defaultShortcuts.ts):
//  - 'shared': `createSharedBlockActions({repo})` bound to NORMAL_MODE
//    via `bindBlockActionContext` — the per-block-surface registration
//    (these are NOT in getDefaultActions' normal-mode group).
//  - 'defaults': found in `getDefaultActions({repo})` by (id, context).
//    Multi-select variants carry the `multi_select.` prefix
//    (makeMultiSelect, utils.ts:174); CM rebinds of the shared actions
//    carry `edit.cm.`.

const POOL: ReadonlyArray<{id: string; context: ActionContextType; source: 'shared' | 'defaults'}> = [
  {id: 'undo', context: ActionContextTypes.GLOBAL, source: 'defaults'},
  {id: 'redo', context: ActionContextTypes.GLOBAL, source: 'defaults'},
  {id: 'indent_block', context: ActionContextTypes.NORMAL_MODE, source: 'shared'},
  {id: 'outdent_block', context: ActionContextTypes.NORMAL_MODE, source: 'shared'},
  {id: 'move_block_up', context: ActionContextTypes.NORMAL_MODE, source: 'shared'},
  {id: 'move_block_down', context: ActionContextTypes.NORMAL_MODE, source: 'shared'},
  {id: 'delete_block', context: ActionContextTypes.NORMAL_MODE, source: 'shared'},
  {id: 'toggle_collapse', context: ActionContextTypes.NORMAL_MODE, source: 'shared'},
  {id: 'extend_selection_up', context: ActionContextTypes.NORMAL_MODE, source: 'shared'},
  {id: 'extend_selection_down', context: ActionContextTypes.NORMAL_MODE, source: 'shared'},
  {id: 'exit_edit_mode_cm', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'collapse_block_cm', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'expand_block_cm', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'split_block_cm', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'delete_empty_block_cm', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'merge_next_block_cm', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'move_block_up_cm', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'move_block_down_cm', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'edit.cm.indent_block', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'edit.cm.outdent_block', context: ActionContextTypes.EDIT_MODE_CM, source: 'defaults'},
  {id: 'multi_select.indent_block', context: ActionContextTypes.MULTI_SELECT_MODE, source: 'defaults'},
  {id: 'multi_select.outdent_block', context: ActionContextTypes.MULTI_SELECT_MODE, source: 'defaults'},
  {id: 'multi_select.delete_block', context: ActionContextTypes.MULTI_SELECT_MODE, source: 'defaults'},
  {id: 'multi_select.toggle_collapse', context: ActionContextTypes.MULTI_SELECT_MODE, source: 'defaults'},
  {id: 'multi_select.move_block_up', context: ActionContextTypes.MULTI_SELECT_MODE, source: 'defaults'},
  {id: 'multi_select.move_block_down', context: ActionContextTypes.MULTI_SELECT_MODE, source: 'defaults'},
  {id: 'multi_select.extend_selection_up', context: ActionContextTypes.MULTI_SELECT_MODE, source: 'defaults'},
  {id: 'multi_select.extend_selection_down', context: ActionContextTypes.MULTI_SELECT_MODE, source: 'defaults'},
  {id: 'clear_selection', context: ActionContextTypes.MULTI_SELECT_MODE, source: 'defaults'},
]

// ──── op generators ────

type OpSpec =
  | {op: 'focus'; id: number; edit: boolean}
  | {op: 'dispatch'; action: number; cursorSeed: number}

const opArb: fc.Arbitrary<OpSpec> = fc.oneof(
  {weight: 2, arbitrary: fc.record({op: fc.constant('focus' as const), id: fc.nat(31), edit: fc.boolean()})},
  {weight: 6, arbitrary: fc.record({
    op: fc.constant('dispatch' as const),
    action: fc.nat(POOL.length - 1),
    cursorSeed: fc.nat(30),
  })},
)

const caseArb = fc.record({
  seed: fc.array(fc.record({parent: fc.nat(31), content: fc.string({maxLength: 6})}), {minLength: 2, maxLength: 5}),
  ops: fc.array(opArb, {minLength: 1, maxLength: 15}),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

const LEGAL_ERRORS = [
  BlockNotFoundError,
  CycleError,
  DeletedConflictError,
  DuplicateIdError,
  MergeIntoDescendantError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  WorkspaceMismatchError,
]

const assertLegalRejection = (e: unknown, desc: string): void => {
  if (LEGAL_ERRORS.some(cls => e instanceof cls)) return
  if (e instanceof ProcessorRejection && e.code === 'alias.collision') return
  if (e instanceof Error && e.constructor === Error) return
  throw new Error(`illegal error from ${desc}: ${String(e)}`, {cause: e})
}

const pick = (index: number, ids: readonly string[]): string => ids[index % ids.length]

// ──── fake editor view (defaultShortcuts.test.ts's harness, trimmed) ────

const makeSelection = (from: number, to = from) => ({
  main: {empty: from === to, from, to, anchor: from, head: to},
})

const fakeEditorView = (content: string, cursor: number): EditorView => {
  let text = content
  let selection = makeSelection(Math.min(cursor, content.length))
  const view = {
    dom: document.createElement('div'),
    dispatch: (spec: {changes?: {from: number; to: number; insert: string}; selection?: unknown}) => {
      if (spec.changes) {
        text = text.slice(0, spec.changes.from) + spec.changes.insert + text.slice(spec.changes.to)
      }
      const next = spec.selection
      if (next && typeof next === 'object' && 'anchor' in next) {
        const range = next as {anchor: number; head?: number}
        selection = makeSelection(range.anchor, range.head ?? range.anchor)
      }
    },
  }
  Object.defineProperty(view, 'state', {
    get: () => ({
      selection,
      doc: {
        length: text.length,
        toString: () => text,
        sliceString: (from: number, to = text.length) => text.slice(from, to),
      },
    }),
  })
  return view as unknown as EditorView
}

// ──── invariant sweep ────

const sweepInvariants = async (db: TestDb['db']): Promise<void> => {
  // Scan ALL rows, not just the seed ids: actions create blocks
  // (split_block_cm & co.) and later actions operate on them, so a cycle
  // through a created id would otherwise escape the sweep (Codex review
  // on PR #371).
  const liveIds = (await db.getAll<{id: string}>('SELECT id FROM blocks')).map(row => row.id)
  const cycles = await db.getAll<{start_id: string}>(cycleScanSql(liveIds.length), liveIds)
  expect(cycles, 'structural cycle').toEqual([])

  const orphans = await db.getAll<{id: string}>(
    `SELECT b.id FROM blocks b
      WHERE b.deleted = 0 AND b.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND p.deleted = 0)`,
  )
  expect(orphans, 'live block under missing/deleted parent').toEqual([])

  const collisions = await db.getAll<{n: number}>(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM blocks WHERE deleted = 0
       GROUP BY parent_id, order_key HAVING COUNT(*) > 1)`,
  )
  expect(collisions[0].n, 'order-key collision among live siblings').toBe(0)

  const foreign = await db.getAll<{id: string}>('SELECT id FROM blocks WHERE workspace_id != ?', [WS])
  expect(foreign, 'block outside the seeded workspace').toEqual([])

  // Scope-root protection: every structural handler must refuse to
  // indent/outdent/delete/merge-away the scope root.
  const root = await db.getAll<{parent_id: string | null; deleted: number}>(
    'SELECT parent_id, deleted FROM blocks WHERE id = ?', [ROOT])
  expect(root, 'scope root exists').toHaveLength(1)
  expect({parent: root[0].parent_id, deleted: root[0].deleted}, 'scope root live at workspace root')
    .toEqual({parent: null, deleted: 0})
}

// ──── case execution ────

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await inFlightCase?.catch(() => {})
  await sharedDb.cleanup()
})

/** docs/fuzzing.md §6 — barrier for the fc-interrupt abandoned case. */
let inFlightCase: Promise<void> | null = null

interface Env {
  repo: Repo
  ids: string[]
  /** Live block ids in (parent, order) walk from ROOT — for focus recovery. */
  firstLive(): Promise<string>
  /** Microtask drain + zero-write fence tx: PowerSync serializes write
   *  transactions, so once the fence commits, every handler write that
   *  had already been ENQUEUED (incl. fire-and-forget focus writes that
   *  got as far as their tx call during the drain) is committed. */
  fence(): Promise<void>
}

const buildEnv = async (seed: ReadonlyArray<{parent: number; content: string}>): Promise<Env> => {
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    await tx.create({id: UI, workspaceId: WS, parentId: null, orderKey: 'z0'})
  }, {scope: ChangeScope.BlockDefault})
  const uiStateBlock = repo.block(UI)
  await uiStateBlock.set(topLevelBlockIdProp, ROOT)

  const ids: string[] = [ROOT]
  for (const spec of seed) {
    const id = await repo.mutate.createChild({
      parentId: pick(spec.parent, ids), position: {kind: 'last'}, content: spec.content,
    })
    ids.push(id)
  }
  repo.undoManager?.clear()

  return {
    repo,
    ids,
    firstLive: async () => {
      const rows = await sharedDb.db.getAll<{id: string}>(
        `SELECT id FROM blocks WHERE deleted = 0 AND id != ? ORDER BY (id = ?) DESC, order_key, id LIMIT 1`,
        [UI, ROOT])
      return rows[0].id
    },
    fence: async () => {
      for (let i = 0; i < 25; i++) await Promise.resolve()
      await repo.tx(async () => {}, {scope: ChangeScope.BlockDefault})
      for (let i = 0; i < 25; i++) await Promise.resolve()
    },
  }
}

const findAction = (
  actions: ActionConfig[], id: string, context: ActionContextType,
): ActionConfig => {
  const action = actions.find(a => a.id === id && a.context === context)
  if (!action) throw new Error(`action pool references missing action: ${id} (${context})`)
  return action
}

/** Resolve the static POOL against a repo: shared block actions get the
 *  production NORMAL_MODE binding; everything else comes from
 *  getDefaultActions. */
const resolvePool = (repo: Repo): ActionConfig[] => {
  const sharedBound = Object.values(createSharedBlockActions({repo}))
    .map(a => bindBlockActionContext(ActionContextTypes.NORMAL_MODE, a) as ActionConfig)
  const defaults = getDefaultActions({repo})
  return POOL.map(({id, context, source}) =>
    findAction(source === 'shared' ? sharedBound : defaults, id, context))
}

const runCase = async (
  {seed, ops, prngSeed}: {seed: Array<{parent: number; content: string}>; ops: OpSpec[]; prngSeed: number},
): Promise<void> => {
  let lcg = prngSeed
  const realRandom = Math.random
  Math.random = () => {
    lcg = (lcg * 48271) % 2147483647
    return lcg / 2147483647
  }
  try {
    const env = await buildEnv(seed)
    const {repo, ids} = env
    const uiStateBlock = repo.block(UI)
    const pool = resolvePool(repo)
    const runtime = resolveFacetRuntimeSync([])

    for (const op of ops) {
      if (op.op === 'focus') {
        await focusBlock(uiStateBlock, pick(op.id, ids), {edit: op.edit})
      } else {
        const {id, context} = POOL[op.action]
        const action = pool[op.action]

        // Resolve the focused block, recovering to a live one when a
        // prior op deleted it (see the deps-synthesis docblock).
        let focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId ?? ROOT
        const focusedRow = await sharedDb.db.getAll<{deleted: number}>(
          'SELECT deleted FROM blocks WHERE id = ?', [focusedId])
        if (focusedRow.length === 0 || focusedRow[0].deleted === 1) {
          focusedId = await env.firstLive()
          await focusBlock(uiStateBlock, focusedId)
        }
        const block = repo.block(focusedId)

        const base = {uiStateBlock, scopeRootId: ROOT}
        // Deps are per-context supersets of BaseShortcutDependencies
        // (ShortcutDependenciesMap); the handler downcasts internally.
        const deps = (context === ActionContextTypes.EDIT_MODE_CM
          ? {
              ...base,
              block,
              editorView: fakeEditorView(
                (await sharedDb.db.getAll<{content: string}>(
                  'SELECT content FROM blocks WHERE id = ?', [focusedId]))[0]?.content ?? '',
                op.cursorSeed,
              ),
            }
          : context === ActionContextTypes.MULTI_SELECT_MODE
            ? {
                ...base,
                selectedBlocks: (uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds ?? [])
                  .map(selectedId => repo.block(selectedId)),
                anchorBlock: null,
              }
            : context === ActionContextTypes.NORMAL_MODE
              ? {...base, block}
              : base) as BaseShortcutDependencies

        const trigger = {
          preventDefault: () => {},
          stopPropagation: () => {},
        } as unknown as ActionTrigger

        try {
          const result = invokeAction(runtime, {action, deps, trigger})
          if (result instanceof Promise) await result
        } catch (e) {
          assertLegalRejection(e, `${id} (${context})`)
        }
      }
      await env.fence()
      await sweepInvariants(sharedDb.db)
    }
    await env.fence()
  } finally {
    Math.random = realRandom
  }
}

describe('default-action dispatch sequences', () => {
  it('preserve structural invariants and scope-root protection', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async args => {
        const run = runCase(args)
        inFlightCase = run
        await run
      }),
      fuzzParams(8),
    )
  }, fuzzTestTimeout())

  // Non-vacuity canary: the sweeps above only bite if dispatches reach
  // the mutator layer instead of no-oping through their guards. Pins
  // observable effects for the main handler families under exactly the
  // deps this harness synthesizes.
  it('dispatched actions observably reach the handlers', async () => {
    await inFlightCase?.catch(() => {})
    const env = await buildEnv([
      {parent: 0, content: 'alpha'},
      {parent: 0, content: 'beta'},
    ])
    const {repo, ids} = env
    const [, alpha, beta] = ids
    const uiStateBlock = repo.block(UI)
    const pool = resolvePool(repo)
    const poolAction = (id: string): ActionConfig => pool[POOL.findIndex(entry => entry.id === id)]
    const runtime = resolveFacetRuntimeSync([])
    const trigger = {preventDefault: () => {}, stopPropagation: () => {}} as unknown as ActionTrigger
    const row = async (id: string) =>
      (await sharedDb.db.getAll<{parent_id: string; deleted: number; content: string}>(
        'SELECT parent_id, deleted, content FROM blocks WHERE id = ?', [id]))[0]

    // indent_block: beta indents under alpha.
    await focusBlock(uiStateBlock, beta)
    const indent = poolAction('indent_block')
    await invokeAction(runtime, {action: indent, deps: {uiStateBlock, scopeRootId: ROOT, block: repo.block(beta)} as BaseShortcutDependencies, trigger})
    await env.fence()
    expect((await row(beta)).parent_id, 'indent reparented under previous sibling').toBe(alpha)

    // split_block_cm mid-text: alpha splits, a new block appears.
    const before = await sharedDb.db.getAll<{n: number}>('SELECT COUNT(*) AS n FROM blocks WHERE deleted = 0')
    const split = poolAction('split_block_cm')
    await invokeAction(runtime, {
      action: split,
      deps: {uiStateBlock, scopeRootId: ROOT, block: repo.block(alpha), editorView: fakeEditorView('alpha', 2)} as BaseShortcutDependencies,
      trigger,
    })
    await env.fence()
    const after = await sharedDb.db.getAll<{n: number}>('SELECT COUNT(*) AS n FROM blocks WHERE deleted = 0')
    expect(after[0].n, 'split created a block').toBe(before[0].n + 1)

    // extend_selection_down populates the selection state.
    await focusBlock(uiStateBlock, alpha)
    const extend = poolAction('extend_selection_down')
    await invokeAction(runtime, {action: extend, deps: {uiStateBlock, scopeRootId: ROOT, block: repo.block(alpha)} as BaseShortcutDependencies, trigger})
    await env.fence()
    const selected = uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds ?? []
    expect(selected.length, 'extend_selection populated selection state').toBeGreaterThan(0)

    // clear_selection empties it again.
    const clear = poolAction('clear_selection')
    await invokeAction(runtime, {
      action: clear,
      deps: {
        uiStateBlock,
        scopeRootId: ROOT,
        selectedBlocks: selected.map(id => repo.block(id)),
        anchorBlock: null,
      } as BaseShortcutDependencies,
      trigger,
    })
    await env.fence()
    expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds ?? [], 'clear_selection emptied selection')
      .toEqual([])

    // delete_block tombstones the focused block.
    await focusBlock(uiStateBlock, beta)
    const del = poolAction('delete_block')
    await invokeAction(runtime, {action: del, deps: {uiStateBlock, scopeRootId: ROOT, block: repo.block(beta)} as BaseShortcutDependencies, trigger})
    await env.fence()
    expect((await row(beta)).deleted, 'delete_block tombstoned the block').toBe(1)

    // undo (as an ACTION) restores it.
    const undo = poolAction('undo')
    await invokeAction(runtime, {action: undo, deps: {uiStateBlock, scopeRootId: ROOT}, trigger})
    await env.fence()
    expect((await row(beta)).deleted, 'undo action restored the block').toBe(0)

    await sweepInvariants(sharedDb.db)
  })
})
