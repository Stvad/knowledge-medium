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

A token is orphaned iff **the live registry does not publish it**. That is the
definition, and the script applies it directly: collect every distinct `types`
token in the workspace, then keep the ones missing from `repo.types`.

It is tempting to infer this from the token's *shape* instead — a user type's
token is a uuid-shaped block id, a seeded type's is a short string like `todo` —
but that heuristic is wrong in both directions. It misses a user type whose
definition block carries a caller-supplied non-uuid id (an import can mint its
own), reading that block id as though it were a seeded token; and it would
misjudge any future seeded id that happened to look like a uuid. `repo.types`
already holds every resolvable token, so no guessing is needed.

The enumeration reads `properties_json` directly rather than joining
`block_types`, which is also deliberate: `block_types` excludes deleted rows, so
it cannot see a token stranded on a soft-deleted member — one that comes back
the moment the user restores the block.

Each token is reported with a `type_state` of `no-row`, `tombstoned`, or
`live-but-unpublished` (a definition block that exists but fails to publish, e.g.
a `block-type` row with an empty label — visible in the audit, never
auto-repaired).

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
