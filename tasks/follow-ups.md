# Follow-ups

## CI guard on Postgres ↔ TS schema drift

`scripts/gen-sync-config.ts` keeps the local-SQLite raw-table mapping and the PowerSync sync-stream SELECT in lockstep (both projected from the same `BLOCK_STORAGE_COLUMNS` / `WORKSPACE_*` arrays), but **Postgres is still drift-prone** — someone can edit `BLOCK_STORAGE_COLUMNS` without writing the matching `supabase/migrations/<…>.sql`, and nothing fails until `db push` (or worse, a runtime PATCH that references a missing column). Fix shape: a CI step that calls `npx supabase db query --linked "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('blocks','workspaces','workspace_members')"` and asserts the returned set is a superset of every name in the TS column lists. Costs: needs a Supabase-reachable env in CI (or a checked-in `supabase/schema-snapshot.json` you regenerate via a `yarn snapshot:schema` script and diff against). Lower-effort variant: parse the migration files as text and grep for `add column.*<name>` per TS column — no DB connection needed but misses migrations that drop a column.

## Rebuild legacy-API tests on `createTestDb`

Stage 1.6 deleted eight test files that exercised the legacy
`Repo`/`Block`/`UndoRedoManager`/legacy-property-shape against stub
DBs that don't compose with the new tx-engine surface:

- `src/utils/roamImport/test/import.test.ts`
- `src/utils/roamImport/test/plan.test.ts`
- `src/test/initData.test.ts`
- `src/extensions/test/dynamicExtensions.test.ts`
- `src/extensions/test/dynamicExtensionsIntegration.test.ts`
- `src/utils/test/copy.test.ts`
- `src/utils/test/markdownParser.test.helpers.ts`
- `src/utils/test/markdownParser.test.ts`

The behaviors they covered (Roam importer end-to-end, plan-vs-merge
reconciliation, daily-note dedup, alias-target creation, dynamic
extension lifecycle, copy/paste round-trips, indented-markdown ↔
parentId+orderKey parsing) are not covered by the new-layer test
suite (`src/data/internals/*.test.ts`). Rebuild on top of
`createTestDb` (real SQLite + real triggers + real tx engine) so the
tests exercise the full v4.27 path. Estimated: 4-6 commits across
the eight files; the data shape is already the new flat one, the
work is rewriting the test fixtures + harness wiring (most of these
used 3-arg `new Repo(db, undoRedoManager, user)` and stub repos
with hand-rolled `getOptional` regex routers, which all need to
become `await createTestDb()` + `new Repo({db, cache, user})`).

## Re-implement undo/redo on `command_events` + `row_events`

The legacy `UndoRedoManager` (`src/data/undoRedo.ts`) batched writes per
"transaction id" and replayed them in reverse via `Repo.applySnapshots`.
Stage 1.6 dropped this with the legacy `Repo`/`Block` rewrite — the
audit data is still captured (each `repo.tx` writes one row to
`command_events` + N rows to `row_events`, both with stable `tx_id`),
but the manager + `Ctrl-Z` keybinding have no replacement yet.

Right shape: a thin manager that, on undo:
  1. Looks up the most recent `command_events` row for the active scope
     (per-tab `local-ui` undo stack would key on user_id alone; per-doc
     `block-default` undo stack keys on workspace_id)
  2. Reads `row_events.before_json` for every row in that tx
  3. Opens a new `repo.tx({scope: ChangeScope.<same>, source: 'undo'})`
     and applies the inverse — restore tombstones, re-PATCH altered
     rows, soft-delete inserted rows
  4. Marks the redo cursor so a subsequent redo can replay forward

`source: 'undo'` is a new tag the upload-routing trigger needs to
recognize as either `user` (so the inverse syncs) or a passthrough.
Probably `user` — undo of a content edit should sync the un-edit just
like the original edit synced.

Spec doesn't currently call out an undo-source flag; this needs §10
update if we want it tagged distinctly from regular `user` writes
(useful for audit logs that want "what was an undo" filterable).

**Why not now**: undo isn't on the Phase 1 acceptance list; the
data-layer redesign explicitly punts it. Re-implementing it requires
the row_events tail + scope-aware stacks, which is its own ~3-4
commits of focused work. A follow-up issue is the right home.

**Origin**: legacy `UndoRedoManager` removed during stage 1.6.E
(bootstrap rewrite; new `repoProvider.ts` doesn't construct one). Until
this lands, `Ctrl-Z` is a no-op in the app shell.

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
