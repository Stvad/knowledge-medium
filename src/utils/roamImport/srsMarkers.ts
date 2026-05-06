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
import { stripRoamTodoContent } from './todo'

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

const ROAM_SRS_INLINE_PROPERTY_RE = /\[\[\[\[(interval|factor)\]\]::?[^\]]+\]\]/gi
const ROAM_HASH_PAGE_RE = /(^|[^\w/:])#\[\[[^\]]+\]\]/g
const REVIEW_STAR_RE = /(?:^|\s)\*(?=\s|$)/g

const countReviewStars = (text: string): number => {
  const matches = text.match(REVIEW_STAR_RE)
  return matches?.length ?? 0
}

const hasFiniteRoamInlineNumber = (rawContent: string, name: string): boolean =>
  Number.isFinite(Number.parseFloat(roamInlinePropertyValue(rawContent, name) ?? ''))

export const hasSrsScheduleFields = (rawContent: string): boolean =>
  hasFiniteRoamInlineNumber(rawContent, 'interval') &&
  hasFiniteRoamInlineNumber(rawContent, 'factor')

export const hasSrsScheduleDate = (rawContent: string): boolean =>
  parseRoamImportReferences(rawContent)
    .some(ref => parseLiteralDailyPageTitle(ref.alias) !== null)

export const extractSrsScheduleMarker = (
  rawContent: string,
  workspaceId: string,
): PreparedSrsSchedule | null => {
  const interval = Number.parseFloat(roamInlinePropertyValue(rawContent, 'interval') ?? '')
  const factor = Number.parseFloat(roamInlinePropertyValue(rawContent, 'factor') ?? '')
  if (!Number.isFinite(interval) || !Number.isFinite(factor)) return null

  const reviewCount = countReviewStars(rawContent)

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

const removeParsedDateRefs = (content: string): string => {
  const refs = parseRoamImportReferences(content)
    .filter(ref => parseLiteralDailyPageTitle(ref.alias) !== null)
    .sort((a, b) => b.startIndex - a.startIndex)

  let out = content
  for (const ref of refs) {
    out = out.slice(0, ref.startIndex) + out.slice(ref.endIndex)
  }
  return out
}

const removePageRefs = (content: string): string => {
  const refs = parseRoamImportReferences(content)
    .sort((a, b) => b.startIndex - a.startIndex)

  let out = content
  for (const ref of refs) {
    out = out.slice(0, ref.startIndex) + out.slice(ref.endIndex)
  }
  return out
}

export const srsScheduleMarkerResidue = (rawContent: string): string =>
  removePageRefs(removeParsedDateRefs(stripRoamTodoContent(rawContent))
    .replace(ROAM_SRS_INLINE_PROPERTY_RE, ' ')
    .replace(ROAM_HASH_PAGE_RE, ' ')
    .replace(/(^|[^\w/:])#[\w/-]+/g, ' '))
    .replace(REVIEW_STAR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const isSrsScheduleMarkerOnly = (rawContent: string): boolean =>
  extractSrsScheduleMarker(rawContent, '00000000-0000-4000-8000-000000000000') !== null &&
  srsScheduleMarkerResidue(rawContent).length === 0

export const stripSrsScheduleMetadataFromValue = (rawContent: string): string =>
  rawContent
    .replace(ROAM_SRS_INLINE_PROPERTY_RE, ' ')
    .replace(REVIEW_STAR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export interface PromotedSrsScheduleResult {
  schedule?: PreparedSrsSchedule
  diagnostics: string[]
}

export const findPromotedSrsScheduleInChildren = (
  children: ReadonlyArray<RoamBlock>,
  workspaceId: string,
  parentUid: string,
): PromotedSrsScheduleResult => {
  const markerOnlyChildren: Array<{child: RoamBlock, schedule: PreparedSrsSchedule}> = []
  for (const child of children) {
    const schedule = extractSrsScheduleMarker(child.string ?? '', workspaceId)
    if (schedule && isSrsScheduleMarkerOnly(child.string ?? '')) {
      markerOnlyChildren.push({child, schedule})
    }
  }
  const diagnostics = markerOnlyChildren.length > 1
    ? [
      `Multiple marker-only Roam SRS children under uid ${parentUid}; ` +
      `promoted the first (${markerOnlyChildren[0].child.uid}) and preserved ` +
      `${markerOnlyChildren.length - 1} additional marker block(s) literally.`,
    ]
    : []
  return {schedule: markerOnlyChildren[0]?.schedule, diagnostics}
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
