/**
 * BlockDateAdapter implementation for blocks whose "date" is an inline
 * wikilink in their content (`due [[2026-05-15]]` or
 * `meeting [[April 28th, 2026]]`). Mirrors the visibility/write logic
 * of the old date-shift actions but exposes get/set in absolute-ISO
 * form for the calendar sheet and scrub gestures.
 */
import { ChangeScope, type AnyPropertySchema, type BlockData, type Tx } from '@/data/api'
import type { Block } from '@/data/block'
import { hasSourceContent, takesTextEdit } from '@/data/blockTypes'
import { resolvePropertyValueFieldSchema } from '@/data/propertyChildren'
import { parseExactReferenceBlockContent } from '@/data/referenceBlock'
import {
  parseOutermostReferences,
  type ParsedReference,
  renderWikilink,
} from '@/plugins/references/referenceParser.js'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate.js'
import type { BlockDateAdapter } from './blockDateAdapter.ts'
import { dailyNoteTitle, getOrCreateDailyNoteInTx } from './dailyNotes.ts'
import { isDayReferenceSchema } from './schema.ts'

export interface DateReferenceMatch {
  ref: ParsedReference
  iso: string
  style: 'iso' | 'long'
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
  const nextAlias = match.style === 'iso' ? iso : dailyNoteTitle(iso)
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

export const writeDayReferenceValue = async (
  block: Block, tx: Tx, row: Pick<BlockData, 'id' | 'workspaceId'>, schema: AnyPropertySchema, iso: string,
) => {
  tx.assertWritableWorkspace(row.workspaceId)
  const id = await getOrCreateDailyNoteInTx(tx, block.repo.snapshotTypeRegistries(), row.workspaceId, iso)
  const [value] = await tx.propertyValueChildContents(schema, id, row.workspaceId)
  await tx.update(row.id, value!)
}

export const referenceDateAdapter: BlockDateAdapter = {
  id: REFERENCE_DATE_ADAPTER_ID,
  canHandle: (block: Block) => {
    const data = block.peek()
    if (!data || hasSourceContent(data)) return false
    return singleDateReferenceMatch(data.content) !== null
  },
  getCurrentIso: async (block: Block) => {
    const data = block.peek() ?? await block.load()
    if (!data) return null
    return singleDateReferenceMatch(data.content)?.iso ?? null
  },
  // Reads the row it writes, in the same tx: a picker stays open while an edit, a
  // delete or a type change syncs in.
  setIso: async (block: Block, iso: string) => {
    if (block.repo.isReadOnly) return false
    let written = false
    await block.repo.tx(async tx => {
      const row = await tx.get(block.id)
      if (!takesTextEdit(row)) return
      const nextContent = replaceSingleDateReferenceContent(row.content, iso)
      if (nextContent === null || nextContent === row.content) return
      if (parseExactReferenceBlockContent(nextContent)?.kind === 'alias') {
        const schema = await resolvePropertyValueFieldSchema(tx, row)
        if (schema && isDayReferenceSchema(schema)) {
          await writeDayReferenceValue(block, tx, row, schema, iso)
          written = true
          return
        }
      }
      await tx.update(block.id, {content: nextContent})
      written = true
    }, {scope: ChangeScope.BlockDefault, description: 'set date reference'})
    return written
  },
}
