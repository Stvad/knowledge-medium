import { describe, expect, it, vi } from 'vitest'
import { applyKeybindingOverrides } from './applyKeybindingOverrides.ts'
import {
  KEYBINDING_OVERRIDE_USER_SOURCE,
  type KeybindingOverride,
} from './keybindingOverrides.ts'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextType,
} from './types.ts'

const action = (
  id: string,
  context: ActionContextType,
  keys?: string | string[],
): ActionConfig => ({
  id,
  context,
  description: id,
  handler: vi.fn(),
  defaultBinding: keys === undefined ? undefined : {keys},
})

const userOverride = (over: Partial<KeybindingOverride> & {actionId: string; binding: KeybindingOverride['binding']}): KeybindingOverride => ({
  source: KEYBINDING_OVERRIDE_USER_SOURCE,
  ...over,
})

describe('applyKeybindingOverrides', () => {
  it('returns the input unchanged when no overrides are supplied', () => {
    const actions = [action('a', ActionContextTypes.NORMAL_MODE, 'ctrl+a')]
    expect(applyKeybindingOverrides(actions, [])).toBe(actions)
  })

  it('rewrites a single action’s keys when an override matches — installed normalised, not verbatim', () => {
    const actions = [action('a', ActionContextTypes.NORMAL_MODE, 'ctrl+a')]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'a',
      context: ActionContextTypes.NORMAL_MODE,
      binding: {keys: 'ctrl+shift+a'},
    })])

    // `ctrl` is a spelling tinykeys can't dispatch; the normalised form is
    // what gets installed so the override actually fires (issue #388).
    expect(out[0]!.defaultBinding).toEqual({keys: 'Control+Shift+a'})
  })

  it('lets an unbound override clear the default binding entirely', () => {
    const actions = [action('a', ActionContextTypes.NORMAL_MODE, 'ctrl+a')]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'a',
      context: ActionContextTypes.NORMAL_MODE,
      binding: {unbound: true},
    })])

    expect(out[0]!.defaultBinding).toBeUndefined()
  })

  it('respects override precedence — later entry wins for the same action', () => {
    const actions = [action('a', ActionContextTypes.NORMAL_MODE, 'ctrl+a')]
    const out = applyKeybindingOverrides(actions, [
      userOverride({actionId: 'a', context: ActionContextTypes.NORMAL_MODE, binding: {keys: 'first'}, source: 'plugin-x'}),
      userOverride({actionId: 'a', context: ActionContextTypes.NORMAL_MODE, binding: {keys: 'last'}}),
    ])

    expect(out[0]!.defaultBinding).toEqual({keys: 'last'})
  })

  it('falls back to the action’s own context when an override omits one', () => {
    const actions = [action('a', ActionContextTypes.EDIT_MODE_CM, 'ctrl+a')]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'a',
      binding: {keys: 'ctrl+b'},
    })])

    expect(out[0]!.defaultBinding).toEqual({keys: 'Control+b'})
  })

  it('strips a default chord that another action’s override claims in the same context', () => {
    const actions = [
      action('victim', ActionContextTypes.NORMAL_MODE, 'cmd+k'),
      action('claimer', ActionContextTypes.NORMAL_MODE, 'cmd+j'),
    ]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'claimer',
      context: ActionContextTypes.NORMAL_MODE,
      binding: {keys: 'cmd+k'},
    })])

    expect(out[0]!.defaultBinding).toBeUndefined()
    expect(out[1]!.defaultBinding).toEqual({keys: '$mod+k'})
  })

  it('keeps the un-claimed chords of a multi-chord default', () => {
    const actions = [
      action('victim', ActionContextTypes.NORMAL_MODE, ['cmd+k', 'cmd+j']),
      action('claimer', ActionContextTypes.NORMAL_MODE, 'cmd+z'),
    ]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'claimer',
      context: ActionContextTypes.NORMAL_MODE,
      binding: {keys: 'cmd+k'},
    })])

    expect(out[0]!.defaultBinding).toEqual({keys: 'cmd+j'})
  })

  it('treats a global override as overlapping with every context', () => {
    const actions = [
      action('victim', ActionContextTypes.NORMAL_MODE, 'cmd+k'),
      action('global-claimer', ActionContextTypes.GLOBAL, 'cmd+j'),
    ]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'global-claimer',
      context: ActionContextTypes.GLOBAL,
      binding: {keys: 'cmd+k'},
    })])

    expect(out[0]!.defaultBinding).toBeUndefined()
  })

  it('treats a global default as colliding with any scoped override claiming the same chord', () => {
    const actions = [
      action('victim', ActionContextTypes.GLOBAL, 'cmd+k'),
      action('claimer', ActionContextTypes.NORMAL_MODE, 'cmd+j'),
    ]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'claimer',
      context: ActionContextTypes.NORMAL_MODE,
      binding: {keys: 'cmd+k'},
    })])

    expect(out[0]!.defaultBinding).toBeUndefined()
  })

  it('does not strip a default when contexts are disjoint and neither is global', () => {
    const actions = [
      action('victim', ActionContextTypes.NORMAL_MODE, 'cmd+k'),
      action('claimer', ActionContextTypes.EDIT_MODE_CM, 'cmd+j'),
    ]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'claimer',
      context: ActionContextTypes.EDIT_MODE_CM,
      binding: {keys: 'cmd+k'},
    })])

    expect(out[0]!.defaultBinding).toEqual({keys: 'cmd+k'})
  })

  it('lets two overrides on the same chord both keep their binding (user-vs-user warn case)', () => {
    const actions = [
      action('a', ActionContextTypes.NORMAL_MODE, undefined),
      action('b', ActionContextTypes.NORMAL_MODE, undefined),
    ]
    const out = applyKeybindingOverrides(actions, [
      userOverride({actionId: 'a', context: ActionContextTypes.NORMAL_MODE, binding: {keys: 'cmd+k'}}),
      userOverride({actionId: 'b', context: ActionContextTypes.NORMAL_MODE, binding: {keys: 'cmd+k'}}),
    ])

    expect(out[0]!.defaultBinding).toEqual({keys: '$mod+k'})
    expect(out[1]!.defaultBinding).toEqual({keys: '$mod+k'})
  })

  it('ignores a default whose action has no binding to begin with', () => {
    const actions = [action('a', ActionContextTypes.NORMAL_MODE, undefined)]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'other',
      context: ActionContextTypes.NORMAL_MODE,
      binding: {keys: 'cmd+k'},
    })])

    expect(out[0]!.defaultBinding).toBeUndefined()
  })

  it('a dispatch-dead override spelling is installed live instead of stripping the chord out of existence (issue #388)', () => {
    // Pre-fix: the override's raw `ctrl+x` was installed verbatim on the
    // claimer (tinykeys knows `Control`, not `ctrl` — never fires) while
    // its canonical claim stripped the victim's live `Control+x` default.
    // Net effect: the chord dispatched NOTHING. Canonical install keeps
    // the strip AND makes the claimer actually own the chord.
    const actions = [
      action('victim', ActionContextTypes.NORMAL_MODE, 'Control+x'),
      action('claimer', ActionContextTypes.NORMAL_MODE, 'cmd+j'),
    ]
    const out = applyKeybindingOverrides(actions, [userOverride({
      actionId: 'claimer',
      context: ActionContextTypes.NORMAL_MODE,
      binding: {keys: 'ctrl+x'},
    })])

    expect(out[0]!.defaultBinding).toBeUndefined()
    expect(out[1]!.defaultBinding).toEqual({keys: 'Control+x'})
  })

  it('preserves the action’s existing eventOptions through a rewrite', () => {
    const a = action('a', ActionContextTypes.NORMAL_MODE, 'cmd+a')
    a.defaultBinding = {keys: 'cmd+a', eventOptions: {preventDefault: false}}
    const out = applyKeybindingOverrides([a], [userOverride({
      actionId: 'a',
      context: ActionContextTypes.NORMAL_MODE,
      binding: {keys: 'cmd+b'},
    })])

    expect(out[0]!.defaultBinding).toEqual({
      keys: '$mod+b',
      eventOptions: {preventDefault: false},
    })
  })
})
