// @vitest-environment happy-dom
/**
 * The `::` field-creation keydown guard from CodeMirrorContentRenderer. The
 * effect (convertEmptyChildBlockToProperty) is tested in propertyCreation.test;
 * this pins WHEN the shortcut fires — only the SECOND colon of a `::` typed
 * into an otherwise-empty child block, never an ordinary `::` in prose, a
 * chord, a read-only repo, or a root/parentless block. The guard returns true
 * (handled) only when it fires, so a fall-through leaves CodeMirror to insert
 * the character.
 *
 * The first `:` is an ordinary insert and is already in the document when the
 * gesture fires, so this also pins what happens to it: cleared + flushed on the
 * accepting path (so the editor's debounce can't commit it onto the block the
 * conversion deletes), and left untouched when the conversion refuses.
 */

import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/propertyCreation.js', () => ({
  canConvertEmptyChildBlockToProperty: vi.fn(async () => ({parentId: 'parent-1'})),
  convertEmptyChildBlockToProperty: vi.fn(async () => true),
}))

import {
  canConvertEmptyChildBlockToProperty,
  convertEmptyChildBlockToProperty,
} from '@/utils/propertyCreation.js'
import { editorContentFlushFacet } from '@/editor/contentFlush.js'
import { handleFieldCreationKeydown } from '../fieldCreationKeydown.ts'
import type { Repo } from '@/data/repo'
import type { BlockRendererProps } from '@/types'

const canConvertMock = vi.mocked(canConvertEmptyChildBlockToProperty)
const convertMock = vi.mocked(convertEmptyChildBlockToProperty)

interface Opts {
  /** Live doc at keydown time. `':'` (the default) is the state the second
   *  colon of a `::` arrives in. */
  doc?: string
  /** Caret offset; defaults to the end of `doc`. */
  cursor?: number
  selectionTo?: number
  readOnly?: boolean
  parentId?: string | null
  /** Simulate another handler having already claimed the keystroke. */
  preventDefaulted?: boolean
}

interface Harness {
  fire: (eventInit?: KeyboardEventInit) => boolean
  /** Type into the live doc at the caret, as the user would mid-gesture. */
  type: (text: string) => void
  doc: () => string
  caret: () => number
  dispatched: () => number
  flushed: () => number
}

/** A view stand-in with a real EditorState (so the facet lookup in
 *  `flushEditorContent` is the real one) and a dispatch that applies changes.
 *  Built separately from `.fire()` so a test can drive the doc from inside the
 *  eligibility query's await, the way a fast typist does. */
const mount = (opts: Opts = {}): Harness => {
  const doc = opts.doc ?? ':'
  const flush = vi.fn()
  let state = EditorState.create({
    doc,
    extensions: [editorContentFlushFacet.of(flush)],
    selection: {
      anchor: opts.cursor ?? doc.length,
      head: opts.selectionTo ?? opts.cursor ?? doc.length,
    },
  })
  const dispatch = vi.fn((spec: Parameters<EditorState['update']>[0]) => {
    state = state.update(spec).state
  })
  const block = {
    id: 'b1',
    peek: () => ({parentId: opts.parentId === undefined ? 'parent-1' : opts.parentId}),
  } as unknown as BlockRendererProps['block']
  const repo = {isReadOnly: opts.readOnly ?? false} as unknown as Repo
  const view = {get state() { return state }, dispatch} as unknown as EditorView

  return {
    fire: (eventInit: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {key: ':', cancelable: true, ...eventInit})
      if (opts.preventDefaulted) event.preventDefault()
      return handleFieldCreationKeydown(event, view, block, repo)
    },
    // Bypasses `dispatch` so it doesn't pollute the dispatch-count assertions.
    type: text => {
      const at = state.selection.main.from
      state = state.update({changes: {from: at, insert: text}, selection: {anchor: at + text.length}}).state
    },
    doc: () => state.doc.toString(),
    caret: () => state.selection.main.from,
    dispatched: () => dispatch.mock.calls.length,
    flushed: () => flush.mock.calls.length,
  }
}

const fire = (opts: Opts = {}, eventInit: KeyboardEventInit = {}) => {
  const h = mount(opts)
  return {...h, handled: h.fire(eventInit)}
}

