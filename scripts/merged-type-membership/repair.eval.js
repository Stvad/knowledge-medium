/**
 * Repair type memberships orphaned by a block merge.
 *
 * Runs INSIDE the live app tab via the agent bridge:
 *
 *   # 1. audit only — writes nothing, prints the plan (DEFAULT)
 *   pnpm agent --profile <profile> eval --file scripts/merged-type-membership/repair.eval.js
 *
 *   # 2. apply, after reading the plan. Save the printed `journal` — it is the undo record.
 *   pnpm agent --profile <profile> eval --file scripts/merged-type-membership/repair.eval.js \
 *     --data-json '{"apply": true}'
 *
 *   # 3a. preview a revert, feeding back a journal from a previous apply
 *   pnpm agent --profile <profile> eval --file scripts/merged-type-membership/repair.eval.js \
 *     --data <journal.json>
 *
 *   # 3b. actually revert (a bare journal always previews; applying is explicit)
 *   pnpm agent --profile <profile> eval --file scripts/merged-type-membership/repair.eval.js \
 *     --data-json '{"apply": true, "revert": <journal array>}'
 *
 * WHAT IT REPAIRS
 * Merging a block that was a type definition tombstones it, but before the
 * `core.retargetMergedTypeMembership` same-tx processor existed nothing moved
 * the members' `types` tokens onto the survivor. Those members are silently
 * un-typed: no chip, no lifted properties, absent from every by-type query.
 * This finds them and moves each token to the survivor.
 *
 * SAFETY PROPERTIES
 *  - Scoped to `repo.activeWorkspaceId`. Aborts if no workspace is pinned, and
 *    every query filters on it, so an unopened workspace is never touched.
 *  - Dry-run by default. Nothing is written unless `apply: true` is passed.
 *  - Writes go through `repo.setBlockTypes`, not raw SQL: each member is one
 *    `repo.tx` under `ChangeScope.BlockDefault`, so it lands in `row_events`,
 *    on the undo stack, and syncs like any user edit. It also REFUSES to write
 *    a token the type registry cannot resolve — the very invariant being
 *    restored — so a mis-resolved destination fails loudly instead of writing
 *    another dangling token.
 *  - Never guesses. A destination is used only when `command_events` records
 *    the merge, or when exactly ONE live type definition matches the
 *    tombstone's alias/label. Anything else is reported as unresolved.
 *  - Reversible two ways: the printed `journal` replays exact prior values via
 *    mode 3 above, and each write is independently undoable in-app.
 *
 * Options (via --data / --data-json):
 *   apply:        false (default) → audit only; true → write.
 *   limit:        max members to touch in one run (default 500).
 *   allowHeuristic: false (default) → only merges recorded in `command_events`
 *                 are acted on; true → also act on unique alias/label matches.
 *   revert:       array of {blockId, before, after} — restores the `before`
 *                 lists, but only for members whose cell still holds exactly
 *                 what the repair wrote (`after`), so a later legitimate edit
 *                 is never clobbered. A journal from a previous apply is passed
 *                 directly. `force: true` skips that equality check.
 */

const options = data && !Array.isArray(data) ? data : {}
const revertEntries = Array.isArray(data) ? data : options.revert
const APPLY = options.apply === true
const LIMIT = Number.isInteger(options.limit) ? options.limit : 500
const ALLOW_HEURISTIC = options.allowHeuristic === true

const workspaceId = repo.activeWorkspaceId
if (!workspaceId) {
  return {error: 'No active workspace is pinned; refusing to run. Open the workspace first.'}
}

const UUID_GLOB = '[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*'
const jsonOf = raw => { try { return JSON.parse(raw) } catch { return null } }

// ── revert mode ───────────────────────────────────────────────────────────
if (revertEntries) {
  const restored = []
  for (const entry of revertEntries) {
    if (!entry || typeof entry.blockId !== 'string' || !Array.isArray(entry.before)) continue
    const row = await sql(
      `SELECT json_extract(properties_json, '$.types') AS types FROM blocks
       WHERE id = ? AND workspace_id = ? AND deleted = 0`,
      [entry.blockId, workspaceId], 'optional')
    if (!row) { restored.push({blockId: entry.blockId, skipped: 'not a live block in this workspace'}); continue }
    // Refuse to clobber an edit made SINCE the repair: only restore when the
    // cell still holds exactly what the repair wrote. `force: true` overrides.
    const current = jsonOf(row.types)
    const untouched = Array.isArray(entry.after) &&
      JSON.stringify(current) === JSON.stringify(entry.after)
    if (!untouched && options.force !== true) {
      restored.push({blockId: entry.blockId, skipped: 'types changed since the repair', current, expected: entry.after})
      continue
    }
    if (!APPLY) { restored.push({blockId: entry.blockId, would_restore: entry.before}); continue }
    await repo.setBlockTypes(entry.blockId, entry.before)
    restored.push({blockId: entry.blockId, restored: entry.before})
  }
  return {
    mode: APPLY ? 'revert-applied' : 'revert-preview (nothing written)',
    workspaceId,
    count: restored.length,
    restored,
    ...(APPLY ? {} : {next: 'Re-run with --data-json \'{"apply": true, "revert": <journal array>}\' to write.'}),
  }
}

