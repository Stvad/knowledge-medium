// @vitest-environment jsdom
// CodeMirror needs selectionchange delivered after its DOM update; happy-dom
// dispatches it synchronously from Selection.collapse.

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen, waitFor} from '@testing-library/react'
import {currentCompletions, startCompletion} from '@codemirror/autocomplete'
import {isolateHistory} from '@codemirror/commands'
import {EditorView} from '@codemirror/view'
import {useState} from 'react'
import {ChangeScope} from '@/data/api'
import {aliasesProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {referencesPlugin} from '@/plugins/references'
import {supertagsPlugin} from '@/plugins/supertags'
import {geoPlugin} from '@/plugins/geo'
import {PLACE_TYPE} from '@/plugins/geo/blockTypes'
import {PAGE_TYPE} from '@/data/blockTypes'
import {captureMediaVerb} from '@/paste/captureMediaVerb'
import {pasteDecisionVerb} from '@/paste/decision'
import {DraftEditor} from './DraftEditor'

const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

const WS = 'ws'
const ASSET = '66666666-6666-4666-8666-666666666666'

/** The attachments plugin's two paste contributions, with the capture stubbed:
 *  a paste with files is media, and capturing it yields one reference. */
const captured = vi.fn()
const mediaPaste = [
  pasteDecisionVerb.decorator(next => request => request.files?.length ? {kind: 'media'} : next(request), {source: 'test'}),
  captureMediaVerb.impl(async ({files}) => { captured(files); return {references: [`((${ASSET}))`]} }, {source: 'test'}),
]
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
    repo = createTestRepo({db: db.db, extensions: [defaultEditorInteractionExtension, referencesPlugin, supertagsPlugin, geoPlugin, ...mediaPaste]}).repo
    repo.setActiveWorkspaceId(WS)
    repoRef.current = repo
    await repo.tx(async tx => {
      await tx.create({id: 'launch', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Launch plan',
        properties: {[aliasesProp.name]: aliasesProp.codec.encode(['Launch plan'])}})
      await tx.create({id: 'cafe', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Corner Cafe',
        properties: {[typesProp.name]: [PAGE_TYPE, PLACE_TYPE], [aliasesProp.name]: aliasesProp.codec.encode(['Corner Cafe'])}})
    }, {scope: ChangeScope.BlockDefault})
    captured.mockReset()
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

  it('offers places on @@', async () => {
    const view = await mount()
    type(view, '@@Corn')
    act(() => { startCompletion(view) })
    await waitFor(() => expect(currentCompletions(view.state).map(c => c.label)).toContain('Corner Cafe'))
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

  it('undoes and redoes its own edits, which no block’s undo covers yet', async () => {
    const view = await mount()
    type(view, 'kept')
    // Its own undo step, as a later gesture would be: history joins adjacent
    // edits made within half a second.
    act(() => { view.dispatch({changes: {from: 0, to: view.state.doc.length}, userEvent: 'delete', annotations: isolateHistory.of('before')}) })
    press(view, {key: 'z', ctrlKey: true})
    expect(view.state.doc.toString()).toBe('kept')
    expect(values.at(-1)).toBe('kept')
    press(view, {key: 'z', ctrlKey: true, shiftKey: true})
    expect(view.state.doc.toString()).toBe('')
  })

  it('pastes an image as its captured attachment\u2019s reference, at the caret', async () => {
    const view = await mount()
    type(view, 'see ')
    const image = new File([new Uint8Array([1, 2, 3])], 'cat.png', {type: 'image/png'})
    const paste = new Event('paste', {bubbles: true, cancelable: true})
    Object.defineProperty(paste, 'clipboardData', {value: {getData: () => '', files: [image]}})
    act(() => { view.contentDOM.dispatchEvent(paste) })
    expect(paste.defaultPrevented).toBe(true)
    await waitFor(() => expect(view.state.doc.toString()).toBe(`see ((${ASSET}))`))
    expect(captured).toHaveBeenCalledWith([image])
    expect(values.at(-1)).toBe(`see ((${ASSET}))`)
  })

  /** A DraftEditor whose value and readOnly the test sets from outside. */
  const mountControlled = async (props: {value: string; readOnly?: boolean}) => {
    const element = (next: {value: string; readOnly?: boolean}) => (
      <AppRuntimeContextProvider value={repo.facetRuntime!}>
        <DraftEditor label="New comment" onChange={next => values.push(next)} onSubmit={onSubmit} onCancel={onCancel} {...next}/>
      </AppRuntimeContextProvider>
    )
    const {rerender} = render(element(props))
    const view = EditorView.findFromDOM(await screen.findByLabelText('New comment'))!
    return {view, rerender: (next: {value: string; readOnly?: boolean}) => rerender(element(next))}
  }

  it('takes no change while read-only, such as a paste landing during a submit', async () => {
    const {view} = await mountControlled({value: 'draft', readOnly: true})
    act(() => { view.dispatch({changes: {from: 5, insert: ' late'}}) })
    expect(view.state.doc.toString()).toBe('draft')
    expect(values).toEqual([])
  })

  it('does not make a value set from outside, such as a re-aim\u2019s prefill, an undo step', async () => {
    const {view, rerender} = await mountControlled({value: 'old quote'})
    rerender({value: 'new quote'})
    expect(view.state.doc.toString()).toBe('new quote')
    act(() => { view.focus() })
    press(view, {key: 'z', ctrlKey: true})
    expect(view.state.doc.toString()).toBe('new quote')
    expect(values).toEqual([])
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
