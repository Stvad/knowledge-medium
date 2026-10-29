/**
 * Edit-mode highlights: each open thread's quote, marked in the block's editor.
 *
 * Resolved against the editor's live doc on every change, not the stored row,
 * which lags the editor by its debounce; the offsets are exact because the
 * quote is raw content. Read mode draws no highlights yet.
 */

import {StateEffect, StateField, type Extension} from '@codemirror/state'
import {Decoration, EditorView, ViewPlugin, type DecorationSet} from '@codemirror/view'
import type {Handle} from '@/data/api'
import type {CodeMirrorExtensionContribution} from '@/editor/codeMirrorExtensions.js'
import {resolveAnchor} from './anchor.ts'
import {drawsHighlight, THREADS_FOR_BLOCK_QUERY, type ThreadSummary} from './summaries.ts'

export const HIGHLIGHT_CLASS = 'km-annotation-highlight'
export const MOVED_HIGHLIGHT_CLASS = 'km-annotation-highlight-moved'

export interface HighlightRange {
  from: number
  to: number
  moved: boolean
}

/** Where `threads` highlight `doc`: exact and moved anchors, stale ones not. */
export const highlightRanges = (doc: string, threads: readonly ThreadSummary[]): HighlightRange[] =>
  threads.filter(drawsHighlight).flatMap(thread => {
    if (thread.anchor.kind !== 'range') return []
    const resolved = resolveAnchor(doc, thread.anchor)
    return resolved.state === 'stale' ? [] : [{from: resolved.from, to: resolved.to, moved: resolved.state === 'moved'}]
  })

const exactMark = Decoration.mark({class: HIGHLIGHT_CLASS})
const movedMark = Decoration.mark({class: `${HIGHLIGHT_CLASS} ${MOVED_HIGHLIGHT_CLASS}`})

const decorationsFor = (doc: string, threads: readonly ThreadSummary[]): DecorationSet =>
  Decoration.set(highlightRanges(doc, threads).map(r => (r.moved ? movedMark : exactMark).range(r.from, r.to)), true)

const setThreads = StateEffect.define<readonly ThreadSummary[]>()

interface HighlightState {
  threads: readonly ThreadSummary[]
  decorations: DecorationSet
}

export const highlightField = StateField.define<HighlightState>({
  create: () => ({threads: [], decorations: Decoration.none}),
  update: (value, tr) => {
    let threads = value.threads
    for (const effect of tr.effects) if (effect.is(setThreads)) threads = effect.value
    if (threads === value.threads && !tr.docChanged) return value
    return {threads, decorations: decorationsFor(tr.state.doc.toString(), threads)}
  },
  provide: field => EditorView.decorations.from(field, state => state.decorations),
})

const highlightTheme = EditorView.baseTheme({
  [`.${HIGHLIGHT_CLASS}`]: {
    backgroundColor: 'rgba(250, 204, 21, 0.3)',
    borderBottom: '2px solid rgba(202, 138, 4, 0.75)',
  },
  [`&dark .${HIGHLIGHT_CLASS}`]: {backgroundColor: 'rgba(250, 204, 21, 0.2)'},
  [`.${MOVED_HIGHLIGHT_CLASS}`]: {borderBottomStyle: 'dashed'},
})

/** Feeds the handle's summaries into the field. A dispatch can't run while
 *  the view is being built, so the first one waits a microtask. */
const threadsFeed = (handle: Handle<ThreadSummary[]>) => ViewPlugin.define(view => {
  let live = true
  const push = (threads: readonly ThreadSummary[]) => {
    if (live) view.dispatch({effects: setThreads.of(threads)})
  }
  const unsubscribe = handle.subscribe(push)
  queueMicrotask(() => { void handle.load().then(push, () => {}) })
  return {destroy: () => { live = false; unsubscribe() }}
})

export const threadHighlights = (handle: Handle<ThreadSummary[]>): Extension[] =>
  [highlightField, highlightTheme, threadsFeed(handle)]

export const threadHighlightsContribution: CodeMirrorExtensionContribution = ({repo, block}) => {
  const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId
  if (!workspaceId) return []
  return threadHighlights(repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId, id: block.id}))
}