// ── 1. find dangling membership tokens ────────────────────────────────────
// A user-defined type's membership token IS its definition block's id, so a
// uuid-shaped token with no live block behind it is orphaned. Seeded types
// (`page`, `todo`, …) use short string ids that legitimately have no block at
// `id = token`, which is exactly what the uuid shape filter excludes.
const dangling = await sql(`
  WITH tok AS (
    SELECT b.id AS member_id, b.deleted AS member_deleted, je.value AS token
    FROM blocks b, json_each(b.properties_json, '$.types') je
    WHERE b.workspace_id = ? AND json_valid(b.properties_json)
      AND typeof(je.value) = 'text' AND length(je.value) = 36
      AND je.value GLOB '${UUID_GLOB}'
  )
  SELECT tok.token,
         CASE WHEN t.id IS NULL THEN 'no-row' ELSE 'tombstoned' END AS type_state,
         COALESCE(t.content, '') AS tombstone_content,
         COALESCE(json_extract(t.properties_json, '$."block-type:label"'), '') AS tombstone_label,
         COALESCE(json_extract(t.properties_json, '$.alias'), '') AS tombstone_aliases,
         SUM(CASE WHEN tok.member_deleted = 0 THEN 1 ELSE 0 END) AS live_members,
         SUM(CASE WHEN tok.member_deleted = 1 THEN 1 ELSE 0 END) AS deleted_members
  FROM tok
  LEFT JOIN blocks t ON t.id = tok.token AND t.workspace_id = ?
  WHERE t.id IS NULL OR t.deleted = 1
  GROUP BY tok.token
  ORDER BY live_members DESC`, [workspaceId, workspaceId])

if (dangling.length === 0) {
  return {mode: 'audit', workspaceId, dangling: 0, note: 'No orphaned type memberships found. Nothing to repair.'}
}

// ── 2. resolve each dangling token to a destination ───────────────────────
/** Exact resolution: the recorded merge that tombstoned this block. Chains are
 *  followed (a survivor can itself have been merged away later) with a cycle
 *  guard and a hop cap. */
const resolveFromCommandLog = async token => {
  const hops = []
  const seen = new Set([token])
  let current = token
  for (let i = 0; i < 10; i++) {
    const rows = await sql(`
      SELECT mutator_calls, created_at FROM command_events
      WHERE workspace_id = ? AND mutator_calls LIKE ?
      ORDER BY created_at DESC LIMIT 20`,
      [workspaceId, `%"fromId":"${current}"%`])
    let next
    for (const row of rows) {
      const calls = jsonOf(row.mutator_calls)
      if (!Array.isArray(calls)) continue
      const call = calls.find(c =>
        (c?.name === 'core.merge' || c?.name === 'alias.mergeCollision') &&
        c?.args?.fromId === current && typeof c?.args?.intoId === 'string')
      if (call) { next = call.args.intoId; break }
    }
    if (!next || seen.has(next)) break
    hops.push({from: current, into: next})
    seen.add(next)
    current = next
    const live = await sql(
      'SELECT deleted FROM blocks WHERE id = ? AND workspace_id = ?',
      [current, workspaceId], 'optional')
    if (live && live.deleted === 0) return {destination: current, confidence: 'command-log', hops}
  }
  return hops.length > 0 ? {destination: null, confidence: 'command-log-dead-end', hops} : null
}

/** Fallback: the tombstone's own names. An alias-collision merge unions the
 *  aliases onto the survivor, so the tombstone's name is normally claimed by it.
 *  Accepted only on a UNIQUE match — several candidates means we cannot tell,
 *  and inventing a membership is worse than reporting it. */
const resolveFromNames = async row => {
  const names = new Set()
  for (const n of [row.tombstone_label, row.tombstone_content]) {
    if (typeof n === 'string' && n.trim()) names.add(n.trim().toLowerCase())
  }
  for (const a of jsonOf(row.tombstone_aliases) ?? []) {
    if (typeof a === 'string' && a.trim()) names.add(a.trim().toLowerCase())
  }
  if (names.size === 0) return null
  const candidates = await sql(`
    SELECT b.id, b.content,
           COALESCE(json_extract(b.properties_json, '$."block-type:label"'), '') AS label,
           COALESCE(json_extract(b.properties_json, '$.alias'), '[]') AS aliases
    FROM blocks b
    WHERE b.workspace_id = ? AND b.deleted = 0
      AND EXISTS (SELECT 1 FROM json_each(b.properties_json, '$.types') je WHERE je.value = 'block-type')`,
    [workspaceId])
  const matches = candidates.filter(c => {
    const own = [c.content, c.label, ...(jsonOf(c.aliases) ?? [])]
    return own.some(n => typeof n === 'string' && names.has(n.trim().toLowerCase()))
  })
  if (matches.length !== 1) {
    return {destination: null, confidence: 'ambiguous-name-match', candidates: matches.map(m => m.id)}
  }
  return {destination: matches[0].id, confidence: 'name-match', matchedName: matches[0].content}
}

