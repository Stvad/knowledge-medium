// @vitest-environment happy-dom
/**
 * The edit-mode Ask Agent action must work from the LIVE editor doc,
 * not the persisted block: the DB trails the editor by the
 * BlockEditor's commit debounce, and the pending debounced commit will
 * push the doc text over whatever the action writes — so the mention
 * has to land in the doc itself or it gets stripped right back out
 * before the daemon sees the backlink.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { Block } from '@/data/block'
import { ActionContextTypes, type ActionConfig, type CodeMirrorEditModeDependencies } from '@/shortcuts/types.js'
import { askAgentActions, EDIT_MODE_ASK_AGENT_ACTION_ID } from '../askAgent.ts'

type EditModeAction = ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>

const editModeAsk = askAgentActions.find(a => a.id === EDIT_MODE_ASK_AGENT_ACTION_ID) as EditModeAction

const makeView = (doc: string): EditorView => {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({state: EditorState.create({doc}), parent})
}

/** Fake block whose persisted content deliberately TRAILS the editor
 *  doc (the debounce window), capturing what the action writes. */
const makeFakeBlock = (persistedContent: string) => {
  const updates: Array<{content?: string}> = []
  const row = {id: 'block-1', content: persistedContent, properties: {} as Record<string, unknown>}
  const block = {
    id: 'block-1',
    peek: () => row,
    repo: {
      isReadOnly: false,
      tx: async (fn: (tx: unknown) => Promise<void>) =>
        fn({
          get: async () => row,
          update: async (_id: string, patch: {content?: string}) => { updates.push(patch) },
          // askAgent now writes asked-at via the typed setProperties path; the
          // edit-mode tests only assert on the content write, so this just
          // needs to exist (no-op) so the action doesn't throw.
          setProperties: async () => {},
        }),
    },
  } as unknown as Block
  return {block, updates}
}

const run = async (view: EditorView, block: Block) => {
  const deps = {block, editorView: view} as CodeMirrorEditModeDependencies
  await editModeAsk.handler(deps, new CustomEvent('test'))
}

describe('edit-mode Ask Agent', () => {
  it('writes the live doc text (not the stale persisted content) and puts the mention into the doc', async () => {
    const view = makeView('freshly typed text')
    const {block, updates} = makeFakeBlock('older persisted text')

    await run(view, block)

    expect(updates.map(u => u.content)).toEqual(['freshly typed text [[claude]]'])
    // The doc must carry the mention too — the pending debounced commit
    // pushes the doc text later, and would otherwise strip the backlink.
    expect(view.state.doc.toString()).toBe('freshly typed text [[claude]]')
    view.destroy()
  })

  it('leaves the doc untouched when the mention is already present', async () => {
    const view = makeView('already asked [[claude]]')
    const {block, updates} = makeFakeBlock('already asked [[claude]]')

    await run(view, block)

    expect(view.state.doc.toString()).toBe('already asked [[claude]]')
    expect(updates.map(u => u.content)).toEqual(['already asked [[claude]]'])
    view.destroy()
  })

  it('trims trailing whitespace consistently between doc and write', async () => {
    const view = makeView('trailing space ')
    const {block, updates} = makeFakeBlock('trailing')

    await run(view, block)

    expect(view.state.doc.toString()).toBe('trailing space [[claude]]')
    expect(updates.map(u => u.content)).toEqual(['trailing space [[claude]]'])
    view.destroy()
  })
})
