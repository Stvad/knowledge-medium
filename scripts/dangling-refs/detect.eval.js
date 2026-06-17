// Dangling-reference detector (READ-ONLY).
//
// A dangling ref is a `block_references` row whose `target_id` has no
// non-deleted `blocks` row — the source still points at a target that was
// deleted or never existed. `block_references` is a local, trigger-maintained
// index over `blocks.references_json`, so this reflects each source block's
// derived references.
//
// Run via the agent bridge (the target tab must be focused/connected):
//   yarn agent --profile <profile> eval --file scripts/dangling-refs/detect.eval.js
//   ... --data-json '{"workspaceId":"…"}'   # scope (defaults to the active one)
//
// Each ref is tagged with how it is expressed so callers can reason about
// re-point-vs-leave. Overlaps with the broader integrity sweep (task_8d697142)
// — kept narrow on purpose; that task owns the general scan.

const workspaceId = data?.workspaceId ?? repo.activeWorkspaceId
if (!workspaceId) throw new Error('no workspaceId: no active workspace and none passed via --data-json')

const dangling = await sql(
  `
  SELECT br.source_id, br.target_id, br.alias, br.source_field,
         (SELECT b.deleted FROM blocks b WHERE b.id = br.target_id) AS target_deleted,
         substr((SELECT s.content FROM blocks s WHERE s.id = br.source_id), 1, 120) AS source_content
  FROM block_references br
  WHERE br.workspace_id = ?
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.id = br.target_id AND b.deleted = 0)
  ORDER BY br.target_id, br.source_id`,
  [workspaceId],
  'all',
)

// How the ref is expressed (does NOT decide fate — that needs survivor lookup):
//   property : source_field set (typed ref-valued property, e.g. `location`)
//   blockref : ((id)) — alias === target_id (literal id baked into content)
//   wikilink : [[alias]] — alias differs from target_id (resolves via alias)
const kindOf = r => (r.source_field ? `property:${r.source_field}` : r.alias === r.target_id ? 'blockref' : 'wikilink')

const byTarget = new Map()
for (const r of dangling) {
  const t = byTarget.get(r.target_id) ?? {
    target_id: r.target_id,
    target_state: r.target_deleted === null ? 'missing' : r.target_deleted ? 'deleted' : 'live(?)',
    sources: [],
  }
  t.sources.push({source_id: r.source_id, kind: kindOf(r), alias: r.alias, content: r.source_content})
  byTarget.set(r.target_id, t)
}

return {
  workspaceId,
  danglingRefs: dangling.length,
  danglingTargets: byTarget.size,
  targets: [...byTarget.values()].sort((a, b) => b.sources.length - a.sources.length),
}
