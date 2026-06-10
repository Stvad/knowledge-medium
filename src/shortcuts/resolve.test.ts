import { describe, expect, it } from 'vitest'
import {
  compareContexts,
  computeInstallableContexts,
  resolve,
  resolveDeps,
  type ResolutionContext,
} from './resolve.ts'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  type BaseShortcutDependencies,
  type Priority,
} from './types.ts'
import type { ActiveContextsMap } from './ActiveContexts.tsx'

const config = (
  type: ActionContextType,
  opts: {modal?: boolean; priority?: Priority} = {},
): ActionContextConfig => ({
  type,
  displayName: type,
  ...opts,
  validateDependencies: (deps: unknown): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null,
})

// `order` is activation order: first = oldest, last = most-recently activated,
// matching ActiveContextsMap insertion order.
const ctxOf = (
  order: ActionContextType[],
  configs: ActionContextConfig[],
): ResolutionContext => ({
  active: new Map(order.map(t => [t, {} as BaseShortcutDependencies])) satisfies Map<
    ActionContextType,
    BaseShortcutDependencies
  > as ActiveContextsMap,
  contextConfigsByType: new Map(configs.map(c => [c.type, c])),
})

const action = (id: string, context: ActionContextType): ActionConfig => ({
  id,
  description: id,
  context,
  handler: () => {},
})

const KEY = {kind: 'keyboard'} as const

describe('resolve precedence', () => {
  it('higher-priority context wins a collision even when activated earlier', () => {
    // 'report' (high) was activated FIRST; normal-mode (default) LATER, so
    // recency alone would pick normal-mode. Priority must override recency.
    const ctx = ctxOf(
      ['report', ActionContextTypes.NORMAL_MODE],
      [config('report', {priority: 'high'}), config(ActionContextTypes.NORMAL_MODE)],
    )
    const ordered = resolve(
      [action('x', 'report'), action('x', ActionContextTypes.NORMAL_MODE)],
      ctx,
      KEY,
    )
    expect(ordered.map(a => a.context)).toEqual(['report', ActionContextTypes.NORMAL_MODE])
  })

  it('a non-active high-priority context outranks an active default on a gesture', () => {
    // block-pointer is never "active" (it carries supplied deps, not installed
    // state), so for a gesture trigger it isn't in the active map at all and the
    // recency tiebreak alone would rank the focused normal-mode candidate first.
    // Priority `high` must still order block-pointer ahead — this is what lets a
    // right-swipe close an open menu (block-pointer) win over the todo cycle
    // (normal-mode) bound to the same `swipe-right`.
    const ctx = ctxOf(
      [ActionContextTypes.NORMAL_MODE],
      [
        config(ActionContextTypes.BLOCK_POINTER, {priority: 'high'}),
        config(ActionContextTypes.NORMAL_MODE),
      ],
    )
    const ordered = resolve(
      [
        action('cycle', ActionContextTypes.NORMAL_MODE),
        action('close', ActionContextTypes.BLOCK_POINTER),
      ],
      ctx,
      {kind: 'gesture'},
    )
    expect(ordered.map(a => a.context)).toEqual([
      ActionContextTypes.BLOCK_POINTER,
      ActionContextTypes.NORMAL_MODE,
    ])
  })

  it('equal priority falls back to the most-recently-activated context', () => {
    const ctx = ctxOf(
      [ActionContextTypes.NORMAL_MODE, 'other'],
      [config(ActionContextTypes.NORMAL_MODE), config('other')],
    )
    const ordered = resolve(
      [action('x', ActionContextTypes.NORMAL_MODE), action('x', 'other')],
      ctx,
      KEY,
    )
    expect(ordered[0]!.context).toBe('other')
  })

  it('global is a reserved top tier above any scoped context, regardless of priority/recency', () => {
    // global activated first (older) and 'report' is high-priority + newer;
    // global still wins because it sits above all priority tiers.
    const ctx = ctxOf(
      [ActionContextTypes.GLOBAL, 'report'],
      [config(ActionContextTypes.GLOBAL), config('report', {priority: 'high'})],
    )
    const ordered = resolve(
      [action('x', ActionContextTypes.GLOBAL), action('x', 'report')],
      ctx,
      KEY,
    )
    expect(ordered[0]!.context).toBe(ActionContextTypes.GLOBAL)
  })

  it('an active modal outranks global on a shared chord', () => {
    const ctx = ctxOf(
      [ActionContextTypes.GLOBAL, 'scrub'],
      [config(ActionContextTypes.GLOBAL), config('scrub', {modal: true})],
    )
    const ordered = resolve(
      [action('x', ActionContextTypes.GLOBAL), action('x', 'scrub')],
      ctx,
      KEY,
    )
    expect(ordered[0]!.context).toBe('scrub')
  })

  it('a modal shadows non-global scoped contexts so they contribute no candidates', () => {
    const ctx = ctxOf(
      [ActionContextTypes.NORMAL_MODE, 'scrub'],
      [config(ActionContextTypes.NORMAL_MODE), config('scrub', {modal: true})],
    )
    const ordered = resolve(
      [action('x', ActionContextTypes.NORMAL_MODE), action('x', 'scrub')],
      ctx,
      KEY,
    )
    expect(ordered.map(a => a.context)).toEqual(['scrub'])
  })

  it('global still contributes while a modal is active', () => {
    const ctx = ctxOf(
      [ActionContextTypes.GLOBAL, 'scrub'],
      [config(ActionContextTypes.GLOBAL), config('scrub', {modal: true})],
    )
    const ordered = resolve([action('only-global', ActionContextTypes.GLOBAL)], ctx, KEY)
    expect(ordered.map(a => a.id)).toEqual(['only-global'])
  })

  it('drops candidates whose context is not active', () => {
    const ctx = ctxOf([ActionContextTypes.NORMAL_MODE], [config(ActionContextTypes.NORMAL_MODE)])
    const ordered = resolve([action('x', 'report')], ctx, KEY)
    expect(ordered).toEqual([])
  })

  it('by actionId filters to that id and orders best-first (global wins over scoped)', () => {
    // Documents the behaviour change vs the old reverse-activation lookup:
    // with same id in global + a newer scoped context, global now wins.
    const ctx = ctxOf(
      [ActionContextTypes.GLOBAL, ActionContextTypes.NORMAL_MODE],
      [config(ActionContextTypes.GLOBAL), config(ActionContextTypes.NORMAL_MODE)],
    )
    const all = [
      action('save', ActionContextTypes.GLOBAL),
      action('save', ActionContextTypes.NORMAL_MODE),
      action('other', ActionContextTypes.NORMAL_MODE),
    ]
    const ordered = resolve(all, ctx, {kind: 'action', actionId: 'save'})
    expect(ordered.map(a => a.context)).toEqual([
      ActionContextTypes.GLOBAL,
      ActionContextTypes.NORMAL_MODE,
    ])
    expect(ordered.every(a => a.id === 'save')).toBe(true)
  })

  it('by actionId ignores modal shadowing (imperative invocation is not gated by the install filter)', () => {
    // A modal is active and 'indent' lives in normal-mode, which the keyboard
    // path shadows. runActionById must still find it — modal shadowing is a
    // keyboard-install concern only.
    const ctx = ctxOf(
      [ActionContextTypes.NORMAL_MODE, 'multi'],
      [config(ActionContextTypes.NORMAL_MODE), config('multi', {modal: true})],
    )
    const byKey = resolve([action('indent', ActionContextTypes.NORMAL_MODE)], ctx, KEY)
    const byId = resolve([action('indent', ActionContextTypes.NORMAL_MODE)], ctx, {
      kind: 'action',
      actionId: 'indent',
    })
    expect(byKey).toEqual([]) // shadowed for the keyboard
    expect(byId.map(a => a.context)).toEqual([ActionContextTypes.NORMAL_MODE]) // found by id
  })
})

