// Read-only data-integrity consistency check (L3 + L4 of docs/data-integrity-defense.html).
//
// Runs the exact ad-hoc audits used during the 2026-06 incident investigation as a
// maintained, repeatable suite. It WRITES NOTHING — pure detection. Run it on a cadence
// (or whenever "the backlinks look wrong") to catch the failure classes that previously
// sat undetected for ~a week:
//   - R2  references_json <-> block_references index mirror drift (incl. duplicate tuples)
//   - R7  dangling refs (target missing/deleted) — trend, not absolute
//   - R4  property-ref projection: PRECISE diff for loaded ref schemas (active workspace
//         only — repo.propertySchemas reflects the active workspace) PLUS a
//         schema-independent at-rest heuristic that also catches strips of toggled-off
//         ref props (the exact 06-09 next-review-date / SRS-off condition)
//   - R1/R3 content-link strip recompute (parser-precise: >=1 real content mark, 0 stored content refs)
//   - L4  blocks <-> blocks_synced divergence (ps_crud-aware): stranded local-only,
//         equal-stamp standoff, local-richer-no-pending, server-ahead-undrained
//
// Run via the agent bridge (target tab must be focused/connected):
//   yarn agent --profile <name> eval --file scripts/data-integrity/consistency-check.eval.js
//   # scope to one workspace (defaults to the active one):
//   ... --data-json '{"workspaceId":"ef43b424-..."}'
//   # audit every workspace on the client:
//   ... --data-json '{"allWorkspaces":true}'
//   # tune sample size / candidate cap:
//   ... --data-json '{"sampleLimit":20,"candidateCap":80000}'

const allWorkspaces = data?.allWorkspaces === true
const workspaceId = data?.workspaceId ?? (allWorkspaces ? null : repo.activeWorkspaceId)
const sampleLimit = Number.isInteger(data?.sampleLimit) ? data.sampleLimit : 10
const candidateCap = Number.isInteger(data?.candidateCap) ? data.candidateCap : 60000

if (!allWorkspaces && !workspaceId) {
  throw new Error(
    'no workspaceId: no active workspace and none passed. Use --data-json {"workspaceId":"…"} or {"allWorkspaces":true}',
  )
}

// Workspace predicate fragments. `wsParams()` returns the bound params in order.
const wsClause = (col) => (allWorkspaces ? '1=1' : `${col} = ?`)
const wsParams = () => (allWorkspaces ? [] : [workspaceId])

const rows = (text, params = []) => sql(text, params, 'all')
const one = async (text, params = []) => (await rows(text, params))[0]
const countOf = async (text, params = []) => Number((await one(text, params))?.n ?? 0)

const report = {
  mode: 'read-only',
  generatedAt: new Date().toISOString(),
  scope: allWorkspaces ? 'all-workspaces' : workspaceId,
  sampleLimit,
  checks: {},
  anomalies: 0,
}

const record = (name, anomalous, payload) => {
  report.checks[name] = { status: anomalous ? 'anomaly' : 'ok', ...payload }
  if (anomalous) report.anomalies += 1
}
const skip = (name, reason, payload = {}) => {
  report.checks[name] = { status: 'skipped', reason, ...payload }
}

