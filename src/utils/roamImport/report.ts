import { ChangeScope } from '@/data/api'
import { dailyNoteBlockId, getOrCreateDailyNote, todayIso } from '@/data/dailyNotes'
import { keyAtEnd, keysBetween } from '@/data/orderKey'
import type { Repo } from '@/data/repo'
import type { RoamMemoImportPlanSummary } from './roamMemo'
import {
  formatTypeCandidateReport,
  type RoamTypeCandidate,
} from './typeCandidates'

interface ImportLogStats {
  pagesCreated: number
  pagesMerged: number
  pagesDaily: number
  blocksWritten: number
  placeholdersCreated: number
  aliasBlocksCreated: number
  typeCandidates: ReadonlyArray<RoamTypeCandidate>
  roamMemo: RoamMemoImportPlanSummary
  durationMs: number
  diagnostics: ReadonlyArray<string>
}

const formatRoamMemoReport = (
  summary: RoamMemoImportPlanSummary,
): string[] => {
  if (summary.entries === 0) return []

  const lines = [
    `${summary.matchedTargets}/${summary.entries} entries matched imported blocks`,
    `${summary.activeTargets} active, ${summary.archivedTargets} archived, ${summary.toReviewRefs} to-review refs preserved as source tags`,
    `${summary.snapshots} snapshots imported across ${summary.matchedTargets} blocks`,
    `${summary.targetsWithHistory} blocks had multi-snapshot review history`,
  ]
  if (summary.missingTargets > 0) {
    lines.push(`${summary.missingTargets} entries referenced missing target blocks`)
  }
  if (summary.unsupportedSessions > 0) {
    lines.push(`${summary.unsupportedSessions} session rows were skipped because they were not SPACED_INTERVAL snapshots`)
  }
  return lines
}

/**
 * Append a one-parent + N-children block to today's daily-note that
 * records the just-finished import. Header summarises counts; each
 * diagnostic becomes a sub-bullet.
 */
export const writeImportLog = async (
  repo: Repo,
  workspaceId: string,
  stats: ImportLogStats,
): Promise<void> => {
  const iso = todayIso()
  // Make sure today's daily-note row exists. Idempotent: if today's
  // import already touched it, this is a cache hit.
  await getOrCreateDailyNote(repo, workspaceId, iso)
  const dailyId = dailyNoteBlockId(workspaceId, iso)
  const typeCandidateLines = formatTypeCandidateReport(stats.typeCandidates)
  const roamMemoLines = formatRoamMemoReport(stats.roamMemo)
  const typeCandidateSummary = stats.typeCandidates.length > 0
    ? `, ${stats.typeCandidates.length} type candidates`
    : ''
  const roamMemoSummary = stats.roamMemo.entries > 0
    ? `, ${stats.roamMemo.snapshots} roam/memo snapshots`
    : ''

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const headerContent =
    `Roam import ${stamp}: ` +
    `${stats.pagesCreated} new pages, ${stats.pagesMerged} merged, ` +
    `${stats.pagesDaily} daily, ${stats.blocksWritten} blocks ` +
    `(${stats.placeholdersCreated} placeholders, ` +
    `${stats.aliasBlocksCreated} alias seats, ` +
    `${stats.diagnostics.length} notes${typeCandidateSummary}${roamMemoSummary}, ` +
    `${(stats.durationMs / 1000).toFixed(1)}s)`

  await repo.tx(async tx => {
    const existing = await tx.childrenOf(dailyId, workspaceId)
    const lastKey = existing.length > 0
      ? existing[existing.length - 1].orderKey
      : null
    const headerOrderKey = keyAtEnd(lastKey)

    const headerId = await tx.create({
      workspaceId,
      parentId: dailyId,
      orderKey: headerOrderKey,
      content: headerContent,
    })

    const childCount =
      stats.diagnostics.length +
      (roamMemoLines.length > 0 ? 1 : 0) +
      (typeCandidateLines.length > 0 ? 1 : 0)
    if (childCount === 0) return
    const childKeys = keysBetween(null, null, childCount)
    let childIndex = 0
    for (let i = 0; i < stats.diagnostics.length; i++) {
      await tx.create({
        workspaceId,
        parentId: headerId,
        orderKey: childKeys[childIndex++],
        content: stats.diagnostics[i],
      })
    }
    if (roamMemoLines.length > 0) {
      const sectionId = await tx.create({
        workspaceId,
        parentId: headerId,
        orderKey: childKeys[childIndex++],
        content: 'Roam Memo SRS',
      })
      const sectionKeys = keysBetween(null, null, roamMemoLines.length)
      for (let i = 0; i < roamMemoLines.length; i++) {
        await tx.create({
          workspaceId,
          parentId: sectionId,
          orderKey: sectionKeys[i],
          content: roamMemoLines[i],
        })
      }
    }
    if (typeCandidateLines.length > 0) {
      const sectionId = await tx.create({
        workspaceId,
        parentId: headerId,
        orderKey: childKeys[childIndex],
        content: 'Type candidates from isa::',
      })
      const sectionKeys = keysBetween(null, null, typeCandidateLines.length)
      for (let i = 0; i < typeCandidateLines.length; i++) {
        await tx.create({
          workspaceId,
          parentId: sectionId,
          orderKey: sectionKeys[i],
          content: typeCandidateLines[i],
        })
      }
    }
  }, {scope: ChangeScope.BlockDefault, description: 'roam import: log'})
}