/** Membership token of a destination row, by the §9 claim rule that
 *  `typeMembershipTokenFor` (src/data/typeDefinitionMetadata.ts) applies: a
 *  `block-type:type-id` differing from the block's own id counts only with
 *  valid `/type/` seed provenance, else the token is the block id. */
const destinationToken = async id => {
  const row = await sql(`
    SELECT b.id, b.content,
           COALESCE(json_extract(b.properties_json, '$."block-type:type-id"'), '') AS claimed,
           COALESCE(json_extract(b.properties_json, '$."seed:key"'), '') AS seed_key,
           COALESCE(json_extract(b.properties_json, '$."block-type:label"'), '') AS label,
           EXISTS (SELECT 1 FROM json_each(b.properties_json, '$.types') je WHERE je.value = 'block-type') AS is_type
    FROM blocks b WHERE b.id = ? AND b.workspace_id = ? AND b.deleted = 0`,
    [id, workspaceId], 'optional')
  if (!row) return null
  const isTypeSeedKey = typeof row.seed_key === 'string' && /^[^/]+\/type\/[^/]+$/.test(row.seed_key)
  const token = row.claimed && row.claimed !== row.id && isTypeSeedKey ? row.claimed : row.id
  return {token, isType: row.is_type === 1, label: row.label || row.content}
}

const plan = []
for (const row of dangling) {
  const resolution = await resolveFromCommandLog(row.token) ?? await resolveFromNames(row)
  const entry = {
    token: row.token,
    tombstone: row.tombstone_label || row.tombstone_content || '(name not recoverable)',
    type_state: row.type_state,
    live_members: row.live_members,
    deleted_members: row.deleted_members,
    confidence: resolution?.confidence ?? 'unresolved',
    destination: resolution?.destination ?? null,
  }
  if (resolution?.hops) entry.hops = resolution.hops
  if (resolution?.candidates) entry.candidates = resolution.candidates
  if (entry.destination) {
    const dest = await destinationToken(entry.destination)
    if (!dest) { entry.blocked = 'destination is not a live block in this workspace'; entry.destination = null }
    else {
      entry.destination_token = dest.token
      entry.destination_label = dest.label
      if (!dest.isType) entry.blocked = 'destination is not a type definition (would write another unresolvable token)'
    }
  }
  entry.actionable = Boolean(entry.destination) && !entry.blocked &&
    (entry.confidence === 'command-log' || (ALLOW_HEURISTIC && entry.confidence === 'name-match'))
  plan.push(entry)
}

// ── 3. build the per-member work list ─────────────────────────────────────
const work = []
for (const entry of plan.filter(p => p.actionable)) {
  const members = await sql(`
    SELECT b.id, json_extract(b.properties_json, '$.types') AS types
    FROM blocks b
    JOIN block_types bt ON bt.block_id = b.id AND bt.workspace_id = b.workspace_id
    WHERE b.workspace_id = ? AND b.deleted = 0 AND bt.type = ?
    ORDER BY b.created_at, b.id`, [workspaceId, entry.token])
  for (const member of members) {
    const before = jsonOf(member.types)
    // Only a well-formed string list is rewritten. A malformed cell is reported
    // for separate handling — `getBlockTypes` throws on it, which would abort
    // the write tx (the same reason the merge processor skips these).
    if (!Array.isArray(before) || before.some(t => typeof t !== 'string')) {
      work.push({blockId: member.id, token: entry.token, skipped: 'types cell is not a string list', before})
      continue
    }
    const after = []
    for (const t of before) {
      const mapped = t === entry.token ? entry.destination_token : t
      if (!after.includes(mapped)) after.push(mapped)
    }
    work.push({blockId: member.id, token: entry.token, before, after})
  }
}

const writable = work.filter(w => !w.skipped).slice(0, LIMIT)
const summary = {
  workspaceId,
  dangling_tokens: plan.length,
  actionable_tokens: plan.filter(p => p.actionable).length,
  members_to_change: writable.length,
  members_skipped: work.filter(w => w.skipped).length,
  truncated_by_limit: work.filter(w => !w.skipped).length - writable.length,
}

if (!APPLY) {
  return {
    mode: 'audit (nothing written)',
    summary,
    plan,
    sample_changes: writable.slice(0, 20),
    next: 'Re-run with --data-json \'{"apply": true}\' to write. Save the returned `journal` — it is the undo record. Add "allowHeuristic": true only after reviewing name-match entries.',
  }
}

// ── 4. apply ──────────────────────────────────────────────────────────────
const journal = []
const failures = []
for (const item of writable) {
  try {
    await repo.setBlockTypes(item.blockId, item.after)
    journal.push({blockId: item.blockId, before: item.before, after: item.after})
  } catch (error) {
    failures.push({blockId: item.blockId, error: String(error?.message ?? error)})
  }
}
return {
  mode: 'applied',
  summary: {...summary, written: journal.length, failed: failures.length},
  failures,
  revert_hint: 'Save `journal` to a file. `--data <file>` previews the revert; ' +
    '`--data-json \'{"apply": true, "revert": <journal>}\'` performs it. ' +
    'Every write is also individually undoable in-app.',
  journal,
}