// ── R2: references_json <-> block_references mirror ───────────────────────────
// Faithful 1:1 expansion is the audit-confirmed invariant. Drift in either direction
// means the trigger missed a write or a raw write bypassed it.
try {
  const expandedRefFilter = `
        typeof(json_extract(je.value,'$.id'))='text'
    AND typeof(json_extract(je.value,'$.alias'))='text'
    AND (json_type(je.value,'$.sourceField') IS NULL
         OR typeof(json_extract(je.value,'$.sourceField'))='text')`

  // (0) malformed JSON must be DETECTED, not silently abort the check. `json_each` throws
  // on invalid JSON, which would crash this whole try and leave the mirror 'skipped' with
  // report.anomalies untouched. Count bad rows directly, and feed `json_each` a guarded
  // value below so a single bad row can't throw.
  const malformedJson = await countOf(
    `SELECT count(*) AS n FROM blocks
     WHERE deleted=0 AND ${wsClause('workspace_id')}
       AND (NOT json_valid(references_json) OR NOT json_valid(properties_json))`,
    wsParams(),
  )
  const refsJson = `CASE WHEN json_valid(b.references_json) THEN b.references_json ELSE '[]' END`

  // (a) entries in references_json with no matching block_references row
  const missingRows = await countOf(
    `SELECT count(*) AS n FROM (
       SELECT b.id AS source_id,
              json_extract(je.value,'$.id') AS target_id,
              json_extract(je.value,'$.alias') AS alias,
              COALESCE(json_extract(je.value,'$.sourceField'),'') AS source_field
       FROM blocks b, json_each(${refsJson}) je
       WHERE b.deleted=0 AND ${wsClause('b.workspace_id')} AND ${expandedRefFilter}
     ) exp
     LEFT JOIN block_references br
       ON br.source_id=exp.source_id AND br.target_id=exp.target_id
      AND br.alias=exp.alias AND br.source_field=exp.source_field
     WHERE br.source_id IS NULL`,
    wsParams(),
  )

  // (b) block_references rows with no matching references_json entry on a live block
  const extraRows = await countOf(
    `SELECT count(*) AS n FROM block_references br
     JOIN blocks b ON b.id=br.source_id AND b.deleted=0
     WHERE ${wsClause('br.workspace_id')}
       AND NOT EXISTS (
         SELECT 1 FROM json_each(${refsJson}) je
         WHERE json_extract(je.value,'$.id')=br.target_id
           AND json_extract(je.value,'$.alias')=br.alias
           AND COALESCE(json_extract(je.value,'$.sourceField'),'')=br.source_field)`,
    wsParams(),
  )

  // (c) block_references rows whose source block is gone/deleted (trigger should prune)
  const orphanSourceRows = await countOf(
    `SELECT count(*) AS n FROM block_references br
     LEFT JOIN blocks b ON b.id=br.source_id
     WHERE ${wsClause('br.workspace_id')} AND (b.id IS NULL OR b.deleted=1)`,
    wsParams(),
  )

  // (d) duplicate (target,alias,sourceField) tuples within one block's references_json.
  // The index PK + INSERT OR IGNORE collapse these to one row, so the count-based mirror
  // above can't see them — this is the one drift R2's "1:1" claim explicitly carves out
  // (un-normalized / raw writes), so surface it directly. Normal tx.* writes normalize,
  // so a nonzero count means a write bypassed normalizeReferences.
  const duplicateTuples = await countOf(
    `SELECT count(*) AS n FROM (
       SELECT b.id,
              json_extract(je.value,'$.id') AS tid,
              json_extract(je.value,'$.alias') AS al,
              COALESCE(json_extract(je.value,'$.sourceField'),'') AS sf
       FROM blocks b, json_each(${refsJson}) je
       WHERE b.deleted=0 AND ${wsClause('b.workspace_id')} AND ${expandedRefFilter}
       GROUP BY b.id, tid, al, sf
       HAVING count(*) > 1
     )`,
    wsParams(),
  )

  record(
    'references_index_mirror',
    missingRows + extraRows + orphanSourceRows + duplicateTuples + malformedJson > 0,
    {
      missingIndexRows: missingRows,
      extraIndexRows: extraRows,
      orphanSourceRows,
      duplicateTuples,
      malformedJson,
    },
  )
} catch (e) {
  skip('references_index_mirror', String(e))
}

