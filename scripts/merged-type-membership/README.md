# Type memberships orphaned by a merge — audit & repair

A block's type membership is a **token in its `types` property**, and for a
user-defined type that token *is* the definition block's id. Merging a block
that was a type definition tombstones it (`mergeBlocksInTx`,
`src/data/blockMerge.ts`; the easy route there is the alias-collision
"Merge into…" flow in `src/plugins/alias/collisionMerge.ts`) — and before
`core.retargetMergedTypeMembership` existed, nothing moved that token onto the
survivor.

The result is silent: every block tagged with the merged-away type keeps an id
that resolves through nothing, because `blockIdByTypeId`
(`src/data/typeDefinitionRegistry.ts`) only ever binds ids of LIVE definition
rows. Those blocks lose their chip, their lifted properties, and their place in
every by-type query, while still *looking* tagged in the raw data.

Nothing self-heals it. `types` is independent stored state, not a derived mirror
of content: the `#type` gesture writes the property and deliberately leaves
content alone (`src/plugins/supertags/codeMirrorExtensions.ts`, `applyTag`), and
the only other writers are the explicit `TypeTagger` entry points. So a
membership orphaned by a pre-fix merge stays orphaned until repaired here.

Seeded types (`page`, `todo`, …) are **not** affected — their token is a short
stable string that resolves from the code declaration with no backing block at
all, so there is nothing to dangle.

## Fixed going forward

`src/data/internals/mergeTypeMembershipProcessor.ts` is a kernel same-tx
processor on `core.blockMerged`: it finds members through the trigger-maintained
`block_types` index and retargets each token onto the survivor, inside the merge
transaction. This directory is only for data orphaned *before* that landed.

## Detecting

A uuid-shaped `types` token with no live block behind it is orphaned. The uuid
shape is what separates a user type (token = block id) from a seeded type:

```sql
WITH tok AS (
  SELECT b.id AS member_id, b.deleted AS member_deleted, je.value AS token
  FROM blocks b, json_each(b.properties_json, '$.types') je
  WHERE b.workspace_id = ?1 AND json_valid(b.properties_json)
    AND typeof(je.value) = 'text' AND length(je.value) = 36
    AND je.value GLOB '[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*'
)
SELECT tok.token,
       CASE WHEN t.id IS NULL THEN 'no-row' ELSE 'tombstoned' END AS type_state,
       COALESCE(t.content, '') AS tombstone_content,
       SUM(CASE WHEN tok.member_deleted = 0 THEN 1 ELSE 0 END) AS live_members
FROM tok
LEFT JOIN blocks t ON t.id = tok.token AND t.workspace_id = ?1
WHERE t.id IS NULL OR t.deleted = 1
GROUP BY tok.token
ORDER BY live_members DESC
```

Reading `properties_json` directly rather than joining `block_types` is
deliberate: `block_types` excludes deleted rows, so it cannot see a token
stranded on a soft-deleted member — one that comes back the moment the user
restores the block.

**As of 2026-07-30 this returns zero rows on the primary workspace** (checked
across all three workspaces on the client, for live and deleted members alike).
The five tombstoned type definitions from the reported incident — `Person` ×2,
`Dance`, `Dancer`, `Author` — have no surviving members: in each case the
tombstoned side was a hand-created type block, and the members were already
tagged with the deterministic alias-seat block that survived.

## Resolving a destination

Two sources, in order of trust:

1. **`command_events`** — `core.merge` / `alias.mergeCollision` record
   `{intoId, fromId}` verbatim in `mutator_calls`, so the mapping is exact.
   Chains are followed (a survivor can itself have been merged away later).
   Note the retention limit: that table is compacted, and the incident above
   predates its oldest row by ~11 days, so an old merge may not be recoverable
   this way.
2. **The tombstone's own names** — an alias-collision merge unions the aliases
   onto the survivor, so the dead type's name is normally claimed by it. This is
   the same "merge survivor" signature `scripts/dangling-refs/README.md` uses for
   dangling references. Accepted only on a **unique** match, and only when asked
   for explicitly (`allowHeuristic: true`).

Anything else is reported as unresolved rather than guessed.

## Script

`repair.eval.js` — an agent-bridge eval script (`**/*.eval.js` is the ESLint
carve-out for these: the bridge wraps the body in an async function, so
top-level `await`/`return` are expected and it isn't a standalone module).

```bash
# audit only — writes nothing (DEFAULT)
pnpm agent --profile <profile> eval --file scripts/merged-type-membership/repair.eval.js

# apply, after reading the plan. SAVE the printed `journal` — it is the undo record.
pnpm agent --profile <profile> eval --file scripts/merged-type-membership/repair.eval.js \
  --data-json '{"apply": true}'

# preview a revert from a saved journal
pnpm agent --profile <profile> eval --file scripts/merged-type-membership/repair.eval.js \
  --data journal.json

# perform that revert
pnpm agent --profile <profile> eval --file scripts/merged-type-membership/repair.eval.js \
  --data-json '{"apply": true, "revert": <journal array>}'
```

Options: `apply` (default false), `limit` (default 500), `allowHeuristic`
(default false), `revert`, `force`.

### Safety properties

- Scoped to `repo.activeWorkspaceId`; aborts if nothing is pinned, and every
  query filters on it — an unopened workspace is never touched.
- Dry-run by default. No write happens without `apply: true`.
- Writes go through `repo.setBlockTypes`, not raw SQL, so each member is one
  `repo.tx` under `ChangeScope.BlockDefault`: it lands in `row_events`, is
  undoable in-app, and syncs like any user edit. That path also **refuses** to
  write a token the type registry can't resolve — the very invariant being
  restored — so a mis-resolved destination fails loudly instead of writing
  another dangling token.
- Reversible two ways: the printed journal replays the exact prior lists (and
  refuses to clobber anything edited since the repair unless `force: true`), and
  every individual write is undoable in-app.
- A destination that is not itself a type definition is reported and skipped, so
  a repair can't quietly move members onto a plain page.
- A malformed `types` cell is reported, never rewritten — `getBlockTypes` throws
  on it, which would abort the write transaction.
