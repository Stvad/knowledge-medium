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
 *  - Repairs go through `repo.setBlockTypes`, not raw SQL: each member is one
 *    `repo.tx` under `ChangeScope.BlockDefault`, so it lands in `row_events`,
 *    on the undo stack, and syncs like any user edit. It also REFUSES to write
 *    a token the type registry cannot resolve — the very invariant being
 *    restored — so a mis-resolved destination fails loudly instead of writing
 *    another dangling token. (The REVERT path is the one exception; see below.)
 *  - Never guesses. A destination is used only when `command_events` records
 *    the merge, or when exactly ONE live type definition matches the
 *    tombstone's alias/label. Anything else is reported as unresolved.
 *  - Reversible two ways: the printed `journal` replays exact prior values via
 *    mode 3 above, and each write is independently undoable in-app. The revert
 *    writes the cell DIRECTLY rather than through `setBlockTypes`, because that
 *    validates newly-added tokens and a revert restores the pre-repair list —
 *    which by definition holds the dangling token the registry does not know.
 *    It re-checks the current value inside its own tx before overwriting.
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
// `>= 0` matters: `slice(0, -1)` would write every eligible member except the
// last, turning a cap that reads like "touch at most N" into "touch all but N".
const LIMIT = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : 500
const ALLOW_HEURISTIC = options.allowHeuristic === true

const workspaceId = repo.activeWorkspaceId
if (!workspaceId) {
  return {error: 'No active workspace is pinned; refusing to run. Open the workspace first.'}
}

const jsonOf = raw => { try { return JSON.parse(raw) } catch { return null } }
/** A row's alias list, tolerating every malformed shape. Imported/sync-applied
 *  data can store `alias` as an object or a number, and both `for...of` and
 *  spread over that THROW — during audit-plan construction, so one malformed
 *  row would abort the whole tool including for unrelated actionable tokens.
 *  ONE helper because fixing only the site that was reported left the sibling
 *  line carrying the identical crash. */
const aliasList = raw => { const v = jsonOf(raw); return Array.isArray(v) ? v : [] }

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
    // NOT `setBlockTypes`: it validates every newly-added token against the
    // registry (`requireTypeContribution`) and throws for an unregistered one.
    // A revert restores the PRE-repair list, which by definition contains the
    // dangling token that is absent from `repo.types` — so the validated path
    // can never replay this tool's own journal, and would abort on the first
    // normal entry. Restoring a previously-recorded state is exactly the case
    // where that validation is wrong, so write the cell directly, in a
    // BlockDefault tx so it stays undoable and syncs like any user edit.
    //
    // The equality check above is a fast pre-filter only — between that query
    // and this tx, a sync update or another window can change the cell, and
    // overwriting it here would be exactly the clobber the check advertises
    // against. So re-check INSIDE the tx, against the tx's own read, and let
    // that be the authority.
    const outcome = await repo.tx(async tx => {
      const current = await tx.get(entry.blockId)
      if (!current || current.deleted) return {skipped: 'not a live block in this workspace'}
      const inTx = current.properties?.types
      if (options.force !== true &&
          JSON.stringify(inTx) !== JSON.stringify(entry.after)) {
        return {skipped: 'types changed since the repair', current: inTx, expected: entry.after}
      }
      await tx.update(entry.blockId, {
        properties: {...current.properties, types: [...entry.before]},
      })
      return {restored: entry.before}
    }, {scope: 'block-default', description: 'revert merged-type-membership repair'})
    restored.push({blockId: entry.blockId, ...outcome})
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
// Orphaned means exactly "the live registry does not publish this token" — so
// ask the registry, rather than inferring it from the token's SHAPE. A
// uuid-shape filter gets this wrong in both directions: it misses a user type
// whose definition block carries a caller-supplied non-uuid id (imports can
// mint their own) and reads that block id as if it were a seeded short id, and
// it would misjudge any future seeded id that happened to look like a uuid.
// `repo.types` already holds every resolvable token — seeded ids synthesized
// from code declarations plus every live block-backed type.
const allTokens = await sql(`
  WITH tok AS (
    SELECT b.id AS member_id, b.deleted AS member_deleted, je.value AS token
    FROM blocks b, json_each(b.properties_json, '$.types') je
    WHERE b.workspace_id = ? AND json_valid(b.properties_json)
      AND typeof(je.value) = 'text'
  )
  SELECT tok.token,
         CASE WHEN t.id IS NULL THEN 'no-row'
              WHEN t.deleted = 1 THEN 'tombstoned'
              ELSE 'live-but-unpublished' END AS type_state,
         COALESCE(t.content, '') AS tombstone_content,
         COALESCE(json_extract(t.properties_json, '$."block-type:label"'), '') AS tombstone_label,
         COALESCE(json_extract(t.properties_json, '$.alias'), '') AS tombstone_aliases,
         SUM(CASE WHEN tok.member_deleted = 0 THEN 1 ELSE 0 END) AS live_members,
         SUM(CASE WHEN tok.member_deleted = 1 THEN 1 ELSE 0 END) AS deleted_members
  FROM tok
  LEFT JOIN blocks t ON t.id = tok.token AND t.workspace_id = ?
  GROUP BY tok.token
  ORDER BY live_members DESC`, [workspaceId, workspaceId])