// ── R7: dangling refs (target missing/deleted) ───────────────────────────────
// Expected to be small and stable (faithful index of user content — links to deleted/
// merged pages, stale ((block-refs)) in text). Watch the TREND, not the absolute count.
try {
  const danglingByKind = await rows(
    `SELECT CASE WHEN br.source_field='' THEN 'content' ELSE 'property' END AS kind,
            count(*) AS n
     FROM block_references br
     LEFT JOIN blocks t ON t.id=br.target_id
     WHERE ${wsClause('br.workspace_id')} AND (t.id IS NULL OR t.deleted=1)
     GROUP BY kind`,
    wsParams(),
  )
  const sample = await rows(
    `SELECT br.source_id, br.target_id, br.source_field
     FROM block_references br
     LEFT JOIN blocks t ON t.id=br.target_id
     WHERE ${wsClause('br.workspace_id')} AND (t.id IS NULL OR t.deleted=1)
     LIMIT ${sampleLimit}`,
    wsParams(),
  )
  const total = danglingByKind.reduce((a, r) => a + Number(r.n), 0)
  // Dangling refs are benign at baseline; report as info (never an anomaly on its own).
  report.checks.dangling_refs = {
    status: 'info',
    total,
    byKind: Object.fromEntries(danglingByKind.map((r) => [r.kind, Number(r.n)])),
    sample,
  }
} catch (e) {
  skip('dangling_refs', String(e))
}

// ── R4 (1): property-ref projection — PRECISE diff (active workspace, loaded schemas) ──
// The next-review-date detector. For every loaded ref-typed property, recompute the
// expected refs via the app's OWN projection and diff against what is stored. `missing` =
// a strip (value present, ref gone). `extra` = a value-desync, but ONLY for a present
// schema: a stored ref whose sourceField schema is ABSENT is retained by design
// (c2df661e/21494fdb — derived refs are value-tied), so it must NOT be flagged.
// Two hard limits force the at-rest heuristic below to complement this: (a) it is sound
// only for the ACTIVE workspace — repo.propertySchemas is active-only, so evaluating
// another workspace's blocks against it manufactures phantom findings; (b) it sees only
// CURRENTLY-LOADED ref props — a toggled-off plugin (SRS off ⇒ next-review-date absent:
// the 06-09 condition) would make it silently skip that prop.
const CURATED_REF_PROPS = ['next-review-date']
try {
  const { isRefCodec, isRefListCodec } = await import('@/data/api')
  const { projectPropertyReferences } = await import(
    '@/plugins/references/referenceProjection.js'
  )
  const schemas = repo.propertySchemas
  const refNames = [...schemas]
    .filter(([, s]) => isRefCodec(s.codec) || isRefListCodec(s.codec))
    .map(([name]) => name)
  const refNameSet = new Set(refNames)
  // repo.propertySchemas is active-workspace-only, so the precise diff is sound only when
  // auditing the active workspace; for any other scope skip it (the at-rest heuristic
  // below still runs and covers strips schema-independently).
  const notActive = allWorkspaces || workspaceId !== repo.activeWorkspaceId

  if (notActive) {
    skip(
      'property_ref_projection',
      `precise diff needs the active workspace (repo.propertySchemas is active-only): scope=${report.scope}, active=${repo.activeWorkspaceId}. The at-rest heuristic still runs.`,
    )
  } else if (refNames.length === 0) {
    skip('property_ref_projection', 'no ref-typed property schemas loaded in the runtime')
  } else {
    // Candidate filter: blocks that mention any ref-typed prop name. Over-broad is fine
    // (the JS diff below is exact); this just bounds the rows we pull into memory.
    const likeClause = refNames.map(() => 'properties_json LIKE ?').join(' OR ')
    const likeParams = refNames.map((n) => `%"${n}"%`)
    const candidates = await rows(
      `SELECT id, properties_json, references_json
       FROM blocks
       WHERE deleted=0 AND workspace_id=? AND (${likeClause})
       LIMIT ${candidateCap + 1}`,
      [workspaceId, ...likeParams],
    )
    const truncated = candidates.length > candidateCap
    const scanned = truncated ? candidates.slice(0, candidateCap) : candidates

    // Key on \u0000 (NUL): property names can contain spaces but never a NUL, so the
    // key can't collide or garble samples. Mirrors referenceProjection.ts's separator.
    const refKey = (r) => `${r.sourceField ?? ''}\u0000${r.id}`
    let blocksMissing = 0
    let blocksExtra = 0
    let refsMissing = 0
    let refsExtra = 0
    const missingSample = []
    const extraSample = []

    for (const row of scanned) {
      let properties, stored
      try {
        properties = JSON.parse(row.properties_json)
        stored = JSON.parse(row.references_json)
      } catch {
        continue // malformed JSON is caught by the index-mirror check
      }
      const expected = projectPropertyReferences({ properties }, schemas)
      const expectedKeys = new Set(expected.map(refKey))
      const storedPropKeys = new Set(
        stored.filter((r) => r && r.sourceField).map(refKey),
      )
      const missing = [...expectedKeys].filter((k) => !storedPropKeys.has(k))
      // Only flag an `extra` when the sourceField's schema is PRESENT (the present-schema
      // projection would have re-derived it) — then a stored ref absent from `expected`
      // is a genuine value-desync. A stored ref whose schema is ABSENT is retained by
      // design (value-tied), not an error, so it is excluded here.
      const extra = [
        ...new Set(
          stored
            .filter((r) => r && r.sourceField && refNameSet.has(r.sourceField))
            .map(refKey),
        ),
      ].filter((k) => !expectedKeys.has(k))
      if (missing.length) {
        blocksMissing += 1
        refsMissing += missing.length
        if (missingSample.length < sampleLimit)
          missingSample.push({ id: row.id, missing: missing.map((k) => k.split('\u0000')) })
      }
      if (extra.length) {
        blocksExtra += 1
        refsExtra += extra.length
        if (extraSample.length < sampleLimit)
          extraSample.push({ id: row.id, extra: extra.map((k) => k.split('\u0000')) })
      }
    }

    const anomalous = blocksMissing + blocksExtra > 0
    // A truncated scan only saw part of the workspace, so a clean result is NOT 'ok' —
    // mark it 'incomplete' (raise candidateCap and re-run) so it can't read as healthy.
    report.checks.property_ref_projection = {
      status: anomalous ? 'anomaly' : truncated ? 'incomplete' : 'ok',
      refTypedProps: refNames.length,
      scanned: scanned.length,
      truncated,
      blocksMissingRefs: blocksMissing,
      refsMissing,
      blocksExtraRefs: blocksExtra,
      refsExtra,
      missingSample,
      extraSample,
    }
    if (anomalous) report.anomalies += 1
  }
} catch (e) {
  skip('property_ref_projection', String(e))
}

