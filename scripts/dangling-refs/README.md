# Dangling references — detection, policy, remediation

A **dangling reference** is a `block_references` row whose `target_id` has no
non-deleted `blocks` row: a source block still points at a target that was
deleted or never existed.

`block_references` is a **local, trigger-maintained index** over
`blocks.references_json` (see `src/plugins/references/localSchema.ts`) — it is
NOT synced. The synced source of truth is `blocks.references_json` (content /
wikilink / block-ref + property refs) and `blocks.properties_json` (the raw
value behind a property ref). So the only durable, fleet-wide fix writes
`references_json` / `properties_json`; every client's trigger then re-derives
its own `block_references`.

## Classification & policy

Each dangling target's **fate** is read off server history (`blocks_history`,
`row_events`) and the live, converged alias table:

- **Merge survivor** — a live block (≠ the dead target) carries one of the dead
  target's own aliases (the signature of a page merge: the survivor absorbs the
  dead page's alias, often in the same transaction that deletes it). These refs
  are *mis-pointed*, not junk. **Re-point** them to the survivor.
- **Faithful-dead** — a genuine user/cleanup deletion, or a never-synced target,
  with no survivor. The source content faithfully points at a gone thing.
  **Leave** it: cleaning would edit what the user actually wrote. Surface as a
  report only. (If the dead target is a soft-deleted block the user wants back,
  that's a *restore*, not a clean — see below.)

Re-point mechanism depends on how the ref is expressed:

| Ref kind | Re-pointable? | How (durable) |
|---|---|---|
| `[[alias]]` wikilink | ✅ | rewrite `references_json` id → survivor; alias preserved, content untouched. Reprojection re-resolves the alias to the survivor, so it stays. |
| `field::ref` property | ✅ | rewrite the **property value** (`properties_json[field]`) → survivor id via `setProperty`; the parse processor reprojects the ref. (Re-pointing only `references_json` would be reverted on the next reprojection — the raw dead id still lives in `properties_json`.) |
| `((id))` block-ref | ❌ leave | the literal id is baked into the source **content**. Re-pointing `references_json` alone is not durable (reprojection re-derives the id from content); a durable fix would rewrite the user's content. |

## Scripts

Agent-bridge eval scripts (run against the live client; `**/*.eval.js` is
ESLint-ignored — the bridge wraps the body in an async fn with `repo` / `db` /
`sql` / `data` in scope). Detection and dry-runs are read-only; any write is
held behind an explicit `apply` flag.

```sh
# Read-only detector (reusable; overlaps integrity task_8d697142 — narrow on purpose)
yarn agent --profile <profile> eval --file scripts/dangling-refs/detect.eval.js

# Re-point merged refs — DRY-RUN by default (prints the plan, writes nothing)
yarn agent --profile <profile> eval --file scripts/dangling-refs/remediate.eval.js
# ... APPLY (writes synced data — hold for explicit approval)
yarn agent --profile <profile> eval --file scripts/dangling-refs/remediate.eval.js \
  --data-json '{"apply":true}'

# Restore soft-deleted targets the user wants back (pass the leaf ids)
yarn agent --profile <profile> eval --file scripts/dangling-refs/restore-deleted-blocks.eval.js \
  --data-json '{"leaves":["<id>","<id>"]}'                 # dry-run
yarn agent --profile <profile> eval --file scripts/dangling-refs/restore-deleted-blocks.eval.js \
  --data-json '{"apply":true,"leaves":["<id>","<id>"]}'     # apply
```

`remediate.eval.js`:
- re-derives the dangling set and classifies each target off the **live,
  converged alias table** (not hardcoded survivor ids), so it self-corrects and
  is safe to re-run;
- re-points only the wikilink + property refs of merge survivors; leaves
  block-refs and no-survivor targets;
- is **idempotent** (a ref already on the survivor → no write);
- after `apply`, verifies convergence: polls until the re-pointed sources clear
  from the dangling set, and reports the pending upload queue (`ps_crud`) and the
  new `references_json` of each re-pointed source.

`restore-deleted-blocks.eval.js`:
- for each passed leaf id, walks up to the first **live** ancestor and restores
  every deleted block on the way (leaf + its deleted ancestors), so the block is
  reachable in its original outline location rather than orphaned under a dead
  parent;
- `tx.restore(id)` with no patch preserves content / properties / references; the
  `deleted→0` trigger re-derives `block_references`;
- restores **one block per tx** — restoring several reference-bearing blocks in a
  single tx can hang the live client past the bridge response timeout;
- **idempotent** (already-live blocks skipped); dry-run by default.

## Operational notes (agent bridge)

- Drive remediation off the **converged view**: before applying, confirm the
  involved blocks have `blocks == blocks_synced` and `ps_crud = 0`, so the write
  doesn't race a pending sync.
- Avoid long in-eval `setTimeout` poll loops and multi-write transactions over
  the bridge — both can exceed the CLI response timeout and drop the connection.
  Keep verification to a single snapshot; confirm queue drain with a separate
  quick query.
