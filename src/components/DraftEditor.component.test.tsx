// @vitest-environment jsdom
// CodeMirror needs selectionchange delivered after its DOM update; happy-dom
// dispatches it synchronously from Selection.collapse.

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen, waitFor} from '@testing-library/react'
import {currentCompletions, startCompletion} from '@codemirror/autocomplete'
import {EditorView} from '@codemirror/view'
import {useState} from 'react'
import {ChangeScope} from '@/data/api'
import {aliasesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {referencesPlugin} from '@/plugins/references'
import {supertagsPlugin} from '@/plugins/supertags'
import {DraftEditor} from './DraftEditor'

const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

const WS = 'ws'
/** `autocompletion()`'s default `interactionDelay`. */
const COMPLETION_INTERACTION_DELAY_MS = 75

describe('DraftEditor', () => {
  let db: TestDb
  let repo: Repo
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  const values: string[] = []

  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.cleanup() })

  beforeEach(async () => {
    await resetTestDb(db.db)
    // supertags contributes only with a block; its presence pins that the
    // draft's block-less context doesn't break the editor.
    repo = createTestRepo({db: db.db, extensions: [defaultEditorInteractionExtension, referencesPlugin, supertagsPlugin]}).repo
    repo.setActiveWorkspaceId(WS)
    repoRef.current = repo
    await repo.tx(async tx => {
      await tx.create({id: 'launch', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Launch plan',
        properties: {[aliasesProp.name]: aliasesProp.codec.encode(['Launch plan'])}})
    }, {scope: ChangeScope.BlockDefault})
    onSubmit.mockReset()
    onCancel.mockReset()
    values.length = 0
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
  })

  const Harness = () => {
    const [value, setValue] = useState('')
    return (
      <DraftEditor
        label="New comment"
        value={value}
        onChange={next => { values.push(next); setValue(next) }}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    )
  }

  const mount = async (): Promise<EditorView> => {
    render(<AppRuntimeContextProvider value={repo.facetRuntime!}><Harness/></AppRuntimeContextProvider>)
    const view = EditorView.findFromDOM(await screen.findByLabelText('New comment'))!
    act(() => { view.focus() })
    return view
  }

  const type = (view: EditorView, text: string) => act(() => {
    const at = view.state.selection.main.head
    view.dispatch({changes: {from: at, insert: text}, selection: {anchor: at + text.length}, userEvent: 'input.type'})
  })

  const press = (view: EditorView, init: KeyboardEventInit) => act(() => {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init}))
  })

  it('offers the references plugin’s [[ completion, as a block’s editor does', async () => {
    const view = await mount()
    type(view, '[[Laun')
    act(() => { startCompletion(view) })
    await waitFor(() => expect(currentCompletions(view.state).map(c => c.label)).toContain('Launch plan'))
    // CodeMirror ignores Enter on a completion open for less than its
    // `interactionDelay`, so that a fast Enter isn't taken as a pick.
    await new Promise(resolve => setTimeout(resolve, COMPLETION_INTERACTION_DELAY_MS + 25))
    press(view, {key: 'Enter'})
    expect(view.state.doc.toString()).toBe('[[Launch plan]]')
    expect(values.at(-1)).toBe('[[Launch plan]]')
  })

  it('submits on Mod+Enter, and makes a line break on Enter', async () => {
    const view = await mount()
    type(view, 'one')
    press(view, {key: 'Enter'})
    expect(view.state.doc.toString()).toBe('one\n')
    // jsdom reports no platform, so CodeMirror's Mod is Ctrl.
    press(view, {key: 'Enter', ctrlKey: true})
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('closes an open completion on Escape before cancelling', async () => {
    const view = await mount()
    type(view, '[[Laun')
    act(() => { startCompletion(view) })
    await waitFor(() => expect(currentCompletions(view.state)).not.toHaveLength(0))
    press(view, {key: 'Escape'})
    expect(currentCompletions(view.state)).toHaveLength(0)
    expect(onCancel).not.toHaveBeenCalled()
    press(view, {key: 'Escape'})
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('keeps its keys from the outline’s window shortcuts', async () => {
    const view = await mount()
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    try {
      press(view, {key: 'j'})
      press(view, {key: 'Escape'})
    } finally {
      window.removeEventListener('keydown', seen)
    }
    expect(seen).not.toHaveBeenCalled()
  })
})
