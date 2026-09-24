# Cleanup plan: junk `#tag` pages from the `isa::` hashtag bug

Status: **executed on the live graph (2026-06-13).** Code fix shipped in
`fa347605` (`fix(roam-import): rewrite #tags in isa:: values before alias
extraction`). This doc covered cleaning up the 91 junk pages that the bug
already created in the live graph.

**Result:** 91 junk pages tombstoned, 122 `roam:isa` arrays repointed to
existing pages (0 new pages needed — all targets resolved via
`aliasLookup`), 2 UI-state rows cleaned. Post-run verification: 0 junk
pages remain, 0 blocks with a dangling `isa`, 0 UI dangling; the one
user-authored block left untouched (its `((…))` ref to the
deleted junk page dangles by design). Spot-checks of repointed `isa`
arrays all resolve to live pages. Migration ran via
`repo.query.aliasLookup` + `updateBlock` (merge) + `repo.block(id).delete()`,
chunked, idempotent.

## What happened

Roam attribute values using bare `#tag` syntax (`isa:: #TagA #TagB`)
were captured as a single literal page alias instead of being split into
separate page refs. Each such value minted one page whose title is the
raw hashtag string (`#TagA #TagB`, …).
See `src/plugins/roam-import/properties.ts` and the fix's tests for the
mechanism.

## Blast radius (measured on the live client)

- **91 junk pages**, all in a single workspace.
  - 47 single-tag (`#TagA`) — pure duplicates of the real page.
  - 44 multi-tag (`#TagA #TagB`).
- **126 referrer rows**, almost entirely `roam:isa`:
  - `roam:isa`: **122** (the real damage)
  - UI/navigation state (incidental, not data): `recentBlockIds` 2,
    `topLevelBlockId` 2, `focusedBlockLocation` 2
- **1 real content wikilink**: a user-authored block linking a multi-tag
  junk title as `[[#TagA #TagB …]]`.
  This is the one place a human typed the junk title on purpose.
- `references_json` mirrors `roam:isa` (123 hits) — it's a derived index
  and recomputes when we rewrite the property through the repo API.

## Target resolution (important)

Resolve each split alias with the **canonical runtime resolver**
`repo.query.aliasLookup({workspaceId, alias}).load()` — the exact lookup
a fresh `[[alias]]` reference uses (matches page title *and* `alias`
array, regardless of `types`). Do **not** use a naive `content = alias`
+ `types:["page"]` SQL filter: it misses pages with empty `types`
and alias-array hits (a tag that names another page only through that
page's `alias` array).

Measured: all **112** distinct split aliases resolve to an existing page
— **0 seats need creating**, and none resolve back to a junk page. The
three misspelled tag names already exist as their own pages, so they just
get linked, not created.

## Split mapping

Computed with the same hashtag grammar as the fix
(`src/plugins/roam-import/content.ts`); the full 91-row mapping was
reviewed from the dry-run output. Summary:

- 90 of 91 split cleanly into `#tag` → `[[tag]]` pages.
- **1 has leftover non-tag text**: `#TagA #TagB word` →
  `[TagA, TagB]`, dropping the trailing `word`
  (Roam reads `#TagB word` as tag `TagB` + literal text).
- Typos are preserved verbatim (not auto-corrected): three tag names are
  misspelled, and each resolves to an existing page of that spelling.

## Migration algorithm (idempotent, workspace-scoped)

Run via a one-shot `pnpm agent --profile <profile> eval` script using
**repo/tx APIs** (not raw SQL), so `references_json`, backlinks, history,
and sync all stay consistent. Scope every write to the affected
workspace (per the "don't touch unopened workspaces" rule).

1. **Collect** all pages where `content LIKE '#%'` and type `page` in the
   workspace → the junk set `J`.
2. **Split** each `j ∈ J` into its tag aliases (mapping above).
3. **Resolve** each split alias to a target page id via
   `repo.query.aliasLookup`. (Measured: all resolve; no seats to create.
   If a future run finds an unresolved alias, mint a seat the way import
   does — `resolveAliasSeatId` + page type.)
4. **Repoint referrers**: for every block whose ref-list property
   (`roam:isa`, and generically any `roam:*` ref-list / `page_alias`)
   array contains `j.id`, replace `j.id` with `j`'s resolved target ids,
   dedup, keep the other entries and order. Write via `repo.update`
   (whole properties map) so the ref index rebuilds.
5. **UI state** (`recentBlockIds`, `topLevelBlockId`,
   `focusedBlockLocation` — 3 rows): drop `j.id`; if an open panel/focus
   points at a junk page, repoint to its first target or clear. Low
   stakes.
6. **Content wikilink** (the 1 user-authored block):
   **leave the block untouched.** Its `[[#TagA #TagB …]]` link is the
   user's own note recording the bug; after the page is deleted it
   becomes a deliberate dangling reference. Do not rewrite its content.
7. **Delete** each `j` via `repo.delete` (tombstone — recoverable,
   history preserved, syncs as a normal delete). All 91 are deleted,
   including the one that block links.

**Dry-run first**: the script's default mode emits the full change-set
(per-referrer before/after, pages to create, pages to delete) to a
scratch file for review; a `{apply:true}` flag performs writes.

**Idempotency / recovery**: re-running after a partial pass is safe —
repointing an already-absent id is a no-op, deleting an already-deleted
page is a no-op, and resolved targets are stable. Tombstoned pages can be
restored if anything looks wrong. Run it during a coordinated window with
other clients drained (small fleet) to avoid mid-flight reprojection.

## Decisions — resolved

1. **The user-authored block linking a junk title** — delete
   the page along with all the others; **leave the block untouched** (its
   link dangles intentionally as the user's record of the bug).
2. **Typo targets** (the three misspelled tags) — keep
   faithfully as-is (they already exist as their own pages; link, don't
   "fix").
3. **The one value with trailing text** → its tags only, dropping the
   trailing word — confirmed.
