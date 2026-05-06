import { dailyNoteBlockId } from '@/data/dailyNotes'
import {
  type SrsReviewSnapshot,
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '@/plugins/srs-rescheduling/schema'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate'
import type { RoamBlock, RoamExport } from './types'
import type { PreparedSrsSchedule } from './srsMarkers'
import { detectInlineAttribute } from './promotion'
import { parseRoamImportReferences } from './references'

export interface PreparedRoamMemoSnapshot extends SrsReviewSnapshot {
  reviewedAtAlias: string
  reviewedAtIso: string
  nextReviewDateAlias: string
  nextReviewDateId: string
}

export interface PreparedRoamMemoEntry {
  targetRoamUid: string
  sourceRoamUid: string
  archived: boolean
  toReview: boolean
  snapshots: PreparedRoamMemoSnapshot[]
}

export interface RoamMemoImportPlanSummary {
  entries: number
  matchedTargets: number
  activeTargets: number
  archivedTargets: number
  toReviewRefs: number
  snapshots: number
  targetsWithHistory: number
  missingTargets: number
  unsupportedSessions: number
}

export interface RoamMemoCollection {
  byTargetUid: Map<string, PreparedRoamMemoEntry>
  summary: RoamMemoImportPlanSummary
}

const blockRefUidFromContent = (content: string | undefined): string | undefined => {
  const match = /^\s*\(\(([^)]+)\)\)\s*$/.exec(content ?? '')
  return match?.[1]?.trim()
}

const pageRefAliasFromContent = (content: string | undefined): string | undefined => {
  const match = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(content ?? '')
  return match?.[1]?.trim()
}

const numberFromMemoField = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

const firstDailyAliasInValue = (
  value: string | undefined,
): {alias: string, iso: string} | undefined => {
  if (!value) return undefined
  for (const ref of parseRoamImportReferences(value)) {
    const parsed = parseLiteralDailyPageTitle(ref.alias)
    if (parsed) return {alias: ref.alias, iso: parsed.iso}
  }
  return undefined
}

const parseRoamMemoSession = (
  block: RoamBlock,
  workspaceId: string,
): PreparedRoamMemoSnapshot | null => {
  const headingMatch = /^\s*\[\[([^\]]+)\]\]/.exec(block.string ?? '')
  const reviewedAtAlias = headingMatch?.[1]?.trim()
  if (!reviewedAtAlias) return null
  const reviewedAt = parseLiteralDailyPageTitle(reviewedAtAlias)
  if (!reviewedAt) return null

  const fields = new Map<string, string>()
  for (const child of block.children ?? []) {
    const attr = detectInlineAttribute(child.string)
    if (attr) fields.set(attr.key, attr.value.trim())
  }

  const reviewMode = fields.get('reviewMode')
  if (reviewMode && reviewMode !== 'SPACED_INTERVAL') return null

  const grade = numberFromMemoField(fields.get('grade'))
  const interval = numberFromMemoField(fields.get('interval'))
  const factor = numberFromMemoField(fields.get('eFactor'))
  const reviewCount = numberFromMemoField(fields.get('repetitions'))
  const nextReviewDate = firstDailyAliasInValue(fields.get('nextDueDate'))
  if (
    grade === undefined ||
    interval === undefined ||
    factor === undefined ||
    reviewCount === undefined ||
    !nextReviewDate
  ) {
    return null
  }

  return {
    reviewedAt: dailyNoteBlockId(workspaceId, reviewedAt.iso),
    reviewedAtAlias,
    reviewedAtIso: reviewedAt.iso,
    grade,
    interval,
    factor,
    reviewCount,
    nextReviewDateAlias: nextReviewDate.alias,
    nextReviewDateId: dailyNoteBlockId(workspaceId, nextReviewDate.iso),
  }
}

const storedSnapshot = (snapshot: PreparedRoamMemoSnapshot): SrsReviewSnapshot => ({
  reviewedAt: snapshot.reviewedAt,
  grade: snapshot.grade,
  interval: snapshot.interval,
  factor: snapshot.factor,
  reviewCount: snapshot.reviewCount,
})

