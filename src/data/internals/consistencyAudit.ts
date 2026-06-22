// Built-in client-side consistency audit (L3 of the data-integrity defense —
// docs/data-integrity-defense.html). The cadenced, always-on complement to the
// on-demand bridge eval (scripts/data-integrity/consistency-check.eval.js): a
// lean, count-only subset of the same invariants that the Repo runs on idle and
// surfaces as a metric, so the catastrophic strip/divergence classes are caught
// on a cadence instead of only when a human remembers to run the eval.
//
// All checks are READ-ONLY over the client SQLite (it runs on the decrypted
// client, so unlike the server probe it covers the e2ee workspace). Almost all
// are pure counts; the one exception is the divergence check's optional e2ee
// decrypt spot-check, which decodes a BOUNDED sample of staging rows (the only
// way to compare content that's ciphertext at rest) — bounded so the cadence
// cost stays fixed regardless of graph size. Each check is isolated: a missing
// table or malformed row degrades that one check to `error`, never crashing the
// audit or reading as clean. The deep per-ref/sample/precise-projection diffs
// and the FULL decrypt-compare stay in the eval — this is the smoke alarm, not
// the full inspection.

import { ENVELOPE_PREFIX } from '@/sync/crypto/envelope.js'
import { contentAad } from '@/sync/crypto/aad.js'
import { open } from '@/sync/crypto/aead.js'
import {
  decodeFromWire,
  type GetCek,
  type GetMaterializability,
} from '@/sync/transform.js'