const publishedTypes = repo.types ?? new Map()
if (publishedTypes.size === 0) {
  return {error: 'repo.types is empty — the type registry has not published yet. Retry once the client has settled.'}
}
const dangling = allTokens.filter(row => !publishedTypes.has(row.token))

if (dangling.length === 0) {
  return {mode: 'audit', workspaceId, dangling: 0, note: 'No orphaned type memberships found. Nothing to repair.'}
}

// ── 2. resolve each dangling token to a destination ───────────────────────
/** Exact resolution: the recorded merge that tombstoned this block. Chains are
 *  followed (a survivor can itself have been merged away later) with a cycle
 *  guard and a hop cap.
 *
 *  OLDEST match first, deliberately. `mergeBlocksInTx` no-ops when the source is
 *  already tombstoned, but the mutator call is still recorded — so a retry of an
 *  already-completed merge (the alias-collision button re-firing, #188) leaves a
 *  LATER row naming a different, never-applied destination. Newest-first would
 *  prefer exactly that phantom and retag members somewhere they never lived; the
 *  earliest call naming this source is the one that actually moved it. */
const resolveFromCommandLog = async token => {
  const hops = []
  const seen = new Set([token])
  let current = token
  for (let i = 0; i < 10; i++) {
    const rows = await sql(`
      SELECT mutator_calls, created_at FROM command_events
      WHERE workspace_id = ? AND mutator_calls LIKE ?
      ORDER BY created_at ASC LIMIT 20`,
      // `JSON.stringify`, not raw interpolation: an id containing `"` or `\\`
      // is stored ESCAPED in `mutator_calls`, so the raw form would never match
      // and the token would be reported unresolved despite having provenance.
      [workspaceId, `%"fromId":${JSON.stringify(current)}%`])
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
  // `Array.isArray`, not `?? []`: imported/sync-applied data can store `alias`
  // as an object or a number, and `for...of` over that THROWS. This runs while
  // building every audit entry, so one malformed tombstone would abort the
  // whole tool — including for unrelated, perfectly actionable tokens.
  for (const a of aliasList(row.tombstone_aliases)) {
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
    const own = [c.content, c.label, ...aliasList(c.aliases)]
    return own.some(n => typeof n === 'string' && names.has(n.trim().toLowerCase()))
  })
  if (matches.length !== 1) {
    return {destination: null, confidence: 'ambiguous-name-match', candidates: matches.map(m => m.id)}
  }
  return {destination: matches[0].id, confidence: 'name-match', matchedName: matches[0].content}
}

/** Definition block id → the token that block's type is actually PUBLISHED
 *  under, read straight off the live registry.
 *
 *  Deliberately not a second implementation of the §9 claim rule. Deciding it
 *  here from `block-type:type-id` + `seed:key` means re-deriving, in SQL, a
 *  rule whose real form includes the deterministic seed-id equation
 *  (`seededDefinitionKey`) — checking only the key's GRAMMAR would honor a
 *  claim the runtime demotes (reachable via a cross-workspace paste or an
 *  import), and the repair would then write a token nothing resolves: the very
 *  bug being fixed. `blockIdByTypeId` is the runtime's own answer, so agreement
 *  is structural rather than maintained by hand. */
const typeIdByBlockId = new Map()
for (const [typeId, blockId] of (repo.typeDefinitions?.blockIdByTypeId ?? new Map())) {
  typeIdByBlockId.set(blockId, typeId)
}

