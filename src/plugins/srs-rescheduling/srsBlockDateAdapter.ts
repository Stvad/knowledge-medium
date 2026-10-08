/**
 * BlockDateAdapter that targets `srsNextReviewDateProp` on SRS blocks.
 * Exposes SRS scheduling in absolute-ISO form so the calendar sheet and
 * scrub gestures can drive SRS rescheduling through the same adapter
 * contract as inline date references.
 */
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import { getAliases, getBlockTypes } from '@/data/properties.js'
import { dailyNoteIso, getOrCreateDailyNote, isValidDateAlias } from '@/plugins/daily-notes'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.js'
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

const dailyNoteIsoFromBlockId = async (
  block: Block,
  dailyNoteId: string,
): Promise<string | null> => {
  const data = await block.repo.load(dailyNoteId)
  if (!data) return null
  let date: Date | undefined
  try {
    date = dailyNoteDateProp.codec.decode(data.properties[dailyNoteDateProp.name])
  } catch { /* unreadable cell — `dailyNoteIso` falls back to the alias */ }
  // The shared read, not a local alias scan. A day whose ISO name another live
  // page already claims YIELDS it, and its title is the long-form label — so
  // neither the alias nor the content fallback finds anything, and a card
  // scheduled for that day reads as unscheduled: the reschedule sheet opens on
  // today, and the scrub gesture silently commits nothing.
  //
  // `dailyNoteIso` keeps the calendar-validity check this had: an alias like
  // `2026-13-01` is "no date" rather than bogus input to `addDaysIso`, which
  // rolls it over to a day a month away without complaining.
  const iso = dailyNoteIso({
    id: data.id,
    workspaceId: data.workspaceId,
    date,
    aliases: getAliases(data),
  })
  if (iso) return iso
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
