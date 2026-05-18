import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { ActionConfig, ActionContextTypes as ContextTypes, CodeMirrorEditModeDependencies } from '@/shortcuts/types.ts'
import {
  INSERT_BLOCK_REF_TRIGGER_ACTION_ID,
  INSERT_PAGE_REF_TRIGGER_ACTION_ID,
  mobileKeyboardToolbarActions,
} from './actions.ts'

type EditModeAction = ActionConfig<typeof ContextTypes.EDIT_MODE_CM>

const findAction = (id: string): EditModeAction => {
  const action = mobileKeyboardToolbarActions.find(candidate => candidate.id === id)
  if (!action) throw new Error(`Action not found: ${id}`)
  return action
}

const makeView = (doc: string, anchor: number, head = anchor): EditorView => {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create([EditorSelection.range(anchor, head)]),
    }),
    parent,
  })
}

const runAction = async (action: EditModeAction, view: EditorView) => {
  const deps = {editorView: view} as CodeMirrorEditModeDependencies
  const trigger = new CustomEvent('test')
  await action.handler(deps, trigger)
  const selection = view.state.selection.main
  return {
    doc: view.state.doc.toString(),
    from: selection.from,
    to: selection.to,
  }
}

describe('mobile keyboard toolbar completion-trigger actions', () => {
  it('inserts an empty page-ref pair at the cursor and places the caret between brackets', async () => {
    const view = makeView('hello ', 6)
    expect(await runAction(findAction(INSERT_PAGE_REF_TRIGGER_ACTION_ID), view)).toEqual({
      doc: 'hello [[]]',
      from: 8,
      to: 8,
    })
    view.destroy()
  })

  it('surrounds the selected text with double brackets instead of replacing it', async () => {
    const view = makeView('hello world', 6, 11)
    expect(await runAction(findAction(INSERT_PAGE_REF_TRIGGER_ACTION_ID), view)).toEqual({
      doc: 'hello [[world]]',
      from: 8,
      to: 13,
    })
    view.destroy()
  })

  it('inserts an empty block-ref pair at the cursor and places the caret between parens', async () => {
    const view = makeView('hello ', 6)
    expect(await runAction(findAction(INSERT_BLOCK_REF_TRIGGER_ACTION_ID), view)).toEqual({
      doc: 'hello (())',
      from: 8,
      to: 8,
    })
    view.destroy()
  })

  it('surrounds the selected text with double parens for block refs', async () => {
    const view = makeView('hello world', 6, 11)
    expect(await runAction(findAction(INSERT_BLOCK_REF_TRIGGER_ACTION_ID), view)).toEqual({
      doc: 'hello ((world))',
      from: 8,
      to: 13,
    })
    view.destroy()
  })
})
