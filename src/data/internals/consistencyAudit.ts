// Built-in client-side consistency audit (L3 of the data-integrity defense —
// docs/data-integrity-defense.html). The cadenced, always-on complement to the
// on-demand bridge eval (scripts/data-integrity/consistency-check.eval.js): a
// lean, count-only subset of the same invariants that the Repo runs on idle and
// surfaces as a metric, so the catastrophic strip/divergence classes are caught
// on a cadence instead of only when a human remembers to run the eval.
//
// All checks are READ-ONLY counts over the client SQLite (it runs on the
// decrypted client, so unlike the server probe it covers the e2ee workspace).
// Each check is isolated: a missing table or malformed row degrades that one
// check to `error`, never crashing the audit or reading as clean. The deep
// per-ref/sample/precise-projection diffs stay in the eval — this is the smoke
// alarm, not the full inspection.

/** Minimal DB surface the audit needs (a subset of the Repo's PowerSyncDb). */
export interface AuditDb {
  getAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface ConsistencyCheckResult {
  status: 'ok' | 'anomaly' | 'error'
  [key: string]: unknown
}

export interface ConsistencyAuditResult {
  workspaceId: string
  /** epoch ms; passed in by the caller so the module stays pure/testable. */
  checkedAt: number
  /** number of checks whose status is 'anomaly'. */
  anomalies: number
  checks: Record<string, ConsistencyCheckResult>
}

// Curated high-value ref props checked at rest (the proven 06-09 next-review-date
// detector). Kept tiny and stable — the eval does the schema-independent
// enumeration; the built-in audit only needs the known-catastrophic one.
const CURATED_REF_PROPS = ['next-review-date']

// The at-rest property-ref check is a HEURISTIC with an irreducible benign
// baseline: an empty / cleared / suspended next-review-date value correctly
// projects no ref, so a handful of value-present/ref-absent rows is normal, not a
// strip. Only a CATASTROPHIC count (a mass strip like 06-09's ~10k) is an
// anomaly — so it doesn't peg the always-on health indicator permanently red.
// Matches the L5 server at-rest threshold; the exact per-row diff is the
// on-demand eval's job (precise R4). Below the floor the count is still reported.
export const AT_REST_ANOMALY_FLOOR = 100

// Up to this many offending block ids are captured per check as a lead for the
// in-app results view. The FULL per-block list stays the bridge eval's job; this
// is an illustrative sample, queried only when a count is already non-zero (so
// the common clean path runs no extra queries).
export const SAMPLE_LIMIT = 8

const count = async (db: AuditDb, sql: string, params: unknown[]): Promise<number> => {
  const rows = await db.getAll<{ n: number }>(sql, params)
  return Number(rows[0]?.n ?? 0)
}

const sampleIds = async (db: AuditDb, sql: string, params: unknown[]): Promise<string[]> => {
  const rows = await db.getAll<{ id: string }>(sql, params)
  return rows.map((r) => String(r.id))
}

/** Merge sample ids into an accumulator, deduped and capped at SAMPLE_LIMIT. */
const addSamples = (acc: string[], more: string[]): void => {
  for (const id of more) {
    if (acc.length >= SAMPLE_LIMIT) return
    if (!acc.includes(id)) acc.push(id)
  }
}

// json_each throws on invalid JSON; feed it a guarded value so one bad row can't
// abort the mirror check (the bad row is counted separately as malformedJson).
const REFS_JSON = `CASE WHEN json_valid(b.references_json) THEN b.references_json ELSE '[]' END`
const EXPANDED_REF_FILTER = `
      typeof(json_extract(je.value,'$.id'))='text'
  AND typeof(json_extract(je.value,'$.alias'))='text'
  AND (json_type(je.value,'$.sourceField') IS NULL
       OR typeof(json_extract(je.value,'$.sourceField'))='text')`

export interface AuditOptions {
  /** When set (with `sleep`), the divergence check that finds anomalies on its
   *  first pass re-measures after this delay and reports the SETTLED counts —
   *  debouncing transient mid-sync divergence (an own write uploaded but its
   *  server echo not yet streamed back; a mid-resync window). The point-in-time
   *  snapshot can't otherwise tell a transient from a persistent divergence
   *  (SLO §5). Omit to disable (the default — pure, instant, used in tests). */
  divergenceRecheckMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Run the built-in consistency audit for one workspace. Pure (modulo the
 *  optional divergence-recheck sleep): caller supplies `now` (epoch ms). Never
 *  throws — per-check failures are captured as `error`. */
export const runConsistencyAudit = async (
  db: AuditDb,
  workspaceId: string,
  now: number,
  opts: AuditOptions = {},
): Promise<ConsistencyAuditResult> => {
  const checks: Record<string, ConsistencyCheckResult> = {}
  let anomalies = 0
  const run = async (name: string, fn: () => Promise<ConsistencyCheckResult>): Promise<void> => {
    try {
      const result = await fn()
      checks[name] = result
      if (result.status === 'anomaly') anomalies += 1
    } catch (e) {
      checks[name] = { status: 'error', error: String((e as Error)?.message ?? e) }
    }
  }

  // R2 — references_json <-> block_references mirror (both directions + dupes + malformed).
  await run('references_index_mirror', async () => {
    const malformedJson = await count(
      db,
      `SELECT count(*) AS n FROM blocks b
       WHERE b.deleted=0 AND b.workspace_id=?
         AND (NOT json_valid(b.references_json) OR NOT json_valid(b.properties_json))`,
      [workspaceId],
    )
    const missingIndexRows = await count(
      db,
      `SELECT count(*) AS n FROM (
         SELECT b.id AS source_id,
                json_extract(je.value,'$.id') AS target_id,
                json_extract(je.value,'$.alias') AS alias,
                COALESCE(json_extract(je.value,'$.sourceField'),'') AS source_field
         FROM blocks b, json_each(${REFS_JSON}) je
         WHERE b.deleted=0 AND b.workspace_id=? AND ${EXPANDED_REF_FILTER}
       ) exp
       LEFT JOIN block_references br
         ON br.source_id=exp.source_id AND br.target_id=exp.target_id
        AND br.alias=exp.alias AND br.source_field=exp.source_field
       WHERE br.source_id IS NULL`,
      [workspaceId],
    )
    const extraIndexRows = await count(
      db,
      `SELECT count(*) AS n FROM block_references br
       JOIN blocks b ON b.id=br.source_id AND b.deleted=0
       WHERE br.workspace_id=?
         AND NOT EXISTS (
           SELECT 1 FROM json_each(${REFS_JSON}) je
           WHERE json_extract(je.value,'$.id')=br.target_id
             AND json_extract(je.value,'$.alias')=br.alias
             AND COALESCE(json_extract(je.value,'$.sourceField'),'')=br.source_field)`,
      [workspaceId],
    )
    const orphanSourceRows = await count(
      db,
      `SELECT count(*) AS n FROM block_references br
       LEFT JOIN blocks b ON b.id=br.source_id
       WHERE br.workspace_id=? AND (b.id IS NULL OR b.deleted=1)`,
      [workspaceId],
    )
    const duplicateTuples = await count(
      db,
      `SELECT count(*) AS n FROM (
         SELECT b.id,
                json_extract(je.value,'$.id') AS tid,
                json_extract(je.value,'$.alias') AS al,
                COALESCE(json_extract(je.value,'$.sourceField'),'') AS sf
         FROM blocks b, json_each(${REFS_JSON}) je
         WHERE b.deleted=0 AND b.workspace_id=? AND ${EXPANDED_REF_FILTER}
         GROUP BY b.id, tid, al, sf
         HAVING count(*) > 1
       )`,
      [workspaceId],
    )
    const total = missingIndexRows + extraIndexRows + orphanSourceRows + duplicateTuples + malformedJson
    const samples: string[] = []
    if (missingIndexRows > 0) {
      addSamples(samples, await sampleIds(
        db,
        `SELECT exp.source_id AS id FROM (
           SELECT b.id AS source_id,
                  json_extract(je.value,'$.id') AS target_id,
                  json_extract(je.value,'$.alias') AS alias,
                  COALESCE(json_extract(je.value,'$.sourceField'),'') AS source_field
           FROM blocks b, json_each(${REFS_JSON}) je
           WHERE b.deleted=0 AND b.workspace_id=? AND ${EXPANDED_REF_FILTER}
         ) exp
         LEFT JOIN block_references br
           ON br.source_id=exp.source_id AND br.target_id=exp.target_id
          AND br.alias=exp.alias AND br.source_field=exp.source_field
         WHERE br.source_id IS NULL LIMIT ${SAMPLE_LIMIT}`,
        [workspaceId],
      ))
    }
    if (extraIndexRows > 0) {
      addSamples(samples, await sampleIds(
        db,
        `SELECT br.source_id AS id FROM block_references br
         JOIN blocks b ON b.id=br.source_id AND b.deleted=0
         WHERE br.workspace_id=?
           AND NOT EXISTS (
             SELECT 1 FROM json_each(${REFS_JSON}) je
             WHERE json_extract(je.value,'$.id')=br.target_id
               AND json_extract(je.value,'$.alias')=br.alias
               AND COALESCE(json_extract(je.value,'$.sourceField'),'')=br.source_field)
         LIMIT ${SAMPLE_LIMIT}`,
        [workspaceId],
      ))
    }
    if (orphanSourceRows > 0) {
      addSamples(samples, await sampleIds(
        db,
        `SELECT br.source_id AS id FROM block_references br
         LEFT JOIN blocks b ON b.id=br.source_id
         WHERE br.workspace_id=? AND (b.id IS NULL OR b.deleted=1) LIMIT ${SAMPLE_LIMIT}`,
        [workspaceId],
      ))
    }
    return {
      status: total > 0 ? 'anomaly' : 'ok',
      missingIndexRows,
      extraIndexRows,
      orphanSourceRows,
      duplicateTuples,
      malformedJson,
      samples,
    }
  })

  // R4 — curated property-ref at-rest: value present in properties_json, projected
  // ref absent from references_json (the proven 06-09 detection query).
  await run('property_ref_at_rest', async () => {
    const findings: Array<{ prop: string; valuePresentRefAbsent: number }> = []
    const samples: string[] = []
    for (const name of CURATED_REF_PROPS) {
      const valueAbsentClause = `deleted=0 AND workspace_id=?
        AND properties_json LIKE '%"' || ? || '"%'
        AND references_json NOT LIKE '%"sourceField":"' || ? || '"%'`
      const n = await count(
        db,
        `SELECT count(*) AS n FROM blocks WHERE ${valueAbsentClause}`,
        [workspaceId, name, name],
      )
      if (n > 0) {
        findings.push({ prop: name, valuePresentRefAbsent: n })
        addSamples(samples, await sampleIds(
          db,
          `SELECT id FROM blocks WHERE ${valueAbsentClause} LIMIT ${SAMPLE_LIMIT}`,
          [workspaceId, name, name],
        ))
      }
    }
    const total = findings.reduce((sum, f) => sum + f.valuePresentRefAbsent, 0)
    // Anomaly only at catastrophe scale (see AT_REST_ANOMALY_FLOOR) — a small
    // benign baseline of empty-valued props must NOT turn the health chip red.
    return {
      status: total >= AT_REST_ANOMALY_FLOOR ? 'anomaly' : 'ok',
      curatedProps: CURATED_REF_PROPS,
      findings,
      total,
      samples,
    }
  })

  // L4 — blocks <-> blocks_synced divergence (ps_crud-aware). Per-client scans
  // miss divergence (#3, #5); this is the cross-view detector. Divergence is
  // frequently a TRANSIENT mid-sync state, so a dirty first pass is re-measured
  // after a delay (opts.divergenceRecheckMs) and the SETTLED counts are reported.
  await run('local_server_divergence', async () => {
    const pendingClause = `NOT EXISTS (
      SELECT 1 FROM ps_crud p
      WHERE json_extract(p.data,'$.type')='blocks' AND json_extract(p.data,'$.id')=b.id)`
    const strandedWhere = `b.workspace_id=? AND b.deleted=0
      AND NOT EXISTS (SELECT 1 FROM blocks_synced bs WHERE bs.id=b.id)
      AND ${pendingClause}`
    const standoffWhere = `b.workspace_id=? AND b.updated_at=bs.updated_at AND b.updated_at!=0
      AND (b.content!=bs.content OR b.properties_json!=bs.properties_json
           OR b.references_json!=bs.references_json OR b.deleted!=bs.deleted)`
    const localRicherWhere = `b.workspace_id=? AND b.updated_at>bs.updated_at AND ${pendingClause}`
    const serverAheadWhere = `b.workspace_id=? AND bs.updated_at>b.updated_at AND ${pendingClause}
      AND (b.content!=bs.content OR b.properties_json!=bs.properties_json
           OR b.references_json!=bs.references_json OR b.deleted!=bs.deleted)`

    const measure = async () => ({
      strandedLocalOnly: await count(db, `SELECT count(*) AS n FROM blocks b WHERE ${strandedWhere}`, [workspaceId]),
      equalStampStandoff: await count(db, `SELECT count(*) AS n FROM blocks b JOIN blocks_synced bs ON bs.id=b.id WHERE ${standoffWhere}`, [workspaceId]),
      localRicherNoPending: await count(db, `SELECT count(*) AS n FROM blocks b JOIN blocks_synced bs ON bs.id=b.id WHERE ${localRicherWhere}`, [workspaceId]),
      serverAheadUndrained: await count(db, `SELECT count(*) AS n FROM blocks b JOIN blocks_synced bs ON bs.id=b.id WHERE ${serverAheadWhere}`, [workspaceId]),
    })
    // stranded + standoff + local-richer are real anomalies; server-ahead is info.
    const anomalyTotal = (m: Awaited<ReturnType<typeof measure>>) =>
      m.strandedLocalOnly + m.equalStampStandoff + m.localRicherNoPending

    let m = await measure()
    let rechecked = false
    if (anomalyTotal(m) > 0 && opts.divergenceRecheckMs && opts.sleep) {
      await opts.sleep(opts.divergenceRecheckMs)
      m = await measure() // settled counts — a transient will have cleared
      rechecked = true
    }

    const samples: string[] = []
    if (m.strandedLocalOnly > 0) {
      addSamples(samples, await sampleIds(db, `SELECT b.id AS id FROM blocks b WHERE ${strandedWhere} LIMIT ${SAMPLE_LIMIT}`, [workspaceId]))
    }
    if (m.equalStampStandoff > 0) {
      addSamples(samples, await sampleIds(db, `SELECT b.id AS id FROM blocks b JOIN blocks_synced bs ON bs.id=b.id WHERE ${standoffWhere} LIMIT ${SAMPLE_LIMIT}`, [workspaceId]))
    }
    if (m.localRicherNoPending > 0) {
      addSamples(samples, await sampleIds(db, `SELECT b.id AS id FROM blocks b JOIN blocks_synced bs ON bs.id=b.id WHERE ${localRicherWhere} LIMIT ${SAMPLE_LIMIT}`, [workspaceId]))
    }
    return {
      status: anomalyTotal(m) > 0 ? 'anomaly' : 'ok',
      strandedLocalOnly: m.strandedLocalOnly,
      equalStampStandoff: m.equalStampStandoff,
      localRicherNoPending: m.localRicherNoPending,
      serverAheadUndrained: m.serverAheadUndrained,
      rechecked,
      samples,
    }
  })

  return { workspaceId, checkedAt: now, anomalies, checks }
}
