# Schema-generator extension: scoping note

Adding a column to a workspace-related Postgres table currently means hand-touching ~5 layered enumerations. The recent E2EE design-doc review cycle ([docs/e2ee-design.html:1072](docs/e2ee-design.html:1072) §11.6) caught three separate findings of the same shape — missing column in one of the layers. This note scopes how to close the gap before E2EE implementation lands.

## 1. Current state

The propagation chain for a column on `workspaces` / `workspace_members` / `workspace_invitations` / `blocks`:

| Layer | File(s) | Drift-protected? |
|---|---|---|
| 1. Postgres DDL | `supabase/migrations/*.sql` | source of truth (manual) |
| 2. TS column lists | [src/data/workspaceSchema.ts:41](src/data/workspaceSchema.ts:41), [82](src/data/workspaceSchema.ts:82); `src/data/blockSchema.ts` `BLOCK_STORAGE_COLUMNS` | manual |
| 3. PowerSync sync rules | [powersync/sync-config.yaml](powersync/sync-config.yaml) | **generated** from #2 by [scripts/gen-sync-config.ts:32](scripts/gen-sync-config.ts:32); CI: `yarn check:sync-config` ([package.json:23](package.json:23)) |
| 4. RPC `RETURNS TABLE` clauses | `supabase/migrations/*.sql` (2 functions) | manual |
| 5. TS row interfaces + parsers (local) | [src/data/workspaceSchema.ts:33](src/data/workspaceSchema.ts:33), [62](src/data/workspaceSchema.ts:62), [74](src/data/workspaceSchema.ts:74), [111](src/data/workspaceSchema.ts:111) | manual |
| 6. TS RPC row types + parsers | [src/data/workspaces.ts:32](src/data/workspaces.ts:32), [48](src/data/workspaces.ts:48), [64](src/data/workspaces.ts:64), [84](src/data/workspaces.ts:84) (4 row types, 4 parse fns) | manual |
| 7. `clientSchema.ts` triggers referencing columns by name | [src/data/internals/clientSchema.ts:270](src/data/internals/clientSchema.ts:270) (`blockJsonObjectSql`), [402](src/data/internals/clientSchema.ts:402) (`BLOCK_UPLOAD_COLUMNS`) | manual; **only blocks today**, no workspace-table triggers |

Layers 2↔3 are the only structural link. Everything else is discipline.

## 2. Drift count

- `RETURNS TABLE` clauses in migrations: **2** (`list_my_pending_invitations` 7 cols, `list_workspace_members_with_emails` 6 cols — [20260510222352:393](supabase/migrations/20260510222352_consolidated_initial.sql:393), [:416](supabase/migrations/20260510222352_consolidated_initial.sql:416)). Plus **4** whole-row returns (`accept_invitation`, `invite_member_by_email`, `update_workspace_member_role` → workspace_members / workspace_invitations) which **don't drift** because they project `*`. And **2** `jsonb_build_object(..., to_jsonb(v_workspace), to_jsonb(v_member))` returns (`create_workspace`, `ensure_personal_workspace`) which also don't drift on column names but do drift on parser shape.
- TS row types projecting these tables: **6** (`WorkspaceRow`, `WorkspaceMemberRow`, `RpcWorkspaceRow`, `RpcWorkspaceMemberRow`, `RpcWorkspaceInvitationRow`, `RpcWorkspaceMemberWithEmailRow`) + **6** parse functions.
- Total enumeration sites that have to agree column-for-column with a workspace-table DDL: ~**12** (2 RETURNS TABLE + 6 TS row types + 6 parse fns; the WORKSPACE_*_COLUMNS arrays themselves are the SoT and don't count).
- Adding one column to `workspace_members` today requires updates in `~7-8` of those 12 (RETURNS TABLE if surfaced via the RPC; both Row + RpcRow + WithEmail variants; both parse fns; INSERT lists inside `accept_invitation` and `create_workspace`; column array).
- Branch evidence: on `docs/e2ee-design-sketch` (6 commits ahead of master), the design doc §11.6 explicitly logs "three review findings" of missing-column drift across the propagation chain — for `wrapped_cek_for_invitee`, `encryption_mode`, and `wrapped_cek`. Caught at design-review time, but only because Codex reviewed line-by-line; the same shape will hit shipped code without a structural guard.
- Historical drift in code: `git log -S "RETURNS TABLE" -- supabase/migrations/` shows the clauses only ever set once (consolidated migration). No drift fixes yet — but no E2EE-shaped change has shipped yet either.

## 3. Three options

### A. Extend the generator: emit/check RPC skeletons + TS row types

Make [workspaceSchema.ts](src/data/workspaceSchema.ts) the SoT for both the local SQLite mapping (today) and the RPC-projection / TS-row-type universe (new). `gen-sync-config.ts` becomes `gen-schema-bindings.ts` (or a sibling) and emits:

- `powersync/sync-config.yaml` (already done)
- A `supabase/migrations/_generated/rpc-projections.sql` snippet with the `RETURNS TABLE(...)` and `SELECT col, col, ...` projections for each enumerated RPC (`list_my_pending_invitations`, `list_workspace_members_with_emails`, plus future E2EE ones). The migration `CREATE FUNCTION` bodies `\i` or copy from this, or CI greps the live migration for the expected substring.
- A `src/data/_generated/rowTypes.ts` with `WorkspaceRow`, `WorkspaceMemberRow`, `RpcWorkspaceRow`, plus a single `parseRpcWorkspace(row)` driven by a column→camelCase + type-coerce table. The hand-written `workspaces.ts` re-exports.

**Effort:** ~1-2 days. Need a column→TS type + parser-recipe table per column (text→string, bigint→`number | string`, bytea→`Uint8Array`, etc.); need to teach the generator about per-RPC column subsets (`list_my_pending_invitations` projects 6 of 5 invitation cols + 1 JOIN); need a CI-check mode (`--check`) consistent with the existing one.
**Value:** highest. Adding a column to `workspace_members` becomes a 2-line diff (DDL + array). Everything else regenerates.
**Doesn't catch:** trigger logic that *uses* the column (e.g. the §8.2 cross-table NOT NULL for `wrapped_cek`); INSERT column lists inside RPC bodies (`accept_invitation`'s `insert into workspace_members (id, workspace_id, user_id, role, create_time)` — these are functional, not projections, and harder to template). Both still need a checklist.