// ── R4 (2): property-ref at-rest heuristic — schema-INDEPENDENT ────────────────
// Covers ref props whose owning plugin is toggled off, which the precise check above
// CANNOT see (the exact 06-09 condition: SRS off ⇒ next-review-date absent from the
// loaded schemas ⇒ a strip of its refs would go unnoticed). A prop is "believed
// ref-typed" if it currently projects at least one ref (its name appears as a
// block_references.source_field) or it's on the curated list. For such props NOT covered
// by a loaded schema, flag blocks holding the value but missing the projected ref
// (`properties_json` has the key, `references_json` lacks `"sourceField":"<name>"`) — the
// proven 06-09 detection query. Heuristic: a small benign baseline is expected (empty /
// non-uuid values that correctly don't project) — watch the trend, and re-run the precise
// check with the owning plugin enabled to confirm a real strip.
try {
  const { isRefCodec, isRefListCodec } = await import('@/data/api')
  const loaded = new Set(
    [...repo.propertySchemas]
      .filter(([, s]) => isRefCodec(s.codec) || isRefListCodec(s.codec))
      .map(([name]) => name),
  )
  if (allWorkspaces) {
    skip('property_ref_at_rest', 'runs per-workspace (the source_field set is per-workspace); pass a workspaceId')
  } else {
    const fromIndex = (
      await rows(
        `SELECT DISTINCT source_field AS name FROM block_references
         WHERE workspace_id=? AND source_field!=''`,
        [workspaceId],
      )
    ).map((r) => r.name)
    const absentNames = [...new Set([...fromIndex, ...CURATED_REF_PROPS])].filter(
      (n) => !loaded.has(n),
    )
    if (absentNames.length === 0) {
      skip(
        'property_ref_at_rest',
        'every believed-ref prop has a loaded schema (covered precisely above)',
      )
    } else {
      const perProp = []
      for (const name of absentNames) {
        const n = await countOf(
          `SELECT count(*) AS n FROM blocks
           WHERE deleted=0 AND workspace_id=?
             AND properties_json LIKE '%"' || ? || '"%'
             AND references_json NOT LIKE '%"sourceField":"' || ? || '"%'`,
          [workspaceId, name, name],
        )
        if (n > 0) perProp.push({ prop: name, valuePresentRefAbsent: n })
      }
      record('property_ref_at_rest', perProp.length > 0, {
        note: 'heuristic (owning plugin not loaded; a small benign baseline from empty/non-uuid values is expected) — re-run the precise check with the plugin enabled to confirm',
        uncoveredRefProps: absentNames,
        findings: perProp,
      })
    }
  }
} catch (e) {
  skip('property_ref_at_rest', String(e))
}