/** Drain the handler's async tail. A macrotask boundary flushes the WHOLE
 *  microtask queue, so this holds however many awaits the tail grows — unlike a
 *  fixed number of `Promise.resolve()` hops, which silently accumulates slack
 *  and stops fencing the negative assertions below. The tail awaits only mocked
 *  promises here, so there is nothing slower to wait on. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => {
  canConvertMock.mockClear()
  convertMock.mockClear()
  canConvertMock.mockResolvedValue({parentId: 'parent-1'} as never)
  convertMock.mockResolvedValue(true)
})

describe('handleFieldCreationKeydown', () => {
  it('converts an empty child block to a property field on the second colon of "::"', async () => {
    const h = fire()
    expect(h.handled).toBe(true)
    await settle()
    expect(convertMock).toHaveBeenCalledTimes(1)
    expect(convertMock).toHaveBeenCalledWith(
      expect.objectContaining({id: 'b1'}),
      expect.anything(),
    )
  })

  it('clears the leading ":" and flushes it before the conversion runs', async () => {
    // The leftover first colon must not reach the block: the editor's 300ms
    // debounce would otherwise commit ':' onto the row the conversion deletes.
    convertMock.mockImplementation(async () => {
      expect(h.doc()).toBe('')
      expect(h.flushed()).toBe(1)
      return true
    })
    const h = fire()
    await settle()
    expect(convertMock).toHaveBeenCalledTimes(1)
    expect(h.doc()).toBe('')
    expect(h.flushed()).toBe(1)
  })

  it('restores the suppressed colon when the conversion is refused', async () => {
    // Refuse BEFORE clearing: the editor's debounced commit persists a dispatch
    // on its own, so a late refusal could not take it back. The block is left
    // holding the whole `::` the user typed, not half of it.
    canConvertMock.mockResolvedValue(null as never)
    const h = fire()
    expect(h.handled).toBe(true)
    await settle()
    expect(convertMock).not.toHaveBeenCalled()
    expect(h.flushed()).toBe(0)
    expect(h.doc()).toBe('::')
    expect(h.caret()).toBe(2)
  })

  it('hands the marker back when the conversion itself refuses after the clear', async () => {
    // The conversion re-checks against its own row and can refuse after the
    // doc was already cleared on the earlier answer. Without a restore the
    // block would silently keep '' and no field would exist.
    convertMock.mockResolvedValue(false)
    const h = fire()
    await settle()
    expect(convertMock).toHaveBeenCalledTimes(1)
    expect(h.doc()).toBe('::')
    expect(h.caret()).toBe(2)
  })

  it('leaves the block alone when the user types into it after the clear', async () => {
    const h = mount()
    convertMock.mockImplementation(async () => {
      h.type('hi')
      return false
    })
    expect(h.fire()).toBe(true)
    await settle()
    expect(h.doc()).toBe('hi')
  })

  it.each([true, false])(
    'abandons the gesture when the user types on mid-query (eligible=%s)',
    async eligible => {
      // The eligibility query awaits; a fast typist gets characters in before
      // it resolves. Neither branch may act on the keydown's stale snapshot —
      // clearing would wipe the new text, restoring would splice a colon into
      // the middle of it, and converting would delete a block that now has
      // content the debounce has not persisted yet.
      const h = mount()
      canConvertMock.mockImplementation(async () => {
        h.type('abc')
        return (eligible ? {parentId: 'parent-1'} : null) as never
      })

      expect(h.fire()).toBe(true)
      await settle()

      expect(canConvertMock).toHaveBeenCalledTimes(1)
      expect(convertMock).not.toHaveBeenCalled()
      expect(h.dispatched()).toBe(0)
      expect(h.flushed()).toBe(0)
      expect(h.doc()).toBe(':abc')
    },
  )

  it('falls through on the FIRST colon (empty doc), so it inserts normally', () => {
    expect(fire({doc: ''}).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })

  it.each(['x', 'note:', '>'])('falls through on a ":" typed after %p', doc => {
    // 'x' is the load-bearing case: one character, caret at 1 — the same OFFSET
    // the gesture fires at, so only the doc-content clause can refuse it.
    expect(fire({doc}).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })

  it('falls through when the caret is not after the ":"', () => {
    expect(fire({doc: ':', cursor: 0}).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })

  it('falls through on a non-empty selection', () => {
    expect(fire({doc: ':', cursor: 0, selectionTo: 1}).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })

  it('falls through on a read-only repo', () => {
    expect(fire({readOnly: true}).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })

  it('falls through on a root block (no parent to attach the field to)', () => {
    expect(fire({parentId: null}).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })

  it('falls through on an already-handled event', () => {
    expect(fire({preventDefaulted: true}).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })

  it.each([
    ['meta', {metaKey: true}],
    ['ctrl', {ctrlKey: true}],
    ['alt', {altKey: true}],
  ])('falls through on a %s chord so the shortcut layer can own it', (_name, init) => {
    expect(fire({}, init).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })

  it('no longer fires on the legacy ">" trigger', () => {
    expect(fire({doc: ''}, {key: '>'}).handled).toBe(false)
    expect(fire({}, {key: '>'}).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })

  it('falls through on any other key', () => {
    expect(fire({}, {key: 'a'}).handled).toBe(false)
    expect(canConvertMock).not.toHaveBeenCalled()
  })
})
