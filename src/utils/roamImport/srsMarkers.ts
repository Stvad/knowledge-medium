import { dailyNoteBlockId } from '@/data/dailyNotes'
import {
  srsFactorProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
} from '@/plugins/srs-rescheduling/schema'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate'
import type { RoamBlock } from './types'
import { parseRoamImportReferences } from './references'

export interface PreparedSrsSchedule {
  interval: number
  factor: number
  nextReviewDateAlias: string
  nextReviewDateId: string
  reviewCount: number
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const roamInlinePropertyValue = (text: string, name: string): string | undefined => {
  const pattern = new RegExp(`\\[\\[\\[\\[${escapeRegExp(name)}\\]\\]::?([^\\]]+)\\]\\]`)
  return pattern.exec(text)?.[1]?.trim()
}

const countReviewStars = (text: string): number => {
  const matches = text.match(/(?:^|\s)\*(?=\s|$)/g)
  return matches?.length ?? 0
}

export const extractSrsScheduleMarker = (
  rawContent: string,
  workspaceId: string,
): PreparedSrsSchedule | null => {
  const interval = Number.parseFloat(roamInlinePropertyValue(rawContent, 'interval') ?? '')
  const factor = Number.parseFloat(roamInlinePropertyValue(rawContent, 'factor') ?? '')
  if (!Number.isFinite(interval) || !Number.isFinite(factor)) return null

  const reviewCount = countReviewStars(rawContent)
  if (reviewCount === 0) return null

  const dateRef = parseRoamImportReferences(rawContent)
    .map(ref => ({ref, parsed: parseLiteralDailyPageTitle(ref.alias)}))
    .find(item => item.parsed !== null)
  if (!dateRef?.parsed) return null

  return {
    interval,
    factor,
    nextReviewDateAlias: dateRef.ref.alias,
    nextReviewDateId: dailyNoteBlockId(workspaceId, dateRef.parsed.iso),
    reviewCount,
  }
}

export const findSrsScheduleInChildren = (
  children: ReadonlyArray<RoamBlock>,
  workspaceId: string,
): PreparedSrsSchedule | undefined => {
  for (const child of children) {
    const schedule = extractSrsScheduleMarker(child.string ?? '', workspaceId)
    if (schedule) return schedule
  }
  return undefined
}

export const propertiesFromSrsSchedule = (
  schedule: PreparedSrsSchedule | undefined,
): Record<string, unknown> => {
  if (!schedule) return {}
  return {
    [srsIntervalProp.name]: schedule.interval,
    [srsFactorProp.name]: schedule.factor,
    [srsNextReviewDateProp.name]: schedule.nextReviewDateId,
    [srsReviewCountProp.name]: schedule.reviewCount,
  }
}
