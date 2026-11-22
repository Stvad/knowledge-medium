import { PENDING_UPLOAD_IDS_SQL } from '@/data/pendingUploadsSql.js'
import { ENVELOPE_PREFIX } from '@/sync/crypto/envelope.js'
import type { AuditDb } from './audit.js'
import { forEachAuditRange } from './auditRanges.js'

type Category = 'strandedLocalOnly' | 'equalStampStandoff' | 'localRicherNoPending' | 'serverAheadUndrained'

export const measureDivergence = async (
  db: AuditDb, workspaceId: string, dueBefore: number, plaintextWorkspace: boolean, sampleLimit: number,
) => {
  // Compare sealed columns byte-for-byte only when the staging value is
  // plaintext. A confirmed plaintext workspace may contain literal envelope prefixes.
  const compareSealed = plaintextWorkspace ? '' : `bs.content NOT LIKE '${ENVELOPE_PREFIX}%' AND`
  const contentDiffers = `(b.deleted!=bs.deleted OR (${compareSealed}
    (b.content!=bs.content OR b.properties_json!=bs.properties_json OR b.references_json!=bs.references_json)))`
  const counts = { strandedLocalOnly: 0, equalStampStandoff: 0, localRicherNoPending: 0, serverAheadUndrained: 0 }
  const samples: Record<Exclude<Category, 'serverAheadUndrained'>, string[]> = {
    strandedLocalOnly: [], equalStampStandoff: [], localRicherNoPending: [],
  }
  // A dirty pass and its settled recheck each get their own queue snapshot.
  // Reading it per page multiplies an offline backlog by the number of dirty pages.
  let pending: Set<string> | undefined
  await forEachAuditRange(db, 'blocks', async (first, last) => {
    const rows = await db.getAll<{ id: string; category: Category }>(
      `SELECT id, category FROM (
         SELECT b.id, CASE
           WHEN bs.id IS NULL AND b.deleted=0 AND b.updated_at < ? THEN 'strandedLocalOnly'
           WHEN b.updated_at>bs.updated_at AND b.updated_at < ? THEN 'localRicherNoPending'
           WHEN b.updated_at=bs.updated_at AND b.updated_at!=0 AND ${contentDiffers} THEN 'equalStampStandoff'
           WHEN bs.updated_at>b.updated_at AND ${contentDiffers} THEN 'serverAheadUndrained'
         END AS category
         FROM blocks b NOT INDEXED LEFT JOIN blocks_synced bs ON bs.id=b.id
         WHERE b.rowid BETWEEN ? AND ? AND b.workspace_id=?
       ) WHERE category IS NOT NULL`,
      [dueBefore, dueBefore, first, last, workspaceId],
    )
    for (const { id, category } of rows) {
      if (category !== 'equalStampStandoff') {
        pending ??= new Set((await db.getAll<{ id: string }>(PENDING_UPLOAD_IDS_SQL)).map(row => row.id))
        if (pending.has(id)) continue
      }
      counts[category]++
      if (category !== 'serverAheadUndrained' && samples[category].length < sampleLimit) {
        samples[category].push(id)
      }
    }
  })
  return { ...counts, samples: Object.values(samples).flat().slice(0, sampleLimit) }
}
