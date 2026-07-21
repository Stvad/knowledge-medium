// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { actionsFacet } from '@/extensions/core.js'
import type { ActiveContextsMap } from '@/shortcuts/ActiveContexts.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import {
  actionSourcesFromRuntime,
  buildShortcutHelpModel,
} from '../model.ts'

const contextConfig = (
  type: ActionContextType,
  extra: Partial<ActionContextConfig> = {},
): ActionContextConfig => ({
  type,
  displayName: `${type} name`,
  validateDependencies: (deps: unknown): deps is BaseShortcutDependencies => deps !== undefined,
  ...extra,
})

const action = (
  id: string,
  context: ActionContextType,
  keys: string | string[],
  extra: Partial<ActionConfig> = {},
): ActionConfig => ({
  id,
  description: `run ${id}`,
  context,
  handler: () => undefined,
  defaultBinding: {keys},
  ...extra,
})

const DEPS: BaseShortcutDependencies = {uiStateBlock: {} as never}

const configsByType = (configs: readonly ActionContextConfig[]) =>
  new Map(configs.map(c => [c.type, c]))

describe('buildShortcutHelpModel', () => {
  const global = contextConfig(ActionContextTypes.GLOBAL)
  const normal = contextConfig(ActionContextTypes.NORMAL_MODE)
  const palette = contextConfig('palette', {modal: true})
  const pointer = contextConfig('pointer-ish', {keyboardBindable: false})

  it('orders groups by dispatcher precedence and marks modal shadowing', () => {
    const active: ActiveContextsMap = new Map([
      [ActionContextTypes.NORMAL_MODE, DEPS],
      [ActionContextTypes.GLOBAL, DEPS],
      ['palette', DEPS],
    ])
    const actions = [
      action('g-one', ActionContextTypes.GLOBAL, '$mod+k'),
      action('n-one', ActionContextTypes.NORMAL_MODE, 'x'),
      action('p-one', 'palette', 'Escape'),
    ]
    const model = buildShortcutHelpModel(actions, {
      active,
      contextConfigsByType: configsByType([global, normal, palette]),
    })

    expect(model.groups.map(g => g.config.type)).toEqual([
      'palette',
      ActionContextTypes.GLOBAL,
      ActionContextTypes.NORMAL_MODE,
    ])
    const byType = new Map(model.groups.map(g => [g.config.type, g]))
    expect(byType.get('palette')?.shadowed).toBe(false)
    expect(byType.get(ActionContextTypes.GLOBAL)?.shadowed).toBe(false)
    expect(byType.get(ActionContextTypes.NORMAL_MODE)?.shadowed).toBe(true)
    expect(byType.get(ActionContextTypes.NORMAL_MODE)?.shadowedBy).toBe(palette.displayName)
    // Flat list mirrors group order, and shadowing flows onto the bindings.
    expect(model.bindings.map(b => b.action.id)).toEqual(['p-one', 'g-one', 'n-one'])
    expect(model.bindings.map(b => b.shadowed)).toEqual([false, false, true])
  })

  it('skips keyboard-unbindable contexts and expands multi-chord bindings', () => {
    const active: ActiveContextsMap = new Map([
      [ActionContextTypes.GLOBAL, DEPS],
      ['pointer-ish', DEPS],
    ])
    const actions = [
      action('multi', ActionContextTypes.GLOBAL, ['ArrowDown', 'j']),
      action('unlisted', 'pointer-ish', 'x'),
      {...action('unbound', ActionContextTypes.GLOBAL, 'x'), defaultBinding: undefined},
    ]
    const model = buildShortcutHelpModel(actions, {
      active,
      contextConfigsByType: configsByType([global, pointer]),
    })

    expect(model.groups.map(g => g.config.type)).toEqual([ActionContextTypes.GLOBAL])
    expect(model.bindings.map(b => b.chord)).toEqual(['ArrowDown', 'j'])
  })

  it('parses sequence chords into multi-press sequences and keeps hold metadata', () => {
    const active: ActiveContextsMap = new Map([[ActionContextTypes.GLOBAL, DEPS]])
    const actions = [
      action('seq', ActionContextTypes.GLOBAL, 'g g'),
      action('held', ActionContextTypes.GLOBAL, 's', {
        defaultBinding: {keys: 's', phase: 'hold', holdMs: 400},
      }),
    ]
    const model = buildShortcutHelpModel(actions, {
      active,
      contextConfigsByType: configsByType([global]),
    })

    const seq = model.bindings.find(b => b.action.id === 'seq')!
    expect(seq.presses).toHaveLength(2)
    const held = model.bindings.find(b => b.action.id === 'held')!
    expect(held.phase).toBe('hold')
    expect(held.holdMs).toBe(400)
  })
})

describe('actionSourcesFromRuntime', () => {
  it('maps context-qualified action ids to their contributing plugin', () => {
    const sourced = action('sourced', ActionContextTypes.GLOBAL, 'a')
    const unsourced = action('unsourced', ActionContextTypes.GLOBAL, 'b')
    const runtime = resolveFacetRuntimeSync([
      actionsFacet.of(sourced, {source: 'some-plugin'}),
      actionsFacet.of(unsourced),
    ])

    const sources = actionSourcesFromRuntime(runtime)
    expect(sources.get(`${ActionContextTypes.GLOBAL}:sourced`)).toBe('some-plugin')
    expect(sources.has(`${ActionContextTypes.GLOBAL}:unsourced`)).toBe(false)
  })
})
