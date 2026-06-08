import { describe, expect, it, vi } from 'vitest'
import {
  actionTransformsFacet,
  actionsFacet,
} from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { getActiveActionById, getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import type { ResolutionContext } from '@/shortcuts/resolve.js'
import {
  ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  ActionContextTypes,
  type BaseShortcutDependencies,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.js'

const baseAction = (overrides: Partial<ActionConfig> = {}): ActionConfig => ({
  id: 'test.action',
  description: 'Base action',
  context: ActionContextTypes.NORMAL_MODE,
  handler: vi.fn(),
  defaultBinding: {keys: 'x'},
  ...overrides,
} as ActionConfig)

describe('getEffectiveActions', () => {
  it('wraps a matching action handler without changing the raw action registry', async () => {
    const calls: string[] = []
    const action = baseAction({
      handler: async () => {
        calls.push('base')
      },
    })
    const runtime = resolveFacetRuntimeSync([
      actionsFacet.of(action),
      actionTransformsFacet.of({
        actionId: action.id,
        context: ActionContextTypes.NORMAL_MODE,
        apply: current => ({
          ...current,
          handler: async (deps, trigger) => {
            calls.push('before')
            await current.handler(deps as never, trigger)
            calls.push('after')
          },
        }),
      }),
    ])

    const effective = getEffectiveActions(runtime)
    await effective[0].handler({} as BlockShortcutDependencies, {} as KeyboardEvent)

    expect(runtime.read(actionsFacet)[0]).toBe(action)
    expect(calls).toEqual(['before', 'base', 'after'])
  })

  it('applies lower-precedence transforms innermost and higher-precedence transforms outermost', async () => {
    const calls: string[] = []
    const action = baseAction({
      handler: async () => {
        calls.push('base')
      },
    })
    const runtime = resolveFacetRuntimeSync([
      actionsFacet.of(action),
      actionTransformsFacet.of({
        actionId: action.id,
        apply: current => ({
          ...current,
          handler: async (deps, trigger) => {
            calls.push('low-before')
            await current.handler(deps as never, trigger)
            calls.push('low-after')
          },
        }),
      }, {precedence: 0}),
      actionTransformsFacet.of({
        actionId: action.id,
        apply: current => ({
          ...current,
          handler: async (deps, trigger) => {
            calls.push('high-before')
            await current.handler(deps as never, trigger)
            calls.push('high-after')
          },
        }),
      }, {precedence: 10}),
    ])

    await getEffectiveActions(runtime)[0].handler({} as BlockShortcutDependencies, {} as KeyboardEvent)

    expect(calls).toEqual([
      'high-before',
      'low-before',
      'base',
      'low-after',
      'high-after',
    ])
  })

  it('lets a transform replace metadata and remove an action (apply → null unbinds)', () => {
    const kept = baseAction()
    const removed = baseAction({id: 'test.removed'})
    const runtime = resolveFacetRuntimeSync([
      actionsFacet.of(kept),
      actionsFacet.of(removed),
      actionTransformsFacet.of({
        actionId: kept.id,
        apply: action => ({
          ...action,
          description: 'Overridden action',
          defaultBinding: {keys: 'y'},
        }),
      }),
      actionTransformsFacet.of({
        actionId: removed.id,
        apply: () => null,
      }),
    ])

    expect(getEffectiveActions(runtime).map(action => ({
      id: action.id,
      description: action.description,
      binding: action.defaultBinding?.keys,
    }))).toEqual([{
      id: kept.id,
      description: 'Overridden action',
      binding: 'y',
    }])
  })

  it("treats actionId '*' as a wildcard that matches every action", () => {
    const first = baseAction({id: 'test.first'})
    const second = baseAction({id: 'test.second'})
    const visited: string[] = []
    const runtime = resolveFacetRuntimeSync([
      actionsFacet.of(first),
      actionsFacet.of(second),
      actionTransformsFacet.of({
        actionId: '*',
        apply: action => {
          visited.push(action.id)
          return {...action, description: `seen:${action.id}`}
        },
      }),
    ])

    expect(getEffectiveActions(runtime).map(a => a.description)).toEqual([
      'seen:test.first',
      'seen:test.second',
    ])
    expect(visited).toEqual(['test.first', 'test.second'])
  })

  it("respects the context filter even when actionId is '*'", () => {
    const normal = baseAction({id: 'test.normal'})
    const edit = baseAction({
      id: 'test.edit',
      context: ActionContextTypes.EDIT_MODE_CM,
    })
    const runtime = resolveFacetRuntimeSync([
      actionsFacet.of(normal),
      actionsFacet.of(edit),
      actionTransformsFacet.of({
        actionId: '*',
        context: ActionContextTypes.EDIT_MODE_CM,
        apply: action => ({...action, description: 'edit-only'}),
      }),
    ])

    expect(getEffectiveActions(runtime).map(a => a.description)).toEqual([
      'Base action',
      'edit-only',
    ])
  })

  it('matches context-specific transforms only against that action context', async () => {
    const normal = baseAction({
      handler: async () => undefined,
    })
    const edit = baseAction({
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async () => undefined,
    })
    const runtime = resolveFacetRuntimeSync([
      actionsFacet.of(normal),
      actionsFacet.of(edit),
      actionTransformsFacet.of({
        actionId: normal.id,
        context: ActionContextTypes.EDIT_MODE_CM,
        apply: action => ({
          ...action,
          description: 'Transformed edit action',
        }),
      }),
    ])

    expect(getEffectiveActions(runtime).map(action => action.description)).toEqual([
      'Base action',
      'Transformed edit action',
    ])
  })
})

describe('getActiveActionById', () => {
  const cfg = (type: ActionContextType): ActionContextConfig => ({
    type,
    displayName: type,
    validateDependencies: (d): d is BaseShortcutDependencies =>
      typeof d === 'object' && d !== null,
  })

  it('resolves a global-vs-scoped id collision to global (reserved top tier)', () => {
    // Behaviour change vs the old reverse-activation lookup: when the same id
    // is registered in both global and a more-recently-activated scoped
    // context (e.g. undo/redo in global + vim normal-mode), the imperative
    // path (runActionById / useRunAction) now resolves to global rather than
    // to the newer scoped context. Recency alone would have picked NORMAL_MODE.
    const globalUndo = baseAction({id: 'undo', context: ActionContextTypes.GLOBAL})
    const scopedUndo = baseAction({id: 'undo', context: ActionContextTypes.NORMAL_MODE})
    const ctx: ResolutionContext = {
      active: new Map<ActionContextType, BaseShortcutDependencies>([
        [ActionContextTypes.GLOBAL, {} as BaseShortcutDependencies],
        [ActionContextTypes.NORMAL_MODE, {} as BaseShortcutDependencies],
      ]),
      contextConfigsByType: new Map([
        [ActionContextTypes.GLOBAL, cfg(ActionContextTypes.GLOBAL)],
        [ActionContextTypes.NORMAL_MODE, cfg(ActionContextTypes.NORMAL_MODE)],
      ]),
    }

    expect(getActiveActionById([globalUndo, scopedUndo], ctx, 'undo')?.context)
      .toBe(ActionContextTypes.GLOBAL)
  })
})
