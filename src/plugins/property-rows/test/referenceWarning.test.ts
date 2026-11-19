// @vitest-environment happy-dom
import {EditorView} from '@codemirror/view'
import {expect, it, vi} from 'vitest'
import {ChangeScope, codecs, defineProperty} from '@/data/api'
import type {Block} from '@/data/block'
import {propertyReferenceWarning} from '../referenceWarning'

it('updates an editor warning for the current resolved reference without replacing the editor', async () => {
  const schema = defineProperty('owner', {codec: codecs.refList({targetTypes: ['person']}), defaultValue: [], changeScope: ChangeScope.BlockDefault})
  let target = {id: 'wrong', workspaceId: 'ws', deleted: false, properties: {types: ['place']}}
  let listener = () => {}
  const handle = {
    peek: () => target,
    load: async () => target,
    subscribe: (callback: () => void) => { listener = callback; return () => {} },
  }
  const block = {
    peek: () => ({workspaceId: 'ws'}),
    repo: {block: () => handle, types: new Map([['person', {label: 'Person'}], ['place', {label: 'Place'}]])},
  } as unknown as Block
  const view = new EditorView({doc: '((wrong))', parent: document.body, extensions: propertyReferenceWarning({block, repo: block.repo, propertyValueSchema: schema})})
  try {
    await vi.waitFor(() => expect(view.dom.querySelector('[data-reference-type-warning]')?.getAttribute('title')).toBe('Expected Person; has Place'))
    const editor = view.dom
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: 'incomplete'}})
    expect(view.dom.querySelector('[data-reference-type-warning]')).toBeNull()
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: '((wrong))'}})
    await vi.waitFor(() => expect(view.dom.querySelector('[data-reference-type-warning]')).not.toBeNull())
    target = {...target, properties: {types: ['person']}}
    listener()
    await vi.waitFor(() => expect(view.dom.querySelector('[data-reference-type-warning]')).toBeNull())
    expect(view.dom).toBe(editor)
    expect(view.state.doc.toString()).toBe('((wrong))')
  } finally { view.destroy() }
})
