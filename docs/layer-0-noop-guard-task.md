# Task — Ship Layer 0 semantic-no-op guard for `repo.tx` writes

## Goal

Suppress no-op uploads from `tx.update`, `tx.setProperty`, and `tx.move`. Today these helpers always bump `updated_at` / `updated_by` via `metadataPatch()`, and those columns are in the upload-routing trigger's column-diff predicate — so a call like `block.set('isCollapsed', true)` *when isCollapsed is already true* still issues a SQL UPDATE, the trigger fires, a PATCH lands in `ps_crud`, and it round-trips to Supabase.

After this task: the SQL UPDATE never runs in the no-op case. No `ps_crud` row. No upload. No `blocks_history` write. No sync-echo invalidating other clients.

## Why this is worth doing

- **Wire & history cleanliness.** Toolbar toggles that re-apply the current value, drag-end-in-same-position, bulk-edit flows that touch already-matching rows all currently produce visible churn (history rows, sync echoes, cache invalidations on other devices).
- **Independent of the per-key merge work in `docs/field-level-sync-merge.md`.** Pure client-side filter — doesn't change wire format or server semantics. No ordering dependency on Layers A/B/C; can land first, in parallel, or after.
- **Small surface.** ~30 lines across three functions, mechanical.

## Where to make the change

Three entry points in `src/data/internals/txEngine.ts`:

- `tx.update(id, patch, opts)` — around line 284
- `tx.move(id, target, opts)` — around line 312
- `tx.setProperty(id, schema, value, opts)` — around line 354

Each one currently:
1. Loads `before = await this.requireExisting(id)`.
2. Builds `after` by spreading `before`, then the patch fields, then `this.metadataPatch(opts?.skipMetadata)`.
3. Always executes the SQL UPDATE with the resulting fields.
4. Calls `recordWrite(this.ctx.snapshots, id, before, after)`.

The pattern to apply: between steps 1 and 2, compute the proposed *user-visible* `after` (excluding the metadata patch), compare against `before` on the user-visible fields, and **early-return** if they match. Step 2 onward runs only when there's a real change.

## Concrete comparison rules per entry point

### `tx.update(id, patch, opts)`

Fields that can be in `patch`: `content`, `references`, `properties` (see `BlockDataPatch` type).

Compare each field that's present in the patch against `before`:

- `content`: shallow string equality.
- `references`: deep equality. `JSON.stringify(before.references) === JSON.stringify(after.references)` is fine (refs arrays are small and ordering is already canonicalized by `core.normalizeReferences` as a same-tx processor — so stringify equality is a stable test).
- `properties`: deep equality, same `JSON.stringify` approach (flat `Record<string, unknown>`, small).

If *every* field present in the patch matches `before`, return early. If the patch is empty, return early too (defensive — also a no-op).

### `tx.move(id, target, opts)`

`target = { parentId: string | null; orderKey: string }`. Compare both against `before.parentId` and `before.orderKey`. If both match, early-return.

### `tx.setProperty(id, schema, value, opts)`

This one is per-key. The current code reads `before.properties`, encodes `value` via the codec, and writes the merged properties object. The comparison is value-level on the single key being set: encode `value` via the same codec the caller would use, then compare against `before.properties[schema.name]` (or the canonical lookup) via stable equality.

Be careful: the codec may produce a structurally-different but semantically-equivalent value (e.g. `Date` → ISO string, undefined → key absent). Compare *encoded* shape against the stored shape so the equality test sees the same representation that would be written. Look at how the current `tx.setProperty` produces the to-be-stored value — that's the form to compare against the existing stored value.

If the encoded new value equals the existing stored value, early-return.

## Subtleties

- **Run the guard *before* `metadataPatch` is applied.** Some current code paths merge `metadataPatch` into `after` unconditionally. Reorder so the user-visible comparison sees the pre-metadata shape. Otherwise the comparison always trips on the bumped `updated_at` and the guard never fires.
- **`recordWrite` is for the audit/snapshot bookkeeping inside the tx.** Don't call it on the no-op path. The tx engine's invariant is "no `recordWrite` ⇔ no row event."
- **Workspace pin (`pinWorkspace`).** Currently called *after* the SQL UPDATE succeeds. On a no-op return, you can either skip pinning (the row didn't change, no workspace assertion made) or pin defensively. Pinning is cheap and idempotent — pin defensively, before the early return, so the tx's workspace invariant stays consistent regardless of whether any rows actually changed. See `checkWorkspace(before.workspaceId)` already running before the comparison; if that passes, `pinWorkspace(before.workspaceId)` is safe.
- **`skipMetadata: true` writes.** `parseReferences` and similar internal writers pass `{skipMetadata: true}` and `metadataPatch` returns `{}` — so today these writes don't bump `updated_at`. They'd already be a no-op at the SQL level if the user-visible fields are identical (the trigger's column-diff predicate filters them out before reaching `ps_crud`). The guard still helps because it skips the SQL UPDATE entirely (which has its own cost — local trigger evaluation, OPFS write, processor wakeup). Apply the guard uniformly regardless of `skipMetadata`.

## Tests to write

Add to the existing `txEngine` test file (`src/data/internals/txEngine.test.ts` or wherever the engine's behavior tests already live — grep for `tx.update\|tx.setProperty\|tx.move` in tests to find it).

One test each:

- `tx.update` with a patch whose fields all equal `before` → assert no `ps_crud` row is created, no `row_events` row is created.
- `tx.setProperty` setting a property to its existing value → same assertions.
- `tx.move` to the same parent/orderKey → same assertions.

Plus the inverse for each: a real change still produces the expected `ps_crud` and `row_events` rows. (Likely already covered by existing tests — just make sure they still pass; don't duplicate.)

**Avoid** tests that just re-state code (per `AGENTS.md`): no test that asserts "the guard runs before metadataPatch" by re-implementing the check. The behavioral assertion is "no upload row queued for a no-op write."

## Verification

- `yarn run check` must pass. It runs compile + lint + Vitest + sync-config check + no-service-role check.
- No new lint errors, no new failing tests.
- If you're working on a remote sandbox without Node 24, the binary is at `/tmp/node24/node-v24.10.0-linux-x64/bin/node` (the existing `check:db` and Vitest workflows expect Node ≥24).

## Branch & PR conventions

- Develop on a new branch: `claude/layer-0-noop-guard` (or similar). Branch off `origin/master`. Don't push to any existing branch.
- Single commit is fine; multiple if the refactor naturally splits.
- Open a PR with a body that briefly states the goal (wire/history cleanliness, no behavior change for real edits) and links to `docs/field-level-sync-merge.md` for the broader context.

## Out of scope — don't expand

- Don't change the wire format. The trigger envelope, the RPC, the uploader stay as they are after #52.
- Don't add per-key `properties_json` merge — that's the separate plan in `docs/field-level-sync-merge.md` and lands as a different PR.
- Don't refactor `metadataPatch` or the tx engine's structure beyond reordering the existing operations to make room for the guard.
- Don't touch processors (`parseReferences`, `normalizeReferences`, etc.) — they call `tx.update` via the same code path and inherit the guard for free.
- Don't add CI step changes or new follow-up doc entries.
- Don't post review comments to other PRs.

## Context references

- Doc this came from: `docs/field-level-sync-merge.md` (§Layer 0 section, marked optional/independent).
- The motivating discussion landed in PR #51.
- The narrow PATCH upload + RPC work this builds on top of is in master (shipped as PR #52).