### B. CI-only check, no generation

A `scripts/check-rpc-projections.ts` that parses migrations, extracts each `RETURNS TABLE(...)` and `SELECT ...` projection, and asserts the column list matches the relevant `WORKSPACE_*_COLUMNS` array (or a per-RPC declared subset). Also greps TS row interfaces for the same column set and fails if drift.

**Effort:** ~half a day. SQL parsing is the wart — a regex over `RETURNS TABLE\("(\w+)" ...\)` gets you 90%; TS row types via `ts-morph` or a tagged interface helper.
**Value:** medium. Prevents drift but leaves duplication intact; every column add still touches 7-8 sites manually, the script just yells if you miss one.
**Doesn't catch:** the parse-function side (still need to add a field); column type mismatches between TS row and SQL; non-projection drift (INSERT lists in RPC bodies, trigger references).

### C. CONTRIBUTING checklist

A "when you add a column to a workspace-related table" section in [CONTRIBUTING.md](CONTRIBUTING.md) listing all 7-8 sites.

**Effort:** ~30 min.
**Value:** low. Codex review on the E2EE doc already functions as this checklist and still missed three. Humans miss it more reliably.
**Doesn't catch:** anything mechanical; relies on human discipline that's already been shown to fail.

## 4. Recommended path

**B + A-lite, in that order.**

Land **option B** first — a `check:rpc-projections` script wired into `yarn check`. Concrete shape:

- Source of truth: the migrations themselves. Walk `supabase/migrations/*.sql` in filename order; build a per-table column set from `CREATE TABLE` bodies, then mutate it via `ALTER TABLE ... ADD COLUMN` / `DROP COLUMN`. No new TS-side column array is required for a table to be checked — adding the column in the migration is sufficient.
- Tag each enumerated RPC with a comment like `-- @projects: workspace_members + email` above its `CREATE OR REPLACE FUNCTION`. Script parses the comment and the following `RETURNS TABLE(...)` and asserts the columns match the migration-derived set ∪ declared extras.
- Tag TS row interfaces / types similarly with `// @projects: <table> [+ <extra>...]`. Script checks the same way.
- Add to `package.json` `check` chain alongside `check:sync-config`.

This catches drift today, costs half a day, and uses the migrations as the single source of truth without introducing a parallel TS-side SoT that would itself need keeping in sync.

Then, when the E2EE migration lands and adds 3 enumerated columns across 3 tables + 2 new RPCs, evaluate whether the projection/parser duplication has crossed the threshold where **option A** (generated row types + parsers) pays for itself. The likely answer is yes — the E2EE columns are the first non-trivial extension and the second pass will be cheaper than fighting the duplication forever. But landing A speculatively, before there's a second column-set to validate the generator against, risks over-fitting.

Scope to land B:
1. `scripts/check-rpc-projections.ts` (~150 LOC, vite-node).
2. `-- @projects:` comments on the 2 existing enumerated RPCs.
3. `package.json` script entry + add to `check`.
4. Run on the E2EE branch as the first real test once those migrations exist.

Option C falls out for free as a brief note in the script's failure message ("see [docs/schema-generator-extension.md](docs/schema-generator-extension.md)") rather than a separate CONTRIBUTING entry.
