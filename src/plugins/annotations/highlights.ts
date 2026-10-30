/**
 * Edit-mode highlights: each open thread's quote, marked in the block's editor,
 * an edit suggestion's in a style of its own.
 *
 * Resolved against the editor's live doc on every change, not the stored row,
 * which lags the editor by its debounce; the offsets are exact because the
 * quote is raw content. Read mode marks the same ranges in the rendered
 * markdown (`readHighlights.ts`).
 */

import {StateEffect, StateField, type Extension} from '@codemirror/state'
import {Decoration, EditorView, ViewPlugin, type DecorationSet} from '@codemirror/view'
import type {Handle} from '@/data/api'
import type {CodeMirrorExtensionContribution} from '@/editor/codeMirrorExtensions.js'
import {resolveAnchor} from './anchor.ts'
import {drawsHighlight, THREADS_FOR_BLOCK_QUERY, type HighlightThread, type ThreadSummary} from './summaries.ts'

export const HIGHLIGHT_CLASS = 'km-annotation-highlight'
export const MOVED_HIGHLIGHT_CLASS = 'km-annotation-highlight-moved'
export const SUGGESTION_HIGHLIGHT_CLASS = 'km-annotation-highlight-suggestion'

const COMMENT_UTILITIES = 'bg-yellow-400/30 text-inherit border-b-2 border-yellow-600/75 dark:bg-yellow-400/20'
const SUGGESTION_UTILITIES = 'bg-sky-400/25 text-inherit border-b-2 border-sky-600/75 dark:bg-sky-400/20'

export interface HighlightStyle {
  /** The anchor resolved moved, not exact. */
  moved: boolean
  /** An edit suggestion's quote: the text it would replace. */
  suggestion: boolean
}

/** A highlight's look, in the editor and in read mode alike. Utilities rather
 *  than an editor theme: the app's dark variant follows `data-theme`, which
 *  an editor theme's `&dark` never sees. */
export const highlightClasses = ({moved, suggestion}: HighlightStyle): string => [
  HIGHLIGHT_CLASS,
  ...(suggestion ? [SUGGESTION_HIGHLIGHT_CLASS, SUGGESTION_UTILITIES] : [COMMENT_UTILITIES]),
  ...(moved ? [MOVED_HIGHLIGHT_CLASS, 'border-dashed'] : []),
].join(' ')

/** The style of text several highlights cover: exact if any is exact, since
 *  the text there is certainly quoted, and a suggestion's if any is one,
 *  since a suggestion would change it. */
export const coveringStyle = (covering: readonly HighlightStyle[]): HighlightStyle => ({
  moved: covering.every(style => style.moved),
  suggestion: covering.some(style => style.suggestion),
})

export interface HighlightRange extends HighlightStyle {
  from: number
  to: number
}

/** Where `threads` highlight `doc`: exact and moved anchors, stale ones not. */
export const highlightRanges = (doc: string, threads: readonly HighlightThread[]): HighlightRange[] =>
  threads.filter(drawsHighlight).flatMap(thread => {
    if (thread.anchor.kind !== 'range') return []
    const resolved = resolveAnchor(doc, thread.anchor)
    return resolved.state === 'stale'
      ? []
      : [{from: resolved.from, to: resolved.to, moved: resolved.state === 'moved', suggestion: thread.suggestion}]
  })

/** CodeMirror nests overlapping marks itself, so each range keeps its own. */
const markCache = new Map<string, Decoration>()
const markFor = (style: HighlightStyle): Decoration => {
  const className = highlightClasses(style)
  let mark = markCache.get(className)
  if (!mark) markCache.set(className, mark = Decoration.mark({class: className}))
  return mark
}

const decorationsFor = (doc: string, threads: readonly ThreadSummary[]): DecorationSet =>
  Decoration.set(highlightRanges(doc, threads).map(r => markFor(r).range(r.from, r.to)), true)

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
    // Most editors have no threads: skip building the doc string per keystroke.
    if (threads.length === 0) return value.threads.length === 0 ? value : {threads, decorations: Decoration.none}
    return {threads, decorations: decorationsFor(tr.state.doc.toString(), threads)}
  },
  provide: field => EditorView.decorations.from(field, state => state.decorations),
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
  [highlightField, threadsFeed(handle)]

export const threadHighlightsContribution: CodeMirrorExtensionContribution = ({repo, block}) => {
  const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId
  if (!workspaceId) return []
  return threadHighlights(repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId, id: block.id}))
}