const destinationToken = async id => {
  const row = await sql(`
    SELECT b.id, b.content,
           COALESCE(json_extract(b.properties_json, '$."block-type:label"'), '') AS label
    FROM blocks b WHERE b.id = ? AND b.workspace_id = ? AND b.deleted = 0`,
    [id, workspaceId], 'optional')
  if (!row) return null
  const token = typeIdByBlockId.get(id)
  // No registry binding = this block is not a published type. Reported as
  // blocked below rather than repaired, so a destination that only LOOKS like a
  // type definition can't absorb members.
  return {token: token ?? null, isType: token !== undefined, label: row.label || row.content}
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
  // A token whose definition block is LIVE is never repaired by retargeting,
  // however old a merge record names it. `live-but-unpublished` means the block
  // is back (restored, or recreated at the same id) and merely failing to
  // publish — an empty label, say. Moving its current members to a historical
  // survivor on the strength of a stale merge row would be a fresh data loss;
  // the fix is to make that definition publish again.
  if (entry.type_state === 'live-but-unpublished') {
    entry.blocked = 'definition block is live but unpublished — fix the definition (e.g. give it a label) instead of retargeting its members'
  }
  entry.actionable = Boolean(entry.destination) && !entry.blocked &&
    (entry.confidence === 'command-log' || (ALLOW_HEURISTIC && entry.confidence === 'name-match'))
  plan.push(entry)
}

// ── 3. build the per-member work list ─────────────────────────────────────
// Keyed by MEMBER, not by token. `setBlockTypes` replaces the whole list, so a
// block carrying two orphaned tokens (tagged with both `Dancer` and `Dance`
// when each was merged away) must have both mappings folded into ONE write:
// emitting a work item per token would compute each `after` from the same
// original `before`, and the second write would revert the first token's repair
// while the journal recorded two conflicting `before` lists for one block.
const byMember = new Map()
for (const entry of plan.filter(p => p.actionable)) {
  const members = await sql(`
    SELECT b.id, json_extract(b.properties_json, '$.types') AS types
    FROM blocks b
    JOIN block_types bt ON bt.block_id = b.id AND bt.workspace_id = b.workspace_id
    WHERE b.workspace_id = ? AND b.deleted = 0 AND bt.type = ?
    ORDER BY b.created_at, b.id`, [workspaceId, entry.token])
  // Tombstoned members carry the same orphaned token but are invisible to
  // `block_types`, and `setBlockTypes` refuses to write to a deleted row
  // (it no-ops by contract), so this tool CANNOT repair them — restoring one
  // resurrects the orphaned membership unchanged. Surface them explicitly
  // instead of leaving them out of the plan entirely: silence here reads as
  // "nothing left to do", which is exactly wrong. The runtime processor now
  // handles this case for merges going forward.
  const tombstoned = await sql(`
    SELECT id, json_extract(properties_json, '$.types') AS types FROM blocks
    WHERE workspace_id = ? AND deleted = 1 AND properties_json LIKE ?
    ORDER BY created_at, id`, [workspaceId, `%${JSON.stringify(entry.token)}%`])
  for (const dead of tombstoned) {
    // The `LIKE` matches the token ANYWHERE in the bag — a ref property holding
    // the same id counts — so recheck the actual `types` cell, the way the
    // runtime processor's equivalent prefilter does. Without this the tool tells
    // you to restore a block that was never a member.
    const deadTypes = jsonOf(dead.types)
    if (!Array.isArray(deadTypes) || !deadTypes.includes(entry.token)) continue
    const existing = byMember.get(dead.id)
    // Don't let the first token seen suppress a later real one: accumulate.
    if (existing) { if (!existing.tokens.includes(entry.token)) existing.tokens.push(entry.token); continue }
    byMember.set(dead.id, {
      blockId: dead.id, tokens: [entry.token],
      skipped: 'member is tombstoned — restore it, then re-run to repair',
    })
  }
  for (const member of members) {
    let item = byMember.get(member.id)
    if (!item) {
      const before = jsonOf(member.types)
      // Only a well-formed string list is rewritten. A malformed cell is reported
      // for separate handling — `getBlockTypes` throws on it, which would abort
      // the write tx (the same reason the merge processor skips these).
      item = (!Array.isArray(before) || before.some(t => typeof t !== 'string'))
        ? {blockId: member.id, tokens: [], skipped: 'types cell is not a string list', before}
        : {blockId: member.id, tokens: [], before, after: [...before]}
      byMember.set(member.id, item)
    }
    item.tokens.push(entry.token)
    if (item.skipped) continue
    // Fold this mapping onto the running `after`, so successive entries compose.
    const mapped = []
    for (const t of item.after) {
      const to = t === entry.token ? entry.destination_token : t
      if (!mapped.includes(to)) mapped.push(to)
    }
    item.after = mapped
  }
}
const work = [...byMember.values()]

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
