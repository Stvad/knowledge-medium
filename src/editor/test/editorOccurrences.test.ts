// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { trackEditorOccurrence } from '../editorOccurrences'

const views: EditorView[] = []
const mountView = () => {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({parent, doc: 'text'})
  views.push(view)
  return view
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

describe('trackEditorOccurrence', () => {
  it('hands focus to the instance that stays when the focused one is removed', async () => {
    const leaving = mountView()
    const staying = mountView()
    const releaseLeaving = trackEditorOccurrence('block', 'scope', leaving)
    trackEditorOccurrence('block', 'scope', staying)
    leaving.focus()
    releaseLeaving()
    leaving.dom.parentElement!.remove()
    await Promise.resolve()
    expect(document.activeElement).toBe(staying.contentDOM)
  })

  it('takes nothing when the removed instance did not hold focus', async () => {
    const leaving = mountView()
    const staying = mountView()
    const releaseLeaving = trackEditorOccurrence('block', 'scope', leaving)
    trackEditorOccurrence('block', 'scope', staying)
    releaseLeaving()
    leaving.dom.parentElement!.remove()
    await Promise.resolve()
    expect(document.activeElement).not.toBe(staying.contentDOM)
  })

  it('never hands focus to another occurrence of the block', async () => {
    const leaving = mountView()
    const elsewhere = mountView()
    const releaseLeaving = trackEditorOccurrence('block', 'scope', leaving)
    trackEditorOccurrence('block', 'other-scope', elsewhere)
    leaving.focus()
    releaseLeaving()
    leaving.dom.parentElement!.remove()
    await Promise.resolve()
    expect(document.activeElement).not.toBe(elsewhere.contentDOM)
  })

  it('leaves focus that went elsewhere meanwhile', async () => {
    const leaving = mountView()
    const staying = mountView()
    const input = document.createElement('input')
    document.body.append(input)
    const releaseLeaving = trackEditorOccurrence('block', 'scope', leaving)
    trackEditorOccurrence('block', 'scope', staying)
    leaving.focus()
    releaseLeaving()
    input.focus()
    leaving.dom.parentElement!.remove()
    await Promise.resolve()
    expect(document.activeElement).toBe(input)
  })
})