/** Minimal DB surface the audit needs (a subset of the Repo's PowerSyncDb). */
export interface AuditDb {
  getAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

// A value sealed by the e2ee seam carries the `enc:v1:` envelope prefix
// (sync/crypto/envelope.ts). On an e2ee workspace `blocks_synced` holds this
// ciphertext at rest while `blocks` holds the decrypted plaintext, so the two
// are NEVER byte-equal — a naive cross-view content diff flags every e2ee row.
// SQL predicates for "is / isn't encrypted at rest". The prefix is a constant
// with no LIKE wildcards, so embedding it as a literal is safe.
const isEnc = (col: string): string => `${col} LIKE '${ENVELOPE_PREFIX}%'`
const notEnc = (col: string): string => `${col} NOT LIKE '${ENVELOPE_PREFIX}%'`

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

/** §6 mode/key resolver surface the decrypt spot-check needs — structurally the
 *  observer's `MaterializeDeps`, so the Repo passes its `syncObserverDeps`
 *  straight through. Omit to run cleartext-only (the default). */
export interface AuditDecryptDeps {
  readonly getMaterializability: GetMaterializability
  readonly getCek: GetCek
}

/** Default cap on equal-stamp e2ee rows the always-on spot-check decrypts. Fixed
 *  so the cadence cost is constant regardless of graph size; the on-demand eval
 *  does the exhaustive decrypt-compare. */
export const DECRYPT_SAMPLE_LIMIT = 100

/** Nested result of the divergence check's e2ee decrypt spot-check. */
export interface DecryptSpotCheckResult {
  status: 'ok' | 'anomaly' | 'skipped'
  reason?: string
  /** Rows actually decrypt-compared. */
  sampled: number
  /** Rows whose decrypted content differed from the local plaintext (the
   *  anomaly: a content edit that didn't advance the stamp). */
  mismatches: number
  /** Rows that failed to decrypt (key race / tamper — already quarantined by the
   *  observer); reported as info, not an anomaly, to keep the chip low-noise. */
  undecryptable?: number
  sampleSize?: number
  samples?: string[]
}

export interface AuditOptions {
  /** When set (with `sleep`), the divergence check that finds anomalies on its
   *  first pass re-measures after this delay and reports the SETTLED counts —
   *  debouncing transient mid-sync divergence (an own write uploaded but its
   *  server echo not yet streamed back; a mid-resync window). The point-in-time
   *  snapshot can't otherwise tell a transient from a persistent divergence
   *  (SLO §5). Omit to disable (the default — pure, instant, used in tests). */
  divergenceRecheckMs?: number
  sleep?: (ms: number) => Promise<void>
  /** When set, the divergence check decrypts a bounded sample of equal-stamp
   *  e2ee staging rows and compares plaintext-to-plaintext — recovering the
   *  content-divergence detection the cleartext-only SQL diff gives up on an
   *  e2ee workspace. Omit to run cleartext-only (the default — pure, used in
   *  tests and on plaintext/locked workspaces). */
  decrypt?: AuditDecryptDeps
  /** Override the spot-check sample size (default DECRYPT_SAMPLE_LIMIT). */
  decryptSampleSize?: number
}

interface SpotCheckRow {
  id: string
  workspace_id: string
  l_content: string
  l_properties_json: string
  l_references_json: string
  s_content: string
  s_properties_json: string
  s_references_json: string
}

/** Decrypt a bounded sample of equal-stamp e2ee staging rows and compare the
 *  decrypted content to the local plaintext. The e2ee analogue of
 *  `equalStampStandoff`: it catches a content edit that failed to advance the
 *  stamp, which the cleartext-only SQL diff can't see through ciphertext. A
 *  decrypt failure is NOT counted as an anomaly (key races / tampered rows are
 *  the observer's quarantine concern) — only a genuine plaintext mismatch is. */
const runDecryptSpotCheck = async (
  db: AuditDb,
  workspaceId: string,
  deps: AuditDecryptDeps,
  sampleSize: number,
): Promise<DecryptSpotCheckResult> => {
  const materializability = await deps.getMaterializability(workspaceId)
  if (materializability !== 'decrypt') {
    // 'copy' → no ciphertext to check; 'defer' → WK not loaded, can't decrypt.
    return {
      status: 'skipped',
      reason: `workspace not decryptable (materializability=${materializability})`,
      sampled: 0,
      mismatches: 0,
    }
  }
  const rows = await db.getAll<SpotCheckRow>(
    `SELECT b.id AS id, b.workspace_id AS workspace_id,
            b.content AS l_content, b.properties_json AS l_properties_json,
            b.references_json AS l_references_json,
            bs.content AS s_content, bs.properties_json AS s_properties_json,
            bs.references_json AS s_references_json
     FROM blocks b JOIN blocks_synced bs ON bs.id=b.id
     WHERE b.workspace_id=? AND b.updated_at=bs.updated_at AND b.updated_at!=0
       AND ${isEnc('bs.content')}
     LIMIT ${sampleSize}`,
    [workspaceId],
  )
  let mismatches = 0
  let undecryptable = 0
  const samples: string[] = []
  for (const r of rows) {
    let plain
    try {
      plain = await decodeFromWire(
        {
          id: r.id,
          workspace_id: r.workspace_id,
          content: r.s_content,
          properties_json: r.s_properties_json,
          references_json: r.s_references_json,
        },
        'e2ee',
        deps.getCek,
      )
    } catch {
      undecryptable += 1
      continue
    }
    if (
      plain.content !== r.l_content ||
      plain.properties_json !== r.l_properties_json ||
      plain.references_json !== r.l_references_json
    ) {
      mismatches += 1
      if (samples.length < SAMPLE_LIMIT) samples.push(r.id)
    }
  }
  return {
    status: mismatches > 0 ? 'anomaly' : 'ok',
    sampled: rows.length,
    mismatches,
    undecryptable,
    sampleSize,
    samples,
  }
}

interface LocalCiphertextRow {
  id: string
  workspace_id: string
  content: string
}

/** Detect a live local `blocks` row still holding `enc:v1:` ciphertext — the
 *  app-visible table must be plaintext, so this means materialization never
 *  completed. Only the `content` column is checked: the alias/types triggers run
 *  `json_each` on `properties_json`/`references_json`, so a row with ciphertext
 *  there can't even be inserted — content is the one unconstrained column where
 *  ciphertext can lurk.
 *
 *  The prefix ALONE can't confirm it: a plaintext block whose content merely
 *  starts with `enc:v1:` (a note ABOUT the envelope format) is byte-identical in
 *  shape to un-materialized ciphertext. So we DECRYPT-verify the content column —
 *  genuine ciphertext opens under the WK, user-typed text doesn't. Without a key
 *  (no resolver, or a non-decryptable workspace) we can only report the raw
 *  prefix count as info. */
const runMaterializedCiphertextCheck = async (
  db: AuditDb,
  workspaceId: string,
  deps: AuditDecryptDeps | undefined,
  sampleSize: number,
): Promise<ConsistencyCheckResult> => {
  const where = `b.workspace_id=? AND b.deleted=0 AND ${isEnc('b.content')}`
  const encPrefixed = await count(
    db, `SELECT count(*) AS n FROM blocks b WHERE ${where}`, [workspaceId],
  )
  const materializability = deps ? await deps.getMaterializability(workspaceId) : undefined
  const key = deps && materializability === 'decrypt' ? await deps.getCek(workspaceId) : null
  if (!key) {
    // Can't confirm without the key — report the raw count as info, not anomaly.
    return {
      status: 'ok',
      encPrefixed,
      confirmed: null,
      reason: deps ? `not decryptable (materializability=${materializability})` : 'no key resolver',
    }
  }
  if (encPrefixed === 0) return { status: 'ok', encPrefixed, confirmed: 0, samples: [] }
  const rows = await db.getAll<LocalCiphertextRow>(
    `SELECT b.id AS id, b.workspace_id AS workspace_id, b.content AS content
     FROM blocks b WHERE ${where} LIMIT ${sampleSize}`,
    [workspaceId],
  )
  let confirmed = 0
  const samples: string[] = []
  for (const r of rows) {
    try {
      await open(key, r.content, contentAad(r.id, r.workspace_id, 'content'))
      // Opened under the WK ⇒ genuine ciphertext in the plaintext table.
      confirmed += 1
      if (samples.length < SAMPLE_LIMIT) samples.push(r.id)
    } catch {
      // Doesn't decrypt ⇒ benign plaintext that merely starts with `enc:v1:`.
    }
  }
  return { status: confirmed > 0 ? 'anomaly' : 'ok', encPrefixed, confirmed, samples }
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
    // Cross-view content diff. An e2ee staging row holds `enc:v1:` ciphertext
    // while `blocks` holds decrypted plaintext, so they're never byte-equal —
    // comparing them flags every e2ee row. So: always compare the cleartext
    // columns (`deleted`; `updated_at` is the join key), and byte-compare the
    // three sealed content columns ONLY when the staging value is plaintext.
    // The decrypt spot-check below recovers content-divergence detection for
    // e2ee rows. Shared by the standoff and server-ahead buckets.
    const contentDiffers = `(
      b.deleted!=bs.deleted
      OR (${notEnc('bs.content')}
          AND (b.content!=bs.content OR b.properties_json!=bs.properties_json
               OR b.references_json!=bs.references_json)))`
    const standoffWhere = `b.workspace_id=? AND b.updated_at=bs.updated_at AND b.updated_at!=0
      AND ${contentDiffers}`
    const localRicherWhere = `b.workspace_id=? AND b.updated_at>bs.updated_at AND ${pendingClause}`
    const serverAheadWhere = `b.workspace_id=? AND bs.updated_at>b.updated_at AND ${pendingClause}
      AND ${contentDiffers}`

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

    // e2ee content divergence: the cleartext-only diff above can't see through
    // ciphertext, so decrypt a bounded sample of equal-stamp e2ee rows and
    // compare plaintext-to-plaintext. Degrade the spot-check (not the whole
    // check) if the key subsystem throws — the SQL counts above stay valid.
    let decryptSpotCheck: DecryptSpotCheckResult | undefined
    if (opts.decrypt) {
      try {
        decryptSpotCheck = await runDecryptSpotCheck(
          db, workspaceId, opts.decrypt, opts.decryptSampleSize ?? DECRYPT_SAMPLE_LIMIT,
        )
      } catch (e) {
        decryptSpotCheck = {
          status: 'skipped',
          reason: `spot-check failed: ${String((e as Error)?.message ?? e)}`,
          sampled: 0,
          mismatches: 0,
        }
      }
    }

    return {
      status: anomalyTotal(m) > 0 || decryptSpotCheck?.status === 'anomaly' ? 'anomaly' : 'ok',
      strandedLocalOnly: m.strandedLocalOnly,
      equalStampStandoff: m.equalStampStandoff,
      localRicherNoPending: m.localRicherNoPending,
      serverAheadUndrained: m.serverAheadUndrained,
      rechecked,
      decryptSpotCheck,
      samples,
    }
  })

  // Local `blocks` must always be plaintext — the observer decrypts e2ee staging
  // rows before writing them. A live local row still carrying an `enc:v1:`
  // envelope means materialization never completed (a resolver misclassification
  // copying an e2ee row through, say): a real, e2ee-only corruption class the
  // plaintext path never had. Decrypt-verified (see runMaterializedCiphertextCheck)
  // so a user note that merely starts with `enc:v1:` can't false-positive.
  await run('materialized_still_ciphertext', () =>
    runMaterializedCiphertextCheck(db, workspaceId, opts.decrypt, opts.decryptSampleSize ?? DECRYPT_SAMPLE_LIMIT),
  )

  return { workspaceId, checkedAt: now, anomalies, checks }
}