// ── R1/R3: content-link strip recompute (parser-precise) ──────────────────────
// Upgrade of the old LIKE heuristic: parse each candidate's content with the SAME
// parser the references processor uses (parseReferences + parseBlockRefs), so a
// `[[` in a code block or an `((not-a-uuid))` produces no mark — exactly as the
// processor sees it (it uses the plain-text parser too, and parses no hashtags),
// eliminating the heuristic's code-block / false-bracket noise. A block with >=1
// real content mark but ZERO stored content refs (sourceField empty) is a strip:
// content the processor WOULD project a ref from, with none stored.
//
// Sound without alias resolution because it keys on presence (>=1 mark vs 0 refs),
// not per-ref identity: reconcileDerived dedups content refs by target id, so two
// aliases that resolve to one target collapse to one ref — a per-mark count diff
// would false-positive, the zero-check does not. The remaining cases are a strip
// (real) or a not-yet-processed fresh block (transient) — re-run to clear the
// latter. The full per-id alias-resolving diff (catching a PARTIAL content-ref
// strip) needs the processor's read-only seat resolution and is deferred (§6).
try {
  const { parseReferences, parseBlockRefs } = await import(
    '@/plugins/references/referenceParser.js'
  )
  // Keyset-paginate (id > lastId) so the whole graph is covered in bounded
  // memory — a single LIMIT big enough to cover a real graph would pull every
  // content string into the live tab's heap at once (OOM risk). `contentCap` is
  // only a pathological-size safety ceiling; it does NOT cap a normal graph.
  const contentCap = Number.isInteger(data?.contentCap) ? data.contentCap : 1_000_000
  const BATCH = 20000
  let lastId = ''
  let scanned = 0
  let withMarks = 0
  let strippedBlocks = 0
  let truncated = false
  const strippedSample = []
  for (;;) {
    const batch = await rows(
      `SELECT id, content, references_json FROM blocks
       WHERE deleted=0 AND ${wsClause('workspace_id')}
         AND (content LIKE '%[[%' OR content LIKE '%((%')
         AND id > ?
       ORDER BY id LIMIT ${BATCH}`,
      [...wsParams(), lastId],
    )
    if (batch.length === 0) break
    for (const row of batch) {
      const markCount =
        parseReferences(row.content).length + parseBlockRefs(row.content).length
      if (markCount === 0) continue // LIKE matched but no real mark (code/escaped/non-uuid)
      withMarks += 1
      let stored
      try {
        stored = JSON.parse(row.references_json)
      } catch {
        continue // malformed JSON is the index-mirror check's job
      }
      const contentRefs = stored.filter((r) => r && !r.sourceField)
      if (contentRefs.length === 0) {
        strippedBlocks += 1
        if (strippedSample.length < sampleLimit)
          strippedSample.push({ id: row.id, marks: markCount, content_preview: row.content.slice(0, 120) })
      }
    }
    scanned += batch.length
    lastId = batch[batch.length - 1].id
    if (batch.length < BATCH) break
    if (scanned >= contentCap) { truncated = true; break } // safety ceiling only
  }

  const anomalous = strippedBlocks > 0
  // Only a safety-ceiling hit leaves part of the graph unseen → not 'ok'.
  report.checks.content_link_recompute = {
    status: anomalous ? 'anomaly' : truncated ? 'incomplete' : 'ok',
    scanned,
    truncated,
    blocksWithMarks: withMarks,
    strippedBlocks,
    note: 'block has >=1 parsed content mark but zero stored content refs — a strip, or a not-yet-processed fresh block (re-run to clear the latter)',
    strippedSample,
  }
  if (anomalous) report.anomalies += 1
} catch (e) {
  skip('content_link_recompute', String(e))
}