export const propertiesFromRoamMemo = (
  entry: PreparedRoamMemoEntry | undefined,
): Record<string, unknown> => {
  if (!entry) return {}
  const latest = entry.snapshots.at(-1)
  const out: Record<string, unknown> = {}

  if (latest) {
    out[srsIntervalProp.name] = latest.interval
    out[srsFactorProp.name] = latest.factor
    out[srsNextReviewDateProp.name] = latest.nextReviewDateId
    out[srsReviewCountProp.name] = latest.reviewCount
    out[srsGradeProp.name] = latest.grade
    out[srsSnapshotHistoryProp.name] = srsSnapshotHistoryProp.codec.encode(
      entry.snapshots.map(storedSnapshot),
    )
  }

  if (entry.archived) out[srsArchivedProp.name] = true
  return out
}

const emptyRoamMemoSummary = (): RoamMemoImportPlanSummary => ({
  entries: 0,
  matchedTargets: 0,
  activeTargets: 0,
  archivedTargets: 0,
  toReviewRefs: 0,
  snapshots: 0,
  targetsWithHistory: 0,
  missingTargets: 0,
  unsupportedSessions: 0,
})

export const collectRoamMemoEntries = (
  pages: RoamExport,
  knownUids: ReadonlySet<string>,
  workspaceId: string,
): RoamMemoCollection => {
  const byTargetUid = new Map<string, PreparedRoamMemoEntry>()
  const summary = emptyRoamMemoSummary()

  const memoPage = pages.find(page => page.title === 'roam/memo')
  const dataBlock = memoPage?.children?.find(child => child.string === 'data')
  if (!dataBlock?.children) return {byTargetUid, summary}

  for (const entryBlock of dataBlock.children) {
    summary.entries += 1
    const targetRoamUid = blockRefUidFromContent(entryBlock.string)
    const children = entryBlock.children ?? []
    const archived = children.some(child => pageRefAliasFromContent(child.string) === 'memo/archived')
    const toReview = children.some(child => pageRefAliasFromContent(child.string) === 'memo/to-review')
    if (toReview) summary.toReviewRefs += 1

    const snapshots: PreparedRoamMemoSnapshot[] = []
    for (const child of children) {
      if (!/^\s*\[\[/.test(child.string ?? '') || !child.children?.length) continue
      const session = parseRoamMemoSession(child, workspaceId)
      if (session) snapshots.push(session)
      else summary.unsupportedSessions += 1
    }

    if (!targetRoamUid || !knownUids.has(targetRoamUid)) {
      summary.missingTargets += 1
      continue
    }

    snapshots.sort((a, b) => a.reviewedAtIso.localeCompare(b.reviewedAtIso))

    const existing = byTargetUid.get(targetRoamUid)
    const mergedSnapshots = existing
      ? [...existing.snapshots, ...snapshots]
      : snapshots
    mergedSnapshots.sort((a, b) => a.reviewedAtIso.localeCompare(b.reviewedAtIso))
    byTargetUid.set(targetRoamUid, {
      targetRoamUid,
      sourceRoamUid: entryBlock.uid,
      archived: (existing?.archived ?? false) || archived,
      toReview: (existing?.toReview ?? false) || toReview,
      snapshots: mergedSnapshots,
    })
  }

  for (const entry of byTargetUid.values()) {
    summary.matchedTargets += 1
    summary.snapshots += entry.snapshots.length
    if (entry.snapshots.length > 0 && !entry.archived) summary.activeTargets += 1
    if (entry.archived) summary.archivedTargets += 1
    if (entry.snapshots.length > 1) summary.targetsWithHistory += 1
  }

  return {byTargetUid, summary}
}

export const srsSourceConflictDiagnostics = (
  roamUid: string,
  schedule: PreparedSrsSchedule | undefined,
  memo: PreparedRoamMemoEntry | undefined,
): string[] => {
  if (!schedule || !memo) return []
  const latest = memo.snapshots.at(-1)
  if (!latest) return []
  const conflicts: string[] = []
  const check = (name: string, scheduleValue: unknown, memoValue: unknown) => {
    if (scheduleValue !== memoValue) {
      conflicts.push(`${name} marker=${String(scheduleValue)} memo=${String(memoValue)}`)
    }
  }
  check(srsIntervalProp.name, schedule.interval, latest.interval)
  check(srsFactorProp.name, schedule.factor, latest.factor)
  check(srsNextReviewDateProp.name, schedule.nextReviewDateId, latest.nextReviewDateId)
  check(srsReviewCountProp.name, schedule.reviewCount, latest.reviewCount)
  return conflicts.length === 0
    ? []
    : [`roam/memo SRS conflict on uid ${roamUid}: ${conflicts.join(', ')}`]
}
