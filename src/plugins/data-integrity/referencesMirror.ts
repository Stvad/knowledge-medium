import type { AuditDb, ConsistencyCheckResult } from './audit.js'
import { forEachAuditRange } from './auditRanges.js'

const REF_TARGET = `json_extract(je.value, '$.id')`
const REF_ALIAS = `json_extract(je.value, '$.alias')`
const REF_FIELD = `json_extract(je.value, '$.sourceField')`

// Group once by tuple to count missing occurrences and distinct duplicates.
const BLOCK_ISSUES_SQL = `
WITH live_blocks AS MATERIALIZED (
  SELECT id, references_json,
         CASE WHEN references_json = '[]' THEN 1 ELSE json_valid(references_json) END AS valid_refs,
         CASE WHEN properties_json = '{}' THEN 1 ELSE json_valid(properties_json) END AS valid_props
  FROM blocks
  WHERE rowid BETWEEN ? AND ? AND workspace_id = ? AND deleted = 0
    AND (references_json != '[]' OR properties_json != '{}')
), expected AS (
  SELECT b.id AS source_id, ${REF_TARGET} AS target_id, ${REF_ALIAS} AS alias,
         COALESCE(${REF_FIELD}, '') AS source_field, count(*) AS occurrences
  FROM live_blocks b
  CROSS JOIN json_each(CASE WHEN b.valid_refs THEN b.references_json ELSE '[]' END) je
  WHERE b.references_json != '[]'
    AND typeof(target_id) = 'text' AND typeof(alias) = 'text'
    AND (typeof(${REF_FIELD}) = 'text' OR json_type(je.value, '$.sourceField') IS NULL)
  GROUP BY source_id, target_id, alias, source_field
)
SELECT id, NOT valid_refs OR NOT valid_props AS malformedJson,
       CASE WHEN valid_refs AND references_json != '[]' THEN json_type(references_json) != 'array'
            ELSE 0 END AS malformedRefsShape,
       0 AS missingIndexRows, 0 AS duplicateTuples
FROM live_blocks
WHERE malformedJson OR malformedRefsShape
UNION ALL
SELECT e.source_id, 0, 0,
       sum(CASE WHEN br.source_id IS NULL THEN e.occurrences ELSE 0 END) AS missingIndexRows,
       sum(e.occurrences > 1) AS duplicateTuples
FROM expected e
LEFT JOIN block_references br USING (source_id, target_id, alias, source_field)
WHERE br.source_id IS NULL OR e.occurrences > 1
GROUP BY e.source_id
`

// The workspace index orders by alias before rowid. Use the table's rowid
// range so each page visits only the rows in that range.
const INDEX_ISSUES_SQL = `
SELECT br.source_id AS id, b.id IS NULL OR b.deleted = 1 AS orphan
FROM block_references br NOT INDEXED
LEFT JOIN blocks b ON b.id = br.source_id
WHERE br.rowid BETWEEN ? AND ? AND br.workspace_id = ?
  AND (b.id IS NULL OR b.deleted = 1 OR (b.deleted = 0 AND CASE
    WHEN b.references_json = '[]' OR NOT json_valid(b.references_json) THEN 1
    ELSE NOT EXISTS (
      SELECT 1 FROM json_each(b.references_json) je
      WHERE ${REF_TARGET} = br.target_id AND ${REF_ALIAS} = br.alias
        AND COALESCE(${REF_FIELD}, '') = br.source_field
    ) END))
ORDER BY br.rowid
`

interface BlockIssues {
  id: string
  malformedJson: number
  malformedRefsShape: number
  missingIndexRows: number
  duplicateTuples: number
}

/** Missing tuples are scoped by the live source; extra and orphan rows are scoped by the index. */
export const runReferencesMirrorCheck = async (
  db: AuditDb,
  workspaceId: string,
  sampleLimit: number,
): Promise<ConsistencyCheckResult> => {
  const counts = {
    missingIndexRows: 0,
    extraIndexRows: 0,
    orphanSourceRows: 0,
    duplicateTuples: 0,
    malformedJson: 0,
    malformedRefsShape: 0,
  }
  const shapeSamples = new Set<string>()
  const missingSamples = new Set<string>()
  const extraSamples = new Set<string>()
  const orphanSamples = new Set<string>()

  await forEachAuditRange(db, 'blocks', async (first, last) => {
    const rows = await db.getAll<BlockIssues>(BLOCK_ISSUES_SQL, [first, last, workspaceId])
    for (const row of rows) {
      counts.malformedJson += row.malformedJson
      counts.malformedRefsShape += row.malformedRefsShape
      counts.missingIndexRows += row.missingIndexRows
      counts.duplicateTuples += row.duplicateTuples
      if (row.malformedRefsShape && shapeSamples.size < sampleLimit) shapeSamples.add(row.id)
      if (row.missingIndexRows && missingSamples.size < sampleLimit) missingSamples.add(row.id)
    }
  })

  await forEachAuditRange(db, 'block_references', async (first, last) => {
    const rows = await db.getAll<{ id: string; orphan: number }>(INDEX_ISSUES_SQL, [first, last, workspaceId])
    for (const row of rows) {
      if (row.orphan) {
        counts.orphanSourceRows += 1
        if (orphanSamples.size < sampleLimit) orphanSamples.add(row.id)
      } else {
        counts.extraIndexRows += 1
        if (extraSamples.size < sampleLimit) extraSamples.add(row.id)
      }
    }
  })

  const samples = new Set([...shapeSamples, ...missingSamples, ...extraSamples, ...orphanSamples])
  return {
    status: Object.values(counts).some(n => n > 0) ? 'anomaly' : 'ok',
    ...counts,
    samples: [...samples].slice(0, sampleLimit),
  }
}
