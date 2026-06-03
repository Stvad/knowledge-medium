import { describe, expect, it } from 'vitest'
import {
  compareContexts,
  computeInstallableContexts,
  resolve,
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

const KEY = {kind: 'key', key: 'x', mods: [], phase: 'keydown'} as const

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
