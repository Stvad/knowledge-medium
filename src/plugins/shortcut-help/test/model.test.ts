// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createKeybindingsHandler } from 'tinykeys'
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
  matchPressedSequence,
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

const press = (init: KeyboardEventInit): KeyboardEvent =>
  new KeyboardEvent('keydown', init)

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

describe('matchPressedSequence', () => {
  const global = contextConfig(ActionContextTypes.GLOBAL)
  const active: ActiveContextsMap = new Map([[ActionContextTypes.GLOBAL, DEPS]])
  const model = buildShortcutHelpModel(
    [
      action('palette', ActionContextTypes.GLOBAL, '$mod+k'),
      action('bare', ActionContextTypes.GLOBAL, 'g'),
      action('top', ActionContextTypes.GLOBAL, 'g g'),
      action('link', ActionContextTypes.GLOBAL, 'y l'),
      action('today', ActionContextTypes.GLOBAL, 'Control+Shift+Backquote'),
      action('scroll', ActionContextTypes.GLOBAL, 'Control+d'),
    ],
    {active, contextConfigsByType: configsByType([global])},
  )

  // jsdom's navigator.platform is non-Mac, so tinykeys resolves $mod → Control.

  it('matches a $mod chord pressed with the platform-primary modifier', () => {
    const {exact, pending} = matchPressedSequence(model.bindings, [press({key: 'k', ctrlKey: true})])
    expect(exact.map(b => b.action.id)).toEqual(['palette'])
    expect(pending).toHaveLength(0)
  })

  it('does not match $mod against the non-primary modifier (Win+K ≠ Ctrl+K)', () => {
    const {exact, pending} = matchPressedSequence(model.bindings, [press({key: 'k', metaKey: true})])
    expect(exact).toHaveLength(0)
    expect(pending).toHaveLength(0)
  })

  it('matches literal-Control bindings on the platform where Control is primary', () => {
    const {exact} = matchPressedSequence(model.bindings, [press({key: 'd', ctrlKey: true})])
    expect(exact.map(b => b.action.id)).toEqual(['scroll'])
  })

  it('matches code-form bindings via event.code when the key is a shifted glyph', () => {
    const {exact} = matchPressedSequence(model.bindings, [
      press({key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true}),
    ])
    expect(exact.map(b => b.action.id)).toEqual(['today'])
  })

  it('requires the exact modifier set', () => {
    const {exact, pending} = matchPressedSequence(model.bindings, [press({key: 'g', ctrlKey: true})])
    expect(exact).toHaveLength(0)
    expect(pending).toHaveLength(0)
  })

  it('reports sequence continuations for a live prefix alongside exact hits', () => {
    const {exact, pending} = matchPressedSequence(model.bindings, [press({key: 'g'})])
    expect(exact.map(b => b.action.id)).toEqual(['bare'])
    expect(pending.map(b => b.action.id)).toEqual(['top'])
  })

  it('completes a sequence chord', () => {
    const {exact, pending} = matchPressedSequence(model.bindings, [press({key: 'g'}), press({key: 'g'})])
    expect(exact.map(b => b.action.id)).toEqual(['top'])
    expect(pending).toHaveLength(0)
  })

  it('drops a buffer that diverges from every sequence', () => {
    const {exact, pending} = matchPressedSequence(model.bindings, [press({key: 'y'}), press({key: 'x'})])
    expect(exact).toHaveLength(0)
    expect(pending).toHaveLength(0)
  })
})

describe('matchPressedSequence ↔ tinykeys parity', () => {
  // The inspector's verdict must agree with what the dispatcher's own
  // matcher would do for the same events. Table covers the chord shapes in
  // the real binding corpus: $mod, literal Control, code-form keys, shifted
  // glyphs, sequences, and exact-modifier-set negatives.
  const tinykeysFires = (chord: string, events: readonly KeyboardEvent[]): boolean => {
    let fired = false
    const handler = createKeybindingsHandler({[chord]: () => { fired = true }}, {ignore: () => false})
    for (const event of events) handler(event)
    return fired
  }

  // Real keyboard events always carry `code` — tinykeys' handler rejects
  // events without one (`isKeyboardEvent`), so the synthesized events do too.
  const CASES: Array<{chord: string; events: KeyboardEventInit[]}> = [
    {chord: '$mod+k', events: [{key: 'k', code: 'KeyK', ctrlKey: true}]},
    {chord: '$mod+k', events: [{key: 'k', code: 'KeyK', metaKey: true}]},
    {chord: 'Control+d', events: [{key: 'd', code: 'KeyD', ctrlKey: true}]},
    {chord: 'Control+Shift+Backquote', events: [{key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true}]},
    {chord: 'Control+Shift+BracketLeft', events: [{key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true}]},
    {chord: 'Shift+?', events: [{key: '?', code: 'Slash', shiftKey: true}]},
    {chord: '?', events: [{key: '?', code: 'Slash', shiftKey: true}]},
    {chord: 'g', events: [{key: 'g', code: 'KeyG', ctrlKey: true}]},
    {chord: 'Space', events: [{key: ' ', code: 'Space'}]},
    {chord: 'g g', events: [{key: 'g', code: 'KeyG'}, {key: 'g', code: 'KeyG'}]},
    {chord: 'g g', events: [{key: 'g', code: 'KeyG'}, {key: 'h', code: 'KeyH'}]},
    {chord: 'Control+Shift+Digit3', events: [{key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true}]},
  ]

  it.each(CASES)('agrees with tinykeys on %j', ({chord, events}) => {
    const global = contextConfig(ActionContextTypes.GLOBAL)
    const model = buildShortcutHelpModel(
      [action('probe', ActionContextTypes.GLOBAL, chord)],
      {
        active: new Map([[ActionContextTypes.GLOBAL, DEPS]]),
        contextConfigsByType: configsByType([global]),
      },
    )
    const pressedEvents = events.map(init => press(init))
    const {exact} = matchPressedSequence(model.bindings, pressedEvents)
    expect(exact.length > 0).toBe(tinykeysFires(chord, pressedEvents))
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
