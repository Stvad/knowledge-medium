/**
 * BlockDateAdapter implementation for blocks whose "date" is an inline
 * wikilink in their content (`due [[2026-05-15]]` or
 * `meeting [[April 28th, 2026]]`). Mirrors the visibility/write logic
 * of the old date-shift actions but exposes get/set in absolute-ISO
 * form for the calendar sheet and scrub gestures.
 */
import type { EditorView } from '@codemirror/view'
import type { Block } from '@/data/block'
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
  return content.slice(0, match.ref.startIndex) +
    renderWikilink(nextAlias) +
    content.slice(match.ref.endIndex)
}

const REFERENCE_DATE_ADAPTER_ID = 'daily-notes.reference'

export const referenceDateAdapter: BlockDateAdapter = {
  id: REFERENCE_DATE_ADAPTER_ID,
  canHandle: (block: Block) => {
    const data = block.peek()
    if (!data) return false
    return singleDateReferenceMatch(data.content) !== null
  },
  getCurrentIso: async (block: Block) => {
    const data = block.peek() ?? await block.load()
    if (!data) return null
    return singleDateReferenceMatch(data.content)?.iso ?? null
  },
  setIso: async (block: Block, iso: string) => {
    if (block.repo.isReadOnly) return false
    const data = block.peek() ?? await block.load()
    if (!data) return false
    const nextContent = replaceSingleDateReferenceContent(data.content, iso)
    if (nextContent === null || nextContent === data.content) return false
    await block.setContent(nextContent)
    return true
  },
}

export const createEditorReferenceDateAdapter = (editorView: EditorView): BlockDateAdapter => ({
  id: `${REFERENCE_DATE_ADAPTER_ID}.editor`,
  canHandle: () => singleDateReferenceMatch(editorView.state.doc.toString()) !== null,
  getCurrentIso: async () =>
    singleDateReferenceMatch(editorView.state.doc.toString())?.iso ?? null,
  setIso: async (block: Block, iso: string) => {
    if (block.repo.isReadOnly) return false
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
