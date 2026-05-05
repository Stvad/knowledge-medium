import { describe, expect, it, vi } from 'vitest'
import { actionsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.ts'
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

  it('writes block data directly from edit mode', async () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const action = runtime.read(actionsFacet).find(it =>
      it.id === 'edit.cm.srs.reschedule.good',
    ) as ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>
    const setContent = vi.fn()
    const block = {
      peek: () => ({content: 'Review [[May 1st, 2026]]'}),
      load: vi.fn(),
      setContent,
    }
    const editorView = {dispatch: vi.fn()}

    await action.handler({
      block,
      uiStateBlock: block,
      editorView,
    } as never, new KeyboardEvent('keydown'))

    expect(editorView.dispatch).not.toHaveBeenCalled()
    expect(setContent).toHaveBeenCalledTimes(1)
    expect(setContent.mock.calls[0][0]).toContain('[[[[interval]]:')
  })
})
