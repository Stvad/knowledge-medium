// @vitest-environment jsdom
/**
 * Reproduce the editor bug: typing a space at the end of `[[i]]` lands the
 * space between the two `]` instead of after them.
 *
 * Root cause is upstream: when Chrome's contenteditable inserts the space
 * inside the last bracket's text node (instead of as a sibling after it),
 * CodeMirror's MutationObserver reads back `[[i] ]` and `findDiff` against
 * `[[i]]` picks the earlier of two equally-valid diff anchors (position 4),
 * even though the caret was at 5. The workaround lives in
 * `referencesCodeMirrorExtensions` — a high-precedence inputHandler that
 * redirects single-cursor inserts back to the caret when the diff anchor
 * landed before it.
 *
 * This test fakes the same `inputHandler(view, from, to, insert)` call the
 * production path makes after `applyDOMChange`/`findDiff`, since
 * synthesised `beforeinput`/`MutationObserver` events don't fire reliably
 * in jsdom.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from '@uiw/codemirror-extensions-basic-setup'
import { createMinimalMarkdownConfig } from '@/utils/codemirror.js'
import { referencesCodeMirrorExtensions } from '../codeMirrorExtensions.ts'

const basicOpts = {
  closeBrackets: true,
  lineNumbers: false,
  foldGutter: false,
  dropCursor: false,
  allowMultipleSelections: false,
  indentOnInput: false,
  highlightSelectionMatches: false,
  searchKeymap: false,
  defaultKeymap: false,
  history: false,
  historyKeymap: false,
  highlightActiveLine: false,
  completionKeymap: false,
} as const

let parent: HTMLElement

beforeAll(() => {
  parent = document.createElement('div')
  document.body.appendChild(parent)
})

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
})

const fakeRepo = {
  activeWorkspaceId: undefined,
  query: {recentBlocks: () => ({load: async () => []})},
  isReadOnly: false,
} as unknown as Parameters<typeof referencesCodeMirrorExtensions>[0]['repo']

const fakeBlock = {} as unknown as Parameters<typeof referencesCodeMirrorExtensions>[0]['block']

const setup = (doc: string, cursor: number) => {
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        basicSetup(basicOpts),
        ...createMinimalMarkdownConfig(),
        referencesCodeMirrorExtensions({repo: fakeRepo, block: fakeBlock}),
      ],
    }),
  })
  return view
}

/** Walk the same `inputHandler` facet `applyDOMChangeInner` walks. The
 *  facet is fed `(view, change.from, change.to, insert)` where `change`
 *  came from `findDiff` over the DOM mutation — i.e. when Chrome puts the
 *  space inside the last bracket's text node, the diff anchor is *before*
 *  the cursor even though the user's caret is past `]]`. We simulate that
 *  by passing `from` explicitly. */
const callInputHandlerChain = (
  view: EditorView,
  from: number,
  to: number,
  insert: string,
) => {
  const handlers = view.state.facet(EditorView.inputHandler)
  // `defaultInsert` is normally provided by CodeMirror; tests don't need it.
  const noopDefault = () => view.state.update({})
  for (const handler of handlers) {
    if (handler(view, from, to, insert, noopDefault)) return true
  }
  return false
}

describe('wikilink space-at-end bug', () => {
  it('caret at end of [[i]] + space-with-misplaced-diff lands the space AFTER ]]', () => {
    const view = setup('[[i]]', 5)
    // findDiff(`[[i]]`, `[[i] ]`) → {from: 4, to: 4, insert: ' '} — the Chrome-misplaced case
    const handled = callInputHandlerChain(view, 4, 4, ' ')
    expect(handled).toBe(true)
    expect(view.state.doc.toString()).toBe('[[i]] ')
    expect(view.state.selection.main.head).toBe(6)
  })

  it('caret at end of [[i]] + correctly-diffed space at position 5 still works', () => {
    const view = setup('[[i]]', 5)
    // The well-behaved DOM-diff case: insertion anchored AT the caret.
    const handled = callInputHandlerChain(view, 5, 5, ' ')
    // Falls through to the default path (returns false); we just check
    // that our handler doesn't override the well-behaved case.
    if (!handled) {
      view.dispatch(view.state.replaceSelection(' '))
    }
    expect(view.state.doc.toString()).toBe('[[i]] ')
    expect(view.state.selection.main.head).toBe(6)
  })

  it('non-empty selection replacement passes through (no override)', () => {
    const view = setup('[[i]]', 0)
    view.dispatch({selection: EditorSelection.range(0, 5)})
    // Selection-replace diff: from=0, to=5, insert='x' — must not be hijacked
    const handled = callInputHandlerChain(view, 0, 5, 'x')
    expect(handled).toBe(false)
  })
})
