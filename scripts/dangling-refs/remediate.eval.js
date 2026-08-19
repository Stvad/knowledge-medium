// Re-point MERGED dangling references onto their live survivor. DRY-RUN BY DEFAULT.
//
// Run via the agent bridge (the target tab must be focused/connected):
//   DRY-RUN (default — reports the plan, writes nothing):
//     pnpm agent --profile <profile> eval --file scripts/dangling-refs/remediate.eval.js
//   APPLY (performs the writes — HELD until explicitly approved):
//     pnpm agent --profile <profile> eval --file scripts/dangling-refs/remediate.eval.js \
//       --data-json '{"apply":true}'
//   Scope to a specific workspace (defaults to the active one):
//     ... --data-json '{"apply":true,"workspaceId":"<workspace-id>"}'
//
// Policy (see README.md). A dangling ref's target is classified off the LIVE,
// converged alias table:
//   MERGE SURVIVOR — a live block (≠ target) carries one of the dead target's
//                    own aliases. The ref is *mis-pointed*; re-point it.
//   FAITHFUL-DEAD  — genuine deletion / missing target, no survivor. LEAVE (the
//                    source faithfully points at a gone thing; cleaning it would
//                    edit what the user wrote).
//
// What we re-point (and why only these):
//   wikilink `[[alias]]` → rewrite references_json id to the survivor; the alias
//     is preserved and the user's `[[alias]]` text is untouched. It stays
//     re-pointed because the survivor carries that alias (reprojection re-resolves
//     to it). `block_references` is a local trigger-index over references_json, so
//     the synced write IS the references_json edit; every client re-derives.
//   property `field::ref` → rewrite the property VALUE to the survivor id via
//     setProperty; the parse processor then reprojects the ref. (Re-pointing only
//     references_json would be reverted on the next reprojection because the raw
//     id still lives in properties_json.)
//
// What we deliberately LEAVE even when a survivor exists:
//   block-ref `((id))` — the literal id is baked into the source content, so
//     re-pointing references_json alone is not durable (reprojection re-derives
//     the id) and re-pointing durably would mean rewriting the user's content.
//
// Idempotent: a ref already on the survivor produces no write. Safe to re-run.

const {normalizeReferences, ChangeScope} = await import('@/data/api')

const apply = data?.apply === true
const workspaceId = data?.workspaceId ?? repo.activeWorkspaceId
if (!workspaceId) throw new Error('no workspaceId: no active workspace and none passed via --data-json')

