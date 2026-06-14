# Roam timestamp backfill (ff-vlad-dev)

One-time restore of real Roam `create-time`/`edit-time` onto the ~312K
already-imported blocks (currently all stamped at the 2026-05-13 import time).
The importer itself is already fixed going forward (commit `dbfb6849`); this
fixes the rows imported before that.

**Status: authored, NOT executed.** Writes to prod Supabase — hold for a
coordinated drain window + your review.

## Mapping
| column | value |
|---|---|
| `created_at` | ← Roam `create-time` (all matched rows) |
| `user_updated_at` | ← Roam `edit-time`, EXCEPT preserve-list rows (kept) |
| `updated_at` | ← server-now, forward bump (never Roam — it's the sync row-version; the client materialize LWW gate needs it newer to accept the row) |
| `created_by` / `updated_by` | unchanged |

## Preserve policy (what keeps its current `user_updated_at`)
A block is preserved if it has **genuine post-import user activity**, classified
from `row_events` joined to `command_events` (per-tx provenance: `scope` +
`description` + `mutator_calls`). Two combined signals — robust against both
bulk and per-block machine ops:

**Local writes — genuine user edit** = a **small tx (`bc < 1000`)** (bulk ops are
machine regardless of label) AND `scope='block-default'` AND a `description`
that is NOT a per-block machine op: not `roam import*` / `migrate *` /
`processor:*` / `*readwise:*` / `matrix message ingest*` / `imported-from-roam*` /
`agent runtime*` / `promote roam page*` / `setBlockTypes*` / `set property roam:*`
/ `set property system:*` / NULL (NULL = engine type/alias derivation).
This catches content edits AND **structural** edits (`move`/`indent`/`outdent`/
`create child`/`split`/`paste`), SRS reviews, `status`, `undo:*`, etc.

**Cross-device writes** arrive as `source='sync'` with `tx_id = NULL` (no
`command_events`), so they're classified by what changed: content, or a property
key that isn't machine (`roam:*`/`readwise:*`/`system:*`/`place:*`/`daily-note:*`/
`matrix-event:*`/`types`/`alias`/UI keys). Conservatively preserved.

**Why combined:** tx-size alone over-preserves per-block migrations (e.g.
`migrate roam:location ref`, 865 one-block txs) and misses structural edits;
`command_events` alone misses bulk machine ops with edit-like labels
(`retagBlocks` / `repair merged type ids` — single 1,300-block txs). Together:
bulk → size, per-block machine → description, genuine edits → preserved.

Shadowing is handled by an EXISTS scan over each block's **full** post-insert
history (append-only, complete since import), so a user-edit-then-bulk-touch
still preserves.

## Numbers
- mapped imported blocks: **312,527** (incl. 4,096 daily pages, id-validated)
- preserve: **1,525** · recover: **311,002** → **99.51%**

## Files
- `roam_ts_map.csv` — `id,create_time,edit_time` (~312K rows) — **generated, not
  committed** (large + contains block ids). Produce with `build_ts_map.mjs`.
- `roam_ts_preserve.csv` — `id` (~1.5K rows) — **generated, not committed**.
  Produce by running `preserve_list.sql` via the bridge and intersecting with
  the map ids.
- `backfill.sql` — staging load + backup + UPDATE + verify + rollback
- `build_ts_map.mjs` — regenerates the map from a Roam export:
  `node build_ts_map.mjs <export.json>`
- `preserve_list.sql` — the preserve classifier (`row_events` ⋈ `command_events`).
  Run via the agent bridge, then intersect its output with `roam_ts_map` ids
  locally (only imported blocks can be in the backfill set; this drops native
  UI/prefs noise). Starts with `WITH` so it passes the bridge cleanly.

## Run (held)
1. Drain clients (coordinated window). **Drain = each client's upload queue
   flushed to empty (`ps_crud → 0`), not merely disconnected** — a queued-but-
   unsent local edit at execution time would race the `updated_at` bump. The
   client reconcile gate (`syncObserver/reconcile.ts`) skips down-applying a
   row with a pending local upload, so a flushed queue is the safe state.
2. `psql <supabase-url> -f backfill.sql` (or via the supabase skill) — it loads
   staging, snapshots `blocks_ts_backup_20260613`, runs the UPDATE inside a
   `BEGIN`, and prints a verify row. Inspect it, then uncomment `COMMIT`.
3. Clients re-sync corrected rows (expect a one-time `row_events` burst per
   client — inherent to propagation; see `docs/row-events-retention.md`).

## Known edge cases (adversarial review, accepted)
- **Future-dated daily-note pages.** A daily note whose Roam `create_time`
  predates its calendar date — created in advance in Roam, or whose
  deterministic daily-note id collides with an in-app-only note — would have its
  `created_at` moved backward. Validate before regressing `created_at` far below
  its current value, and exclude such ids if wrong. (This run: a couple of such
  pages; ambiguous, left in.)
- **Blast radius is small** because map ids are all UUIDv5 (deterministic /
  imported) while native app blocks are UUIDv4 — so empty-content clears,
  audit-gap blocks, and mid-size machine txs all land on v4 ids absent from
  `roam_ts_map` and are never touched. Verified by the adversarial review.
