import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import { aliasesProp, getBlockTypes } from '@/data/properties.ts'
import {
  DATE_SHIFT_BACKWARD_DAY_ACTION_ID,
  DATE_SHIFT_BACKWARD_WEEK_ACTION_ID,
  DATE_SHIFT_FORWARD_DAY_ACTION_ID,
  DATE_SHIFT_FORWARD_WEEK_ACTION_ID,
  addDaysIso,
  getOrCreateDailyNote,
  isValidDateAlias,
} from '@/plugins/daily-notes'
import type { ActionConfig, ActionDecorator, BlockShortcutDependencies } from '@/shortcuts/types.ts'
import {
  SRS_SM25_TYPE,
  srsNextReviewDateProp,
} from './schema.ts'

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

  // Calendar-validity check (not shape-only): bogus stored aliases like
  // `2026-13-01` would otherwise feed `addDaysIso` and roll over to
  // 2027-01-01 instead of refusing to shift. Treat as "no date" so
  // the action falls through to its default handler.
  const aliasIso = decodeAliases(data.properties).find(isValidDateAlias)
  if (aliasIso) return aliasIso

  const content = data.content.trim()
  return isValidDateAlias(content) ? content : null
}

const hasLoadedSrsNextReviewDate = (block: Block): boolean => {
  const data = block.peek()
  return !!data &&
    getBlockTypes(data).includes(SRS_SM25_TYPE) &&
    decodeNextReviewDateId(data.properties) !== null
}

export const shiftSrsNextReviewDate = async (
  block: Block,
  days: number,
): Promise<boolean> => {
  if (block.repo.isReadOnly) return false

  const data = block.peek() ?? await block.load()
  if (!data || !getBlockTypes(data).includes(SRS_SM25_TYPE)) return false

  const currentDailyNoteId = decodeNextReviewDateId(data.properties)
  if (!currentDailyNoteId) return false

  const currentIso = await dailyNoteIsoFromBlockId(block, currentDailyNoteId)
  if (!currentIso) return false

  const nextDailyNote = await getOrCreateDailyNote(
    block.repo,
    data.workspaceId,
    addDaysIso(currentIso, days),
  )

  let shifted = false
  await block.repo.tx(async tx => {
    const row = await tx.get(block.id)
    if (!row || !getBlockTypes(row).includes(SRS_SM25_TYPE)) return
    await tx.update(block.id, {
      properties: {
        ...row.properties,
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(nextDailyNote.id),
      },
    })
    shifted = true
  }, {scope: ChangeScope.BlockDefault, description: 'shift srs next review date'})

  return shifted
}

const decorateDateShiftAction = (
  actionId: string,
  days: number,
): ActionDecorator => ({
  actionId,
  decorate: (action: ActionConfig): ActionConfig => ({
    ...action,
    canRun: (deps) => {
      const block = (deps as BlockShortcutDependencies).block
      if (block && hasLoadedSrsNextReviewDate(block)) return true
      return action.canRun?.(deps as never) ?? true
    },
    handler: async (deps, trigger) => {
      const block = (deps as BlockShortcutDependencies).block
      if (block && await shiftSrsNextReviewDate(block, days)) return
      return action.handler(deps as never, trigger)
    },
  }),
})

export const srsDateShiftDecorators: readonly ActionDecorator[] = [
  decorateDateShiftAction(DATE_SHIFT_FORWARD_DAY_ACTION_ID, 1),
  decorateDateShiftAction(DATE_SHIFT_BACKWARD_DAY_ACTION_ID, -1),
  decorateDateShiftAction(DATE_SHIFT_FORWARD_WEEK_ACTION_ID, 7),
  decorateDateShiftAction(DATE_SHIFT_BACKWARD_WEEK_ACTION_ID, -7),
]
