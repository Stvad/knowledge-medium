import { describe, expect, it } from 'vitest'
import { actionsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import { srsReschedulingPlugin } from '../index.ts'

describe('srsReschedulingPlugin', () => {
  it('contributes matching shortcuts in normal and edit mode', () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const actions = runtime.read(actionsFacet)

    expect(actions).toHaveLength(10)
    expect(actions.map(action => action.context)).toEqual([
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
    ])

    expect(actions.map(action => action.defaultBinding?.keys)).toEqual([
      ['ctrl+shift+1', 'ctrl+shift+alt+cmd+1'],
      ['ctrl+shift+2', 'ctrl+shift+alt+cmd+2'],
      ['ctrl+shift+3', 'ctrl+shift+alt+cmd+3'],
      ['ctrl+shift+4', 'ctrl+shift+alt+cmd+4'],
      ['ctrl+shift+5', 'ctrl+shift+alt+cmd+5'],
      ['ctrl+shift+1', 'ctrl+shift+alt+cmd+1'],
      ['ctrl+shift+2', 'ctrl+shift+alt+cmd+2'],
      ['ctrl+shift+3', 'ctrl+shift+alt+cmd+3'],
      ['ctrl+shift+4', 'ctrl+shift+alt+cmd+4'],
      ['ctrl+shift+5', 'ctrl+shift+alt+cmd+5'],
    ])
  })
})
