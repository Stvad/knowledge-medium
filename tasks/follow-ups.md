# Follow-ups

## Tx-bound read guards for reference processors

`core.parseReferences` and `core.cleanupOrphanAliases` now do their expensive reads before opening a write transaction to avoid the PowerSync queue deadlock shape documented in `tasks/processor-tx-deadlock.md`. That leaves two narrow TOCTOU windows: alias ownership can change between "alias missing" and deterministic target creation, and a newly inserted alias target can gain a reference between the orphan precheck and cleanup delete.

Fix shape: add narrow tx-bound read helpers for the final guards, e.g. alias lookup by `(workspaceId, alias)` and "does any block reference this id?", implemented on the `Tx`/`TxImpl` path using the active write-transaction lock context. Keep the broad prefilter reads outside the tx, but re-check inside the tx immediately before creating the fallback alias target or deleting a cleanup candidate. Do not call the bare `ctx.db` from inside `repo.tx`; that reintroduces the queue deadlock.

## CI guard on Postgres ↔ TS schema drift

`scripts/gen-sync-config.ts` keeps the local-SQLite raw-table mapping and the PowerSync sync-stream SELECT in lockstep (both projected from the same `BLOCK_STORAGE_COLUMNS` / `WORKSPACE_*` arrays), but **Postgres is still drift-prone** — someone can edit `BLOCK_STORAGE_COLUMNS` without writing the matching `supabase/migrations/<…>.sql`, and nothing fails until `db push` (or worse, a runtime PATCH that references a missing column). Fix shape: a CI step that calls `npx supabase db query --linked "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('blocks','workspaces','workspace_members')"` and asserts the returned set is a superset of every name in the TS column lists. Costs: needs a Supabase-reachable env in CI (or a checked-in `supabase/schema-snapshot.json` you regenerate via a `yarn snapshot:schema` script and diff against). Lower-effort variant: parse the migration files as text and grep for `add column.*<name>` per TS column — no DB connection needed but misses migrations that drop a column.

## Split user preferences out of `ChangeScope.UiState`

The data-layer redesign (§5.8 + §10) maps `ChangeScope.UiState` to `source = 'local-ephemeral'` *unconditionally* — UiState writes never enter the upload queue, never sync, are allowed in read-only mode. This is the right call for genuinely device-local session state (cursor position, text-selection range, edit-mode flag, multi-block selection, currently-open page on this device). Syncing those would create cross-device noise: "my desktop's cursor jumped because my phone moved" / "my laptop went into edit mode because my phone did."

But two of the existing UiState properties are border cases that lean toward "preference, not session":
- `recentBlockIdsProp` — the recent-blocks list. Today device-local; arguably a user wants their phone-recents to show up on their desktop.
- `topLevelBlockIdProp` — currently-open page. Arguable; some users would want their last-open page restored across devices, others would find it intrusive.

Possibly also: panel layout, default workspace pick, view-mode toggles, anything that lives on the user-page block but isn't transient.

The right shape is a *new* scope `ChangeScope.UserPrefs` (or similar name) that:
- Routes through `source = 'user'` so it syncs (modulo read-only mode → ephemeral, same as `BlockDefault`)
- Lives on a per-user block tree (the existing `userPageBlockId` is a fine host)
- Is allowed in read-only mode but routes to ephemeral there (same dual gate as today's content scope)

Then we move `recentBlockIdsProp` (and any other "preference"-shaped UiState property we identify) to the new scope. UiState stays purely for transient session state.

**Why not now**: stage 1.6 is focused on the call-site sweep and shouldn't expand the scope enum. Adding `UserPrefs` requires updating the read-only enforcement gate (`isReadOnly` matrix in `commitPipeline.ts`), the source mapping in `sourceForScope` / `scopeUploadsToServer`, the upload-routing trigger gate (currently keyed on `source = 'user'`, which still works as long as UserPrefs uses `source = 'user'`), and at least one new test scenario per the §14 matrix. ~1-2 commits of focused work that should land independently of the migration.

**Why now in a follow-up**: the legacy implementation synced UiState writes when not read-only. The redesign deliberately changed this — the change is correct, but it does drop the "recents sync across devices" affordance that legacy users might miss. This is the place to pick that back up cleanly without retrofitting UiState's semantics.

**Origin**: design discussion during stage 1.6.B / 1.6.C, where the reviewer flagged that `Block.set(uiSchema, value)` was uploading content scope (P2 finding, fixed in 1.6 commit 6). The fix preserves the spec (UiState = local-ephemeral always) and defers the recents-syncing question here.

## Id-only collection handles for `subtree` / `ancestors` / `backlinks`

`repo.childIds(id)` was added alongside `repo.children(id)` to give callers that only need the structural list a handle whose only dep is `parent-edge` — child property updates don't invalidate it, and the loader is a lighter `SELECT id` query. `useChildIds` and `useHasChildren` were rewritten on top of it; the symptom that motivated the split was an UI-state child mutation cascading a `useChildren`-driven re-render through `LayoutRenderer`.

The same id-only shape would work for the other three list-handle factories in `Repo` (`subtree`, `ancestors`, `backlinks`) for the same reason: their React consumers all use `Block` facades for per-row reactivity, so the per-id `row` deps the handles currently declare are redundant — the row-grain subscriptions on each Block already cover content updates. But the leverage drops sharply:
- `subtreeIds` — same shape of win in principle (row dep × many descendants), but no current hot consumer. Probably worth waiting for an actual callsite.
- `ancestorIds` — Breadcrumbs is the only consumer; chains are typically O(depth) shallow and the breadcrumb labels need block content anyway.
- `backlinkIds` — Backlinks UI also renders each backlink's content; row deps are bounded by the backlinks list size.

Add when a measured hot path appears, not preemptively. Phase 4's `queriesFacet` (per `tasks/data-layer-redesign.md` §13.4) is the canonical place for these — `repo.childIds` will migrate alongside `repo.children` to `repo.query.childIds` with no callsite changes downstream of the hooks.

## Reduce per-block flicker on lazy hierarchical loads

`useChildIds` is backed by `repo.childIds` which hydrates the whole children list per parent on first read. That keeps the per-parent expand path fast, but as the user scrolls into deeper levels their grandchildren still load on `LazyBlockComponent` mount and visibly pop in. Standard fixes worth considering when this becomes noticeable:

- **Skeleton with structural shape**: render a bullet at the right indent depth (data the parent already has) inside the LazyBlockComponent placeholder instead of the bare 32px `<div>`. Real content slots into the same shape rather than appearing from nothing — most of the perceived "pop" is the bullet + indent appearing, not the text.
- **`useTransition` around expand toggles**: `startTransition`-wrap the `setIsCollapsed` write so React keeps showing the previous tree until the new descendant Suspense boundaries resolve, instead of flashing fallbacks during the load window.
- **Tighter overscan / prefetch**: bump `OVERSCAN_PX` in `LazyBlockComponent` or have `BlockChildren` warm a few levels of `repo.childIds` ahead of intersection, so by the time a row mounts its data is already in cache.

Cheap wins first (skeleton + maybe overscan); reach for `useTransition` if it still feels jumpy.
