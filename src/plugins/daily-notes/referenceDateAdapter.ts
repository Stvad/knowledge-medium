/**
 * BlockDateAdapter implementation for blocks whose "date" is an inline
 * wikilink in their content (`due [[2026-05-15]]` or
 * `meeting [[April 28th, 2026]]`). Mirrors the visibility/write logic
 * of the old date-shift actions but exposes get/set in absolute-ISO
 * form for the calendar sheet and scrub gestures.
 */
import type { EditorView } from '@codemirror/view'
import { blockContentIsOpaque, type Block } from '@/data/block'
import { ChangeScope, type BlockData } from '@/data/api'
import { hasOpaqueContent } from '@/data/properties'
import {
  parseOutermostReferences,
  type ParsedReference,
  renderWikilink,
} from '@/plugins/references/referenceParser.js'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate.js'
import { formatRoamDate } from '@/utils/dailyPage.js'
import type { BlockDateAdapter } from './blockDateAdapter.ts'

export interface DateReferenceMatch {
  ref: ParsedReference
  iso: string
  style: 'iso' | 'long'
}

const isoToLocalDate = (iso: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) throw new Error(`Invalid ISO date: ${iso}`)
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

const dateReferenceMatches = (content: string): DateReferenceMatch[] =>
  parseOutermostReferences(content).flatMap(ref => {
    const parsed = parseLiteralDailyPageTitle(ref.alias)
    if (!parsed) return []
    return [{
      ref,
      iso: parsed.iso,
      style: ref.alias.trim() === parsed.iso ? 'iso' : 'long',
    }]
  })

export const singleDateReferenceMatch = (content: string): DateReferenceMatch | null => {
  const matches = dateReferenceMatches(content)
  return matches.length === 1 ? matches[0] : null
}

export const replaceSingleDateReferenceContent = (
  content: string,
  iso: string,
): string | null => {
  const match = singleDateReferenceMatch(content)
  if (!match) return null
  const nextAlias = match.style === 'iso'
    ? iso
    : formatRoamDate(isoToLocalDate(iso))
  // Unreachable for a date alias (short, delimiter-free), but `null` is
  // already this function's "no rewrite" answer — and beats splicing the
  // string "null" into the user's content.
  const rendered = renderWikilink(nextAlias)
  if (rendered === null) return null
  return content.slice(0, match.ref.startIndex) +
    rendered +
    content.slice(match.ref.endIndex)
}

const REFERENCE_DATE_ADAPTER_ID = 'daily-notes.reference'

/** A date-shaped wikilink inside an extension bundle or a drawing's JSON
 *  is a coincidence, not a schedule. Treating it as one makes the block
 *  reschedulable, and reschedule/spread then splice a new date into the
 *  payload. Checked on BOTH entry points: `canHandle` keeps the block out
 *  of the flows, `setIso` refuses a direct adapter call. */
const isSchedulable = (block: Block, data: BlockData): boolean =>
  !hasOpaqueContent(data, block.repo.opaqueContentTypes)

export const referenceDateAdapter: BlockDateAdapter = {
  id: REFERENCE_DATE_ADAPTER_ID,
  canHandle: (block: Block) => {
    const data = block.peek()
    if (!data || !isSchedulable(block, data)) return false
    return singleDateReferenceMatch(data.content) !== null
  },
  getCurrentIso: async (block: Block) => {
    const data = block.peek() ?? await block.load()
    if (!data || !isSchedulable(block, data)) return null
    return singleDateReferenceMatch(data.content)?.iso ?? null
  },
  setIso: async (block: Block, iso: string) => {
    if (block.repo.isReadOnly) return false
    const data = block.peek() ?? await block.load()
    if (!data || !isSchedulable(block, data)) return false
    // The cached check above keeps the block out of the flows; this one
    // decides the WRITE. Both are needed: reschedule/spread can sit between
    // them for as long as the user takes, and a sync or extension install
    // can turn the block opaque in that window without changing content —
    // which is also why the content is re-derived from the tx's row rather
    // than the snapshot read above.
    let wrote = false
    await block.repo.tx(async tx => {
      const fresh = await tx.get(block.id)
      if (!fresh || fresh.deleted) return
      if (hasOpaqueContent(fresh, tx.opaqueContentTypes)) return
      const nextContent = replaceSingleDateReferenceContent(fresh.content, iso)
      if (nextContent === null || nextContent === fresh.content) return
      await tx.update(block.id, {content: nextContent})
      wrote = true
    }, {scope: ChangeScope.BlockDefault, description: 'reschedule date reference'})
    return wrote
  },
}

export const createEditorReferenceDateAdapter = (editorView: EditorView): BlockDateAdapter => ({
  id: `${REFERENCE_DATE_ADAPTER_ID}.editor`,
  canHandle: () => singleDateReferenceMatch(editorView.state.doc.toString()) !== null,
  getCurrentIso: async () =>
    singleDateReferenceMatch(editorView.state.doc.toString())?.iso ?? null,
  setIso: async (block: Block, iso: string) => {
    if (block.repo.isReadOnly) return false
    // Refuse BEFORE the dispatch: the editor's own debounced commit
    // persists whatever the doc holds, so the `setContent` below is not the
    // only write path and a guard after it would be too late. This variant
    // has no production wiring today; the check is here so wiring it up
    // later cannot reintroduce the hole its sibling already closed.
    if (blockContentIsOpaque(block)) return false
    const sourceContent = editorView.state.doc.toString()
    const nextContent = replaceSingleDateReferenceContent(sourceContent, iso)
    if (nextContent === null || nextContent === sourceContent) return false

    editorView.dispatch({
      changes: {
        from: 0,
        to: editorView.state.doc.length,
        insert: nextContent,
      },
    })
    await block.setContent(nextContent)
    return true
  },
})
