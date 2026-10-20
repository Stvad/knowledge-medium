/**
 * Notice links; record the intent to archive them. Nothing here talks to the
 * network — the processor's whole job is to turn "a block now contains a
 * public URL" into a durable `pending` record, and `queue.ts` drains those at
 * a polite rate. Splitting it this way is what makes the feature survive a
 * reload mid-submit, and what gives the rate limiter something to defer
 * instead of something to drop.
 *
 * Ordering note: this writes blocks from its own `apply`, which re-enters the
 * processor for the record it just wrote. Two independent guards stop that —
 * records are skipped by type, and the archive service's own hosts are
 * refused by the URL policy — because one guard is a single edit away from
 * being the wrong one.
 */

import { definePostCommitProcessor } from '@/data/api'
import type { ChangedRow, PostCommitProcessor } from '@/data/api'
import type { Repo } from '@/data/repo'
import { archivableUrls } from './hostPolicy.ts'
import { loadPrefs, type WebArchivePrefs } from './prefs.ts'
import { resolveArchiveService } from './serviceRegistry.ts'
import {
  createPendingRecords,
  isArchiveSnapshot,
  recordedUrlsForSource,
  type CreateRecordSpec,
} from './snapshots.ts'
import { extractLinkTargets } from './urls.ts'

/** Cap the URLs one edit can queue. A pasted document dump shouldn't turn
 *  into hundreds of records in a single transaction; the excess is picked up
 *  on the next edit of that block, and the user sees the volume either way. */
export const MAX_URLS_PER_BLOCK = 25

/** Rows this processor should look at: live, content-bearing, and not one of
 *  our own records. */
const isCandidateRow = (row: ChangedRow): boolean => {
  const after = row.after
  if (!after || after.deleted) return false
  if (isArchiveSnapshot(after)) return false
  // Only re-scan when the content actually changed. The field watch fires for
  // any `content` write in the tx, including ones that rewrote the column to
  // the same value.
  if (row.before && row.before.content === after.content) return false
  return Boolean(after.content.trim())
}

export const planForRow = (
  row: ChangedRow,
  prefs: WebArchivePrefs,
  serviceHosts: readonly string[],
): string[] => {
  const after = row.after
  if (!after) return []
  const targets = extractLinkTargets(after.content)
  if (targets.length === 0) return []
  return archivableUrls(targets, {
    denylist: prefs.denylist,
    serviceHosts,
  }).slice(0, MAX_URLS_PER_BLOCK)
}

export const collectPendingSpecs = async (
  repo: Repo,
  workspaceId: string,
  rows: readonly ChangedRow[],
  prefs: WebArchivePrefs,
  serviceHosts: readonly string[],
): Promise<CreateRecordSpec[]> => {
  const specs: CreateRecordSpec[] = []
  for (const row of rows) {
    if (!isCandidateRow(row)) continue
    const urls = planForRow(row, prefs, serviceHosts)
    if (urls.length === 0) continue

    const sourceId = row.id
    const already = await recordedUrlsForSource(repo, workspaceId, sourceId)
    for (const url of urls) {
      if (already.has(url)) continue
      already.add(url)
      specs.push({sourceId, url, serviceId: prefs.serviceId})
    }
  }
  return specs
}

export const webArchiveNoticeProcessor: PostCommitProcessor =
  definePostCommitProcessor({
    name: 'web-archive.notice',
    watches: {kind: 'field', table: 'blocks', fields: ['content']},
    apply: async (event, ctx) => {
      // Read the opt-in before anything else, including before parsing. A
      // disabled plugin must not even look at what the user is writing.
      const prefs = await loadPrefs(ctx.repo, event.workspaceId)
      if (!prefs.enabled) return

      const service = resolveArchiveService(ctx.repo, prefs.serviceId)
      if (!service) return

      const specs = await collectPendingSpecs(
        ctx.repo,
        event.workspaceId,
        event.changedRows,
        prefs,
        service.hosts,
      )
      if (specs.length === 0) return
      await createPendingRecords(ctx.repo, specs)
    },
  })

export const webArchivePostCommitProcessors: readonly PostCommitProcessor[] = [
  webArchiveNoticeProcessor,
]
