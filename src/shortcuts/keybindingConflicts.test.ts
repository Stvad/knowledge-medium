import { describe, expect, it, vi } from 'vitest'
import { findKeybindingConflicts } from './keybindingConflicts.ts'
import { ActionContextTypes, type ActionConfig, type ActionContextType } from './types.ts'

const action = (
  id: string,
  context: ActionContextType,
  keys: string | string[] | undefined,
): ActionConfig => ({
  id,
  context,
  description: id,
  handler: vi.fn(),
  defaultBinding: keys === undefined ? undefined : {keys},
})

describe('findKeybindingConflicts', () => {
  it('returns no conflicts when each action has a unique chord', () => {
    expect(findKeybindingConflicts([
      action('a', ActionContextTypes.NORMAL_MODE, 'cmd+a'),
      action('b', ActionContextTypes.NORMAL_MODE, 'cmd+b'),
    ])).toEqual([])
  })

  it('flags two actions sharing a chord in the same context', () => {
    const conflicts = findKeybindingConflicts([
      action('a', ActionContextTypes.NORMAL_MODE, 'cmd+k'),
      action('b', ActionContextTypes.NORMAL_MODE, 'cmd+k'),
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.chord).toBe('cmd+k')
    expect(conflicts[0]!.actions.map(a => a.actionId)).toEqual(['a', 'b'])
  })

  it('flags a global vs a scoped action sharing a chord', () => {
    const conflicts = findKeybindingConflicts([
      action('a', ActionContextTypes.GLOBAL, 'cmd+k'),
      action('b', ActionContextTypes.NORMAL_MODE, 'cmd+k'),
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.actions.map(a => a.actionId)).toEqual(['a', 'b'])
  })

  it('does NOT flag two scoped actions in disjoint contexts', () => {
    expect(findKeybindingConflicts([
      action('a', ActionContextTypes.NORMAL_MODE, 'cmd+k'),
      action('b', ActionContextTypes.EDIT_MODE_CM, 'cmd+k'),
    ])).toEqual([])
  })

  it('flags every chord in a multi-chord overlap independently', () => {
    const conflicts = findKeybindingConflicts([
      action('a', ActionContextTypes.NORMAL_MODE, ['cmd+k', 'cmd+j']),
      action('b', ActionContextTypes.NORMAL_MODE, ['cmd+k', 'cmd+j']),
    ])

    expect(conflicts.map(c => c.chord)).toEqual(['cmd+j', 'cmd+k'])
  })

  it('groups every global action together on a shared chord', () => {
    const conflicts = findKeybindingConflicts([
      action('a', ActionContextTypes.GLOBAL, 'cmd+k'),
      action('b', ActionContextTypes.GLOBAL, 'cmd+k'),
      action('c', ActionContextTypes.NORMAL_MODE, 'cmd+k'),
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.actions.map(a => a.actionId)).toEqual(['a', 'b', 'c'])
  })

  it('ignores actions without a default binding', () => {
    expect(findKeybindingConflicts([
      action('a', ActionContextTypes.NORMAL_MODE, undefined),
      action('b', ActionContextTypes.NORMAL_MODE, undefined),
    ])).toEqual([])
  })

  it('sorts the returned conflicts by chord and participants by id', () => {
    const conflicts = findKeybindingConflicts([
      action('zz', ActionContextTypes.NORMAL_MODE, 'cmd+b'),
      action('aa', ActionContextTypes.NORMAL_MODE, 'cmd+b'),
      action('mm', ActionContextTypes.NORMAL_MODE, 'cmd+a'),
      action('bb', ActionContextTypes.NORMAL_MODE, 'cmd+a'),
    ])

    expect(conflicts.map(c => c.chord)).toEqual(['cmd+a', 'cmd+b'])
    expect(conflicts[0]!.actions.map(a => a.actionId)).toEqual(['bb', 'mm'])
    expect(conflicts[1]!.actions.map(a => a.actionId)).toEqual(['aa', 'zz'])
  })
})