describe('resolve by supplied deps (context need not be active)', () => {
  it('matches by id even when the action\'s context is not active', () => {
    // The swipe gesture holds the clicked block's deps, but that block's
    // context (normal-mode) isn't keyboard-active. {kind:'action'} drops it
    // for exactly that reason; {kind:'supplied'} matches on id alone and lets
    // resolveDeps validate the supplied deps downstream.
    const ctx = ctxOf([], [config(ActionContextTypes.NORMAL_MODE)])
    const all = [action('block.swipe-right', ActionContextTypes.NORMAL_MODE)]
    const byAction = resolve(all, ctx, {kind: 'action', actionId: 'block.swipe-right'})
    const bySupplied = resolve(all, ctx, {kind: 'supplied', actionId: 'block.swipe-right'})
    expect(byAction).toEqual([]) // inactive context → not found
    expect(bySupplied.map(a => a.id)).toEqual(['block.swipe-right'])
  })

  it('filters to the matching id and is not suppressed by an active modal', () => {
    // normal-mode is active but shadowed by the 'multi' modal for the keyboard.
    // Supplied dispatch is not a keyboard-install concern, so the id still
    // resolves (mirrors {kind:'action'}'s shadowing exemption).
    const ctx = ctxOf(
      [ActionContextTypes.NORMAL_MODE, 'multi'],
      [config(ActionContextTypes.NORMAL_MODE), config('multi', {modal: true})],
    )
    const all = [
      action('copy_block', ActionContextTypes.NORMAL_MODE),
      action('delete_block', ActionContextTypes.NORMAL_MODE),
    ]
    const ordered = resolve(all, ctx, {kind: 'supplied', actionId: 'copy_block'})
    expect(ordered.map(a => a.id)).toEqual(['copy_block'])
  })
})

