/**
 * BlockDateAdapter that targets `srsNextReviewDateProp` on SRS blocks.
 * Exposes SRS scheduling in absolute-ISO form so the calendar sheet and
 * scrub gestures can drive SRS rescheduling through the same adapter
 * contract as inline date references.
 */
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import { aliasesProp, getBlockTypes } from '@/data/properties.js'
import { getOrCreateDailyNote, isValidDateAlias } from '@/plugins/daily-notes'
import type { BlockDateAdapter } from '@/plugins/daily-notes/blockDateAdapter.js'
import { SRS_SM25_TYPE, srsNextReviewDateProp } from './schema.ts'

const decodeNextReviewDateId = (properties: Record<string, unknown>): string | null => {
  const stored = properties[srsNextReviewDateProp.name]
  if (stored === undefined) return null
  try {
    const value = srsNextReviewDateProp.codec.decode(stored)
    return value || null
  } catch {
    return null
  }
}

const decodeAliases = (properties: Record<string, unknown>): readonly string[] => {
  const stored = properties[aliasesProp.name]
  if (stored === undefined) return []
  try {
    return aliasesProp.codec.decode(stored)
  } catch {
    return []
  }
}

const dailyNoteIsoFromBlockId = async (
  block: Block,
  dailyNoteId: string,
): Promise<string | null> => {
  const data = await block.repo.load(dailyNoteId)
  if (!data) return null
  // Calendar-validity check (not shape-only): a daily-note row whose
  // only date-shaped alias is e.g. `2026-13-01` would, under shape-only
  // matching, feed bogus input to `addDaysIso` and roll over silently.
  // Treat such rows as "no date" so scheduling refuses to act on them.
  const aliasIso = decodeAliases(data.properties).find(isValidDateAlias)
  if (aliasIso) return aliasIso
  const content = data.content.trim()
  return isValidDateAlias(content) ? content : null
}

export const srsBlockDateAdapter: BlockDateAdapter = {
  id: 'srs-rescheduling.next-review-date',
  canHandle: (block: Block) => {
    const data = block.peek()
    if (!data) return false
    if (!getBlockTypes(data).includes(SRS_SM25_TYPE)) return false
    return decodeNextReviewDateId(data.properties) !== null
  },
  getCurrentIso: async (block: Block) => {
    const data = block.peek() ?? await block.load()
    if (!data || !getBlockTypes(data).includes(SRS_SM25_TYPE)) return null
    const dailyId = decodeNextReviewDateId(data.properties)
    if (!dailyId) return null
    return dailyNoteIsoFromBlockId(block, dailyId)
  },
  setIso: async (block: Block, iso: string) => {
    if (block.repo.isReadOnly) return false
    const data = block.peek() ?? await block.load()
    if (!data || !getBlockTypes(data).includes(SRS_SM25_TYPE)) return false

    // One undo entry for the whole action, daily-note creation included.
    return block.repo.undoGroup(async repo => {
      const targetDaily = await getOrCreateDailyNote(repo, data.workspaceId, iso)

      let written = false
      await repo.tx(async tx => {
        const row = await tx.get(block.id)
        if (!row || !getBlockTypes(row).includes(SRS_SM25_TYPE)) return
        await tx.setProperty(block.id, srsNextReviewDateProp, targetDaily.id)
        written = true
      }, {scope: ChangeScope.BlockDefault, description: 'set srs next review date'})

      return written
    })
  },
}