// sourceField → loader for the typed property schema setProperty needs. Only
// fields listed here are auto-re-pointed; an unknown ref-property is reported,
// never guessed.
const PROPERTY_SCHEMA_LOADERS = {
  location: async () => (await import('@/plugins/geo/properties.ts')).locationProp,
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 1. Detect ──────────────────────────────────────────────────────────────
const detect = async () =>
  sql(
    `
    SELECT br.source_id, br.target_id, br.alias, br.source_field
    FROM block_references br
    WHERE br.workspace_id = ?
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.id = br.target_id AND b.deleted = 0)
    ORDER BY br.target_id, br.source_id`,
    [workspaceId],
    'all',
  )

const dangling = await detect()

// ── 2. Classify targets: merge survivor vs faithful-dead ─────────────────────
// Survivor = a LIVE block (≠ target) reachable by one of the dead target's own
// aliases. Resolved against the live alias table (the converged view).
const targetIds = [...new Set(dangling.map(r => r.target_id))]
const survivorByTarget = new Map()
for (const tid of targetIds) {
  const tgt = await sql(`SELECT properties_json FROM blocks WHERE id = ?`, [tid], 'optional')
  let survivor = null
  if (tgt) {
    const aliases = JSON.parse(tgt.properties_json || '{}').alias || []
    for (const a of aliases) {
      const hit = await repo.query.aliasLookup({workspaceId, alias: a}).load()
      if (hit && hit.id !== tid && !hit.deleted) {
        survivor = {id: hit.id, viaAlias: a}
        break
      }
    }
  }
  survivorByTarget.set(tid, survivor)
}

// ── 3. Plan ──────────────────────────────────────────────────────────────────
const kindOf = r => (r.source_field ? 'property' : r.alias === r.target_id ? 'blockref' : 'wikilink')

const plan = dangling.map(r => {
  const survivor = survivorByTarget.get(r.target_id)
  const kind = kindOf(r)
  if (!survivor) return {...r, kind, action: 'leave', reason: 'faithful-dead: no live survivor'}
  if (kind === 'blockref')
    return {...r, kind, survivor, action: 'leave', reason: 'block-ref by id: not durably re-pointable without content rewrite'}
  if (kind === 'property' && !PROPERTY_SCHEMA_LOADERS[r.source_field])
    return {...r, kind, survivor, action: 'leave', reason: `no schema loader for property '${r.source_field}'`}
  return {...r, kind, survivor, action: kind === 'property' ? 're-point-property' : 're-point-wikilink'}
})

const repoints = plan.filter(p => p.action.startsWith('re-point'))
const leaves = plan.filter(p => p.action === 'leave')

const summary = {
  mode: apply ? 'APPLY' : 'DRY-RUN',
  workspaceId,
  danglingRefs: dangling.length,
  rePointableCount: repoints.length,
  leftAsIsCount: leaves.length,
  rePoints: repoints.map(p => ({
    source_id: p.source_id,
    kind: p.kind === 'property' ? `property:${p.source_field}` : 'wikilink',
    from_target: p.target_id,
    to_survivor: p.survivor.id,
    via_alias: p.survivor.viaAlias,
  })),
  leftAsIs: leaves.map(p => ({source_id: p.source_id, target_id: p.target_id, kind: p.kind, reason: p.reason})),
}

if (!apply) return {...summary, note: 'DRY-RUN — no writes. Re-run with --data-json \'{"apply":true}\' to apply.'}

// ── 4. Apply ─────────────────────────────────────────────────────────────────
const results = {
  wikilink: {ok: 0, skip: 0, fail: 0, errors: []},
  property: {ok: 0, skip: 0, fail: 0, errors: []},
}

// 4a. Wikilink re-points: rewrite references_json id (alias preserved), per source.
const repointMap = new Map(repoints.filter(p => p.kind === 'wikilink').map(p => [p.target_id, p.survivor.id]))
const wikilinkSources = [...new Set(repoints.filter(p => p.kind === 'wikilink').map(p => p.source_id))]
for (const sourceId of wikilinkSources) {
  try {
    const block = await repo.load(sourceId)
    if (!block || block.deleted) {
      results.wikilink.skip += 1
      continue
    }
    const next = normalizeReferences(
      block.references.map(ref =>
        ref.sourceField === undefined && ref.alias !== ref.id && repointMap.has(ref.id)
          ? {id: repointMap.get(ref.id), alias: ref.alias}
          : ref,
      ),
    )
    if (JSON.stringify(next) === JSON.stringify(block.references)) {
      results.wikilink.skip += 1
      continue
    }
    await repo.tx(async tx => tx.update(sourceId, {references: next}, {skipMetadata: true}), {
      scope: ChangeScope.References,
      description: 'dangling-ref remediation: re-point wikilink to merge survivor',
    })
    results.wikilink.ok += 1
  } catch (err) {
    results.wikilink.fail += 1
    results.wikilink.errors.push({sourceId, why: String(err?.message ?? err)})
  }
}

// 4b. Property re-points: rewrite the property VALUE to the survivor id.
for (const p of repoints.filter(rp => rp.kind === 'property')) {
  try {
    const prop = await PROPERTY_SCHEMA_LOADERS[p.source_field]()
    const block = await repo.load(p.source_id)
    if (!block || block.deleted) {
      results.property.skip += 1
      continue
    }
    if (block.properties[p.source_field] === p.survivor.id) {
      results.property.skip += 1
      continue
    }
    await repo.tx(async tx => tx.setProperty(p.source_id, prop, p.survivor.id), {
      scope: ChangeScope.BlockDefault,
      description: 'dangling-ref remediation: re-point property to merge survivor',
    })
    results.property.ok += 1
  } catch (err) {
    results.property.fail += 1
    results.property.errors.push({sourceId: p.source_id, why: String(err?.message ?? err)})
  }
}

// ── 5. Verify ────────────────────────────────────────────────────────────────
// Property re-points reproject via the post-commit parse processor (async); poll
// until the re-pointed sources clear from the dangling set.
const repointedSourceIds = new Set(repoints.map(p => p.source_id))
let stillDangling = null
for (let i = 0; i < 20; i += 1) {
  stillDangling = (await detect()).filter(r => repointedSourceIds.has(r.source_id))
  if (stillDangling.length === 0) break
  await sleep(500)
}

const crud = await sql(`SELECT count(*) n FROM ps_crud`, [], 'get')
const newRefs = repoints.length
  ? await sql(
      `SELECT id, references_json FROM blocks WHERE id IN (${repoints.map(() => '?').join(',')})`,
      repoints.map(p => p.source_id),
      'all',
    )
  : []

return {
  ...summary,
  applyResults: results,
  verify: {
    repointedSourcesStillDangling: stillDangling,
    converged: stillDangling !== null && stillDangling.length === 0,
    pendingUploadQueue: crud.n,
    rePointedSources: newRefs,
  },
}
