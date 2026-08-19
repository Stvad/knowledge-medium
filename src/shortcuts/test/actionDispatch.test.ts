import { describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import type { VerbOutcome } from '@/facets/verbFacet.js'
import {
  actionDispatchVerb,
  actionDispatchWrap,
  invokeAction,
} from '@/shortcuts/actionDispatch.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionHandlerResult,
  type ActionTrigger,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'

// Generic verb mechanics (decorator fold order, onError, observer isolation,
// fallback) are covered by `verbFacet.test.ts`. This suite covers the
// dispatch-specific layer: that `invokeAction` (the verb's passthrough
// `runSync`) preserves the synchronous `ActionHandlerResult` and that the
// `actionDispatchWrap` adapter targets by action id + context.

const action = (overrides: Partial<ActionConfig> = {}): ActionConfig => ({
  id: 'test.action',
  description: 'Test action',
  context: ActionContextTypes.NORMAL_MODE,
  handler: vi.fn(),
  ...overrides,
} as ActionConfig)

const deps = {} as BaseShortcutDependencies
const trigger = {} as ActionTrigger

describe('invokeAction (action-dispatch passthrough)', () => {
  it('calls the action handler when nothing is contributed', () => {
    const handler = vi.fn()
    const a = action({handler})
    const runtime = resolveFacetRuntimeSync([])

    invokeAction(runtime, {action: a, deps, trigger})
    expect(handler).toHaveBeenCalledWith(deps, trigger, undefined)
  })

  it('preserves a SYNCHRONOUS `false` decline (not wrapped in a Promise)', () => {
    // The load-bearing constraint: the run-until-handled loop reads a sync
    // `false` to fall through to the next candidate.
    const a = action({handler: () => false})
    const runtime = resolveFacetRuntimeSync([])

    expect(invokeAction(runtime, {action: a, deps, trigger})).toBe(false)
  })

  it('a decline survives even through a passthrough wrap', () => {
    const a = action({handler: () => false})
    const runtime = resolveFacetRuntimeSync([
      actionDispatchWrap({actionId: '*', wrap: (d, t, next, disp) => next(d, t, disp)}),
    ])

    expect(invokeAction(runtime, {action: a, deps, trigger})).toBe(false)
  })

  it('returns an async handler Promise verbatim (un-awaited)', () => {
    const a = action({handler: async () => undefined})
    const runtime = resolveFacetRuntimeSync([])

    expect(invokeAction(runtime, {action: a, deps, trigger})).toBeInstanceOf(Promise)
  })

  it('wraps only the matching action (id + context); next reaches the base handler', () => {
    const calls: string[] = []
    const base = vi.fn(() => {
      calls.push('base')
    })
    const a = action({id: 'move_down', handler: base})
    const other = action({id: 'move_up', handler: base})
    const runtime = resolveFacetRuntimeSync([
      actionDispatchWrap({
        actionId: 'move_down',
        context: ActionContextTypes.NORMAL_MODE,
        wrap: (d, t, next, disp) => {
          calls.push('wrap')
          return next(d, t, disp)
        },
      }),
    ])

    invokeAction(runtime, {action: a, deps, trigger})
    invokeAction(runtime, {action: other, deps, trigger})
    // The wrap ran for move_down (before its base) but not for move_up.
    expect(calls).toEqual(['wrap', 'base', 'base'])
  })

  it('a wrap can short-circuit without calling next (replace)', () => {
    const base = vi.fn()
    const a = action({handler: base})
    const runtime = resolveFacetRuntimeSync([
      actionDispatchWrap({actionId: '*', wrap: () => undefined}),
    ])

    invokeAction(runtime, {action: a, deps, trigger})
    expect(base).not.toHaveBeenCalled()
  })

  it('the base invocation strategy is replaceable via the verb impl', () => {
    const base = vi.fn()
    const replacement = vi.fn()
    const a = action({handler: base})
    const runtime = resolveFacetRuntimeSync([
      actionDispatchVerb.impl(({action: act, deps: d, trigger: t}) => replacement(act.id, d, t)),
    ])

    invokeAction(runtime, {action: a, deps, trigger})
    expect(base).not.toHaveBeenCalled()
    expect(replacement).toHaveBeenCalledWith('test.action', deps, trigger)
  })

  it('before/after observers fire with the dispatch outcome', () => {
    const events: string[] = []
    const outcomes: VerbOutcome<ActionHandlerResult>[] = []
    const a = action({handler: () => false})
    const runtime = resolveFacetRuntimeSync([
      actionDispatchVerb.before(() => { events.push('before') }),
      actionDispatchVerb.after((_inv, outcome) => {
        events.push('after')
        outcomes.push(outcome)
      }),
    ])

    invokeAction(runtime, {action: a, deps, trigger})
    expect(events).toEqual(['before', 'after'])
    // A sync `false` is a decline, surfaced as a successful outcome carrying `false`.
    expect(outcomes).toEqual([{ok: true, result: false}])
  })

  it('fires after({ok:false}) and rethrows when the handler throws synchronously', () => {
    const boom = new Error('boom')
    const outcomes: VerbOutcome<ActionHandlerResult>[] = []
    const a = action({handler: () => { throw boom }})
    const runtime = resolveFacetRuntimeSync([
      actionDispatchVerb.after((_inv, outcome) => { outcomes.push(outcome) }),
    ])

    expect(() => invokeAction(runtime, {action: a, deps, trigger})).toThrow('boom')
    expect(outcomes).toEqual([{ok: false, error: boom}])
  })

  it('does NOT re-run a throwing handler — pins onError:"rethrow" (effectful, no double-execute)', () => {
    // Dispatch is effectful, so `actionDispatchVerb` uses `onError: 'rethrow'`:
    // a throwing handler must surface, never re-run the default. A wrap MUST be
    // present for this to bite — with no contribution the verb runs the bare
    // default (`ranBareDefault`), where 'rethrow' and 'fallback' are identical.
    // With a wrap registered, a 'fallback' flip would re-invoke the default impl
    // (→ the base handler) a SECOND time. Counting the calls catches that flip.
    let calls = 0
    const a = action({handler: () => { calls += 1; throw new Error('boom') }})
    const runtime = resolveFacetRuntimeSync([
      actionDispatchWrap({actionId: '*', wrap: (d, t, next, disp) => next(d, t, disp)}),
    ])

    expect(() => invokeAction(runtime, {action: a, deps, trigger})).toThrow('boom')
    expect(calls).toBe(1)
  })

  it('the context discriminator narrows: same id, different context is not wrapped', () => {
    // Real consumers (e.g. srs todo-cycle) register the SAME action id under two
    // contexts as distinct wraps, so targeting must honour `context`, not just
    // `actionId`. The id+context test above varies only the id; this one varies
    // only the context (same id) so dropping `matchesAction`'s context clause
    // goes red.
    const calls: string[] = []
    const normal = action({
      id: 'toggle',
      context: ActionContextTypes.NORMAL_MODE,
      handler: () => { calls.push('normal-base') },
    })
    const cm = action({
      id: 'toggle',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: () => { calls.push('cm-base') },
    })
    const runtime = resolveFacetRuntimeSync([
      actionDispatchWrap({
        actionId: 'toggle',
        context: ActionContextTypes.NORMAL_MODE,
        wrap: (d, t, next, disp) => {
          calls.push('wrap')
          return next(d, t, disp)
        },
      }),
    ])

    invokeAction(runtime, {action: normal, deps, trigger})
    invokeAction(runtime, {action: cm, deps, trigger})
    // The wrap fired only for the NORMAL_MODE 'toggle', never the EDIT_MODE_CM one.
    expect(calls).toEqual(['wrap', 'normal-base', 'cm-base'])
  })
})