describe('resolve gesture arm (pre-matched, no shadowing, context need not be active)', () => {
  it('includes a pre-matched gesture candidate whose context is inactive and modal-shadowed', () => {
    // Candidates arrive already matched on their gestureBinding (the coordinator
    // did that). resolve must keep them regardless of active/modal state — a
    // recognized gesture targets the block it ran on — so an inactive context is
    // NOT dropped and an active modal does NOT shadow it, exactly like 'pointer'.
    const ctx = ctxOf(
      ['scrub-modal'],
      [config(ActionContextTypes.NORMAL_MODE), config('scrub-modal', {modal: true})],
    )
    const all = [action('block.swipe-right', ActionContextTypes.NORMAL_MODE)]
    expect(resolve(all, ctx, {kind: 'gesture'}).map(a => a.id)).toEqual(['block.swipe-right'])
  })
})

describe('resolveDeps', () => {
  const NM = ActionContextTypes.NORMAL_MODE
  const configs = new Map([[NM, config(NM)]])

  it('returns the active deps untouched when nothing is supplied', () => {
    const activeDeps = {renderScopeId: 'scope-a'} as unknown as BaseShortcutDependencies
    const active = new Map([[NM, activeDeps]]) as ActiveContextsMap
    expect(resolveDeps(action('x', NM), active, configs)).toBe(activeDeps)
  })

  it('uses supplied deps standalone — does NOT inherit fields from an active context of the same type', () => {
    // A focused embed has NORMAL_MODE active carrying its own renderScopeId. A
    // swipe on the main outline supplies deps WITHOUT a renderScopeId. The
    // supplied set must win wholesale: the embed's scope must not leak in, or
    // the swiped action would focus/open as if from that unrelated instance.
    const active = new Map([
      [NM, {renderScopeId: 'embed-scope', scopeRootForcesOpen: false} as unknown as BaseShortcutDependencies],
    ]) as ActiveContextsMap
    const supplied = {block: {id: 'b'}, uiStateBlock: {id: 'p'}} as unknown as BaseShortcutDependencies
    const resolved = resolveDeps(action('block.swipe-right', NM), active, configs, supplied)
    expect(resolved).toBe(supplied)
    expect(resolved && 'renderScopeId' in resolved).toBe(false)
  })

  it('returns null when supplied deps fail the context validator', () => {
    const strict = new Map([[NM, {
      ...config(NM),
      validateDependencies: (d: unknown): d is BaseShortcutDependencies =>
        typeof d === 'object' && d !== null && 'block' in d,
    }]])
    const active = new Map() as ActiveContextsMap
    expect(resolveDeps(action('x', NM), active, strict, {} as BaseShortcutDependencies)).toBeNull()
  })
})

describe('compareContexts', () => {
  it('is a stable comparator (antisymmetric on tier)', () => {
    const ctx = ctxOf(
      [ActionContextTypes.GLOBAL, ActionContextTypes.NORMAL_MODE],
      [config(ActionContextTypes.GLOBAL), config(ActionContextTypes.NORMAL_MODE)],
    )
    const ab = compareContexts(ActionContextTypes.GLOBAL, ActionContextTypes.NORMAL_MODE, ctx)
    const ba = compareContexts(ActionContextTypes.NORMAL_MODE, ActionContextTypes.GLOBAL, ctx)
    expect(ab).toBeLessThan(0) // global first
    expect(ba).toBeGreaterThan(0)
  })
})

describe('computeInstallableContexts', () => {
  it('collapses to {global, latest modal} when a modal is active', () => {
    const {active, contextConfigsByType} = ctxOf(
      [ActionContextTypes.GLOBAL, ActionContextTypes.NORMAL_MODE, 'scrub'],
      [
        config(ActionContextTypes.GLOBAL),
        config(ActionContextTypes.NORMAL_MODE),
        config('scrub', {modal: true}),
      ],
    )
    const set = computeInstallableContexts(active, contextConfigsByType)
    expect([...set].sort()).toEqual([ActionContextTypes.GLOBAL, 'scrub'].sort())
  })

  it('returns every active context when none is modal', () => {
    const {active, contextConfigsByType} = ctxOf(
      [ActionContextTypes.GLOBAL, ActionContextTypes.NORMAL_MODE],
      [config(ActionContextTypes.GLOBAL), config(ActionContextTypes.NORMAL_MODE)],
    )
    const set = computeInstallableContexts(active, contextConfigsByType)
    expect([...set].sort()).toEqual(
      [ActionContextTypes.GLOBAL, ActionContextTypes.NORMAL_MODE].sort(),
    )
  })
})
