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

## Fixed, and there is nothing to repair

`src/data/internals/mergeTypeMembershipProcessor.ts` is a kernel same-tx
processor on `core.blockMerged`: it finds members through the trigger-maintained
`block_types` index (plus a sweep for tombstoned members, which that index cannot
see) and retargets each token onto the survivor inside the merge transaction.

Ownership is judged against the tx-start type registry, because carrying the
`block-type` tag is not ownership. Note that *unowned* and *owned by someone
else* are different answers and get opposite treatment:

- the token is owned by a DIFFERENT block than the merged-away source →
  **refuse**, since those members are somebody else's;
- the replacement token is owned by a DIFFERENT block than the survivor →
  **refuse**, rather than mint membership in a type the survivor does not own;
- either token is owned by NOBODY — an unpublished source such as a label-less
  `block-type` row, or a survivor that is not a type definition at all →
  **proceed**, and retarget onto the survivor. Dropping membership is
  unrecoverable, while a token naming a live block is undoable with the merge
  and becomes real membership if that block is later made a type. Pinned by
  `retargets onto a non-type survivor instead of dropping membership`.

The registry must also be present for this tx's workspace; without one, ownership
is unverifiable and the retarget is skipped entirely.

**There is no repair script.** One existed on this branch and was dropped: the
production audit found **zero** orphaned memberships (2026-07-30, re-verified
2026-09-10 — a window that includes the six weeks the forward fix sat unmerged,
during which a type merge would have created fresh ones). It was speculative
tooling for damage that does not exist, and being an agent-bridge `.eval.js` it
sat outside `pnpm run check` entirely, so every change to it shipped unverified.
If orphans ever do appear, write the repair then — against real data, under the
gate, and as a proper `WorkspaceBackfill` so it carries the per-graph claim and
freshness guard a source-of-truth migration needs (`bd recall
reference_oneshot_passes_two_kinds`).

## Detecting

A token is orphaned iff **the live registry does not publish it**: collect every
distinct `types` token in the workspace, then keep the ones missing from
`repo.types`.

Do not infer this from the token's *shape*. A user type's token is a uuid-shaped
block id and a seeded type's is a short string like `todo`, but that heuristic is
wrong in both directions — it misses a user type whose definition block carries a
caller-supplied non-uuid id, and would misjudge a seeded id that happened to look
like a uuid.

The SQL below over-reports on its own, which is the trap, and it does so in TWO
ways. Seeded and plugin type ids (`readwise-book`, `system-plugins-prefs`, …)
legitimately have no block at their token and show as `no-row` while being
perfectly healthy. And a `tombstoned` row at a token does not prove the token is
orphaned either: an imported ordinary block can occupy a seeded id such as
`page`, be merged away, and leave a tombstone sitting at a token whose type is
still published from code — so the query joins that tombstone to every healthy
`page` member and reports them all as damaged. That is the same ownership
collision the processor now refuses.

So treat every row this returns as a CANDIDATE, and confirm against
`repo.types` before believing any of it. There is no unambiguous SQL-only
signal.

```sql
WITH tok AS (
  -- DISTINCT: a valid string-list can repeat a token (the codec allows it, and
  -- raw/imported rows do), and `json_each` emits one row per occurrence, which
  -- would count one block as several members. `block_types` dedupes, but this
  -- deliberately bypasses it to see tombstones.
  SELECT DISTINCT b.id AS member_id, b.deleted AS member_deleted, je.value AS token
  FROM blocks b, json_each(b.properties_json, '$.types') je
  WHERE b.workspace_id = ?1
    AND json_valid(b.properties_json) AND typeof(je.value) = 'text'
)
SELECT tok.token,
       CASE WHEN t.id IS NULL THEN 'no-row'
            WHEN t.deleted = 1 THEN 'tombstoned'
            ELSE 'live' END AS type_state,
       COALESCE(t.content, '') AS name,
       SUM(CASE WHEN tok.member_deleted = 0 THEN 1 ELSE 0 END) AS live_members,
       SUM(CASE WHEN tok.member_deleted = 1 THEN 1 ELSE 0 END) AS dead_members
FROM tok
LEFT JOIN blocks t ON t.id = tok.token AND t.workspace_id = ?1
GROUP BY tok.token, type_state
ORDER BY live_members DESC
```

Two predicates that are easy to drop and change the answer: scope the CTE to
ONE workspace (`repo.types` only describes the active one, so tokens from
another workspace would be judged against the wrong registry, with member
counts merged across both), and LEFT join the token's block — an inner join
requiring a tombstone silently discards every `no-row` token, which is exactly
the hard-deleted-definition case, and would report no damage where there is
some.

Read `properties_json` directly rather than joining `block_types`: that index
excludes deleted rows, so it cannot see a token stranded on a soft-deleted member
— one that comes back the moment the block is restored.

## If you ever need to resolve a destination

Two sources, in order of trust. `command_events` records `core.merge`
(`{intoId, fromId}`) and `alias.mergeCollision` (`{intoId, fromIds: [...]}`)
verbatim — note the plural, since the alias flow folds several sources at once.
That table is compacted, so an old merge may be unrecoverable. Otherwise the
tombstone's own names: an alias-collision merge unions aliases onto the survivor,
the same "merge survivor" signature `scripts/dangling-refs/README.md` uses for
dangling references. Match names EXACTLY — alias ownership is exact in the data
layer (`ba.alias = ?`), and `alias_lower` exists because case-insensitivity is an
autocomplete concern, not an identity one.