// ── L4: blocks <-> blocks_synced divergence (ps_crud-aware) ───────────────────
// Per-client scans miss divergence (incidents #3, #5) — this is the cross-view detector.
const pendingClause = `NOT EXISTS (
  SELECT 1 FROM ps_crud p
  WHERE json_extract(p.data,'$.type')='blocks' AND json_extract(p.data,'$.id')=b.id)`
try {
  // (a) stranded local-only: in blocks, not in blocks_synced, nothing queued → can't sync
  const strandedLocalOnly = await countOf(
    `SELECT count(*) AS n FROM blocks b
     WHERE ${wsClause('b.workspace_id')} AND b.deleted=0
       AND NOT EXISTS (SELECT 1 FROM blocks_synced bs WHERE bs.id=b.id)
       AND ${pendingClause}`,
    wsParams(),
  )
  // (b) equal-stamp standoff (violates gate invariant R8): same nonzero stamp, differ
  const equalStampStandoff = await countOf(
    `SELECT count(*) AS n FROM blocks b JOIN blocks_synced bs ON bs.id=b.id
     WHERE ${wsClause('b.workspace_id')} AND b.updated_at=bs.updated_at AND b.updated_at!=0
       AND (b.content!=bs.content OR b.properties_json!=bs.properties_json
            OR b.references_json!=bs.references_json OR b.deleted!=bs.deleted)`,
    wsParams(),
  )
  // (c) local-richer-no-pending: local newer than server, nothing queued → at-risk (#5)
  const localRicherNoPending = await countOf(
    `SELECT count(*) AS n FROM blocks b JOIN blocks_synced bs ON bs.id=b.id
     WHERE ${wsClause('b.workspace_id')} AND b.updated_at>bs.updated_at AND ${pendingClause}`,
    wsParams(),
  )
  // (d) server-ahead-undrained: server newer & content differs, nothing queued. Normally
  //     transient (observer drains it); a persistent count is a Layout-B drain problem.
  const serverAheadUndrained = await countOf(
    `SELECT count(*) AS n FROM blocks b JOIN blocks_synced bs ON bs.id=b.id
     WHERE ${wsClause('b.workspace_id')} AND bs.updated_at>b.updated_at AND ${pendingClause}
       AND (b.content!=bs.content OR b.properties_json!=bs.properties_json
            OR b.references_json!=bs.references_json OR b.deleted!=bs.deleted)`,
    wsParams(),
  )

  const sampleDivergence = async (where) =>
    rows(
      `SELECT b.id, b.updated_at AS local_updated_at, bs.updated_at AS synced_updated_at
       FROM blocks b JOIN blocks_synced bs ON bs.id=b.id
       WHERE ${wsClause('b.workspace_id')} AND ${where} AND ${pendingClause}
       LIMIT ${sampleLimit}`,
      wsParams(),
    )

  // Stranded + standoff + local-richer are real anomalies; server-ahead is informational.
  record(
    'local_server_divergence',
    strandedLocalOnly + equalStampStandoff + localRicherNoPending > 0,
    {
      strandedLocalOnly,
      equalStampStandoff,
      localRicherNoPending,
      serverAheadUndrained,
      samples: {
        equalStampStandoff: await sampleDivergence(
          'b.updated_at=bs.updated_at AND b.updated_at!=0 AND b.content!=bs.content',
        ),
        localRicherNoPending: await sampleDivergence('b.updated_at>bs.updated_at'),
      },
    },
  )
} catch (e) {
  skip('local_server_divergence', String(e))
}

return report
