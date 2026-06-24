# Cleanup plan: junk `#tag` pages from the `isa::` hashtag bug

Status: **executed on `ff-vlad-dev` (2026-06-13).** Code fix shipped in
`fa347605` (`fix(roam-import): rewrite #tags in isa:: values before alias
extraction`). This doc covered cleaning up the 91 junk pages that the bug
already created in the `ff-vlad-dev` graph.

**Result:** 91 junk pages tombstoned, 122 `roam:isa` arrays repointed to
existing pages (0 new pages needed — all targets resolved via
`aliasLookup`), 2 UI-state rows cleaned. Post-run verification: 0 junk
pages remain, 0 blocks with a dangling `isa`, 0 UI dangling; the one
user-authored block `3cd128fe` left untouched (its `((…))` ref to the
deleted `#capitalism …` page dangles by design). Spot-checks (Gradle →
`build tool, Kotlin, Java, JVM, DSL`; HPMOR → `book, favorite,
rationality, fiction, inspiration`) all resolve to live pages. Migration
ran via `repo.query.aliasLookup` + `updateBlock` (merge) +
`repo.block(id).delete()`, chunked, idempotent.

## What happened

Roam attribute values using bare `#tag` syntax (`isa:: #CFAR #Coaching`)
were captured as a single literal page alias instead of being split into
separate page refs. Each such value minted one page whose title is the
raw hashtag string (`#CFAR #Coaching`, `#Kotlin #Java #JVM #DSL`, …).
See `src/plugins/roam-import/properties.ts` and the fix's tests for the
mechanism.

## Blast radius (measured on `ff-vlad-dev`, workspace `ef43b424…`)

- **91 junk pages**, all in the single workspace `ef43b424-80ba-4967-b587-a4c32efd8071`.
  - 47 single-tag (`#CFAR`, `#Python`, …) — pure duplicates of the real page.
  - 44 multi-tag (`#CFAR #Coaching`, …).
- **126 referrer rows**, almost entirely `roam:isa`:
  - `roam:isa`: **122** (the real damage)
  - UI/navigation state (incidental, not data): `recentBlockIds` 2,
    `topLevelBlockId` 2, `focusedBlockLocation` 2
- **1 real content wikilink**: a user-authored block
  `[[#capitalism #critique #coordination #civilization]] (generally see
  all aliases file I've derived)` — block `3cd128fe-2c9a-4ff3-80f2-6204340e4574`.
  This is the one place a human typed the junk title on purpose.
- `references_json` mirrors `roam:isa` (123 hits) — it's a derived index
  and recomputes when we rewrite the property through the repo API.

## Target resolution (important)

Resolve each split alias with the **canonical runtime resolver**
`repo.query.aliasLookup({workspaceId, alias}).load()` — the exact lookup
a fresh `[[alias]]` reference uses (matches page title *and* `alias`
array, regardless of `types`). Do **not** use a naive `content = alias`
+ `types:["page"]` SQL filter: it misses pages with empty `types`
(`Roam`, `Facebook`) and alias-array hits (`seedling` → "writing idea",
`Exobrain` → "Exomind").

Measured: all **112** distinct split aliases resolve to an existing page
— **0 seats need creating**, and none resolve back to a junk page. The
typo aliases (`Pocker`, `epistomology`, `medecine`) already exist as
their own pages, so they just get linked, not created.

## Split mapping

Computed with the same hashtag grammar as the fix
(`src/plugins/roam-import/content.ts`). Full 91-row mapping is in the
appendix; summary:

- 90 of 91 split cleanly into `#tag` → `[[tag]]` pages.
- **1 has leftover non-tag text**: `#CFAR #Beeminder creator` →
  `[CFAR, Beeminder]`, dropping the trailing word `creator`
  (Roam reads `#Beeminder creator` as tag `Beeminder` + literal text).
- Typos are preserved verbatim (not auto-corrected):
  `Pocker` (in `#economics #Pocker #longevity #CFAR #Mastermind`),
  `epistomology` (`#epistomology #HPMOR`),
  `medecine` (`#rationality #economics #Libertarianism #medecine`).

## Migration algorithm (idempotent, workspace-scoped)

Run via a one-shot `yarn agent --profile ff-vlad-dev eval` script using
**repo/tx APIs** (not raw SQL), so `references_json`, backlinks, history,
and sync all stay consistent. Scope every write to workspace
`ef43b424…` (per the "don't touch unopened workspaces" rule).

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
6. **Content wikilink** (the 1 user-authored block `3cd128fe`):
   **leave the block untouched.** Its `[[#capitalism …]]` link is the
   user's own note recording the bug; after the page is deleted it
   becomes a deliberate dangling reference. Do not rewrite its content.
7. **Delete** each `j` via `repo.delete` (tombstone — recoverable,
   history preserved, syncs as a normal delete). All 91 are deleted,
   including `#capitalism …`.

**Dry-run first**: the script's default mode emits the full change-set
(per-referrer before/after, pages to create, pages to delete) to a
scratch file for review; a `{apply:true}` flag performs writes.

**Idempotency / recovery**: re-running after a partial pass is safe —
repointing an already-absent id is a no-op, deleting an already-deleted
page is a no-op, and resolved targets are stable. Tombstoned pages can be
restored if anything looks wrong. Run it during a coordinated window with
other clients drained (small fleet) to avoid mid-flight reprojection.

## Decisions — resolved

1. **The user-authored `[[#capitalism …]]` block (`3cd128fe`)** — delete
   the page along with all the others; **leave the block untouched** (its
   link dangles intentionally as the user's record of the bug).
2. **Typo targets** (`Pocker`, `epistomology`, `medecine`) — keep
   faithfully as-is (they already exist as their own pages; link, don't
   "fix").
3. **`#CFAR #Beeminder creator`** → `[CFAR, Beeminder]`, dropping
   `creator` — confirmed.

## Appendix: full split mapping

```
#Amazon                          -> [Amazon]
#Amazon #Sydney                  -> [Amazon, Sydney]
#Android                         -> [Android]
#Atheist #evolution              -> [Atheist, evolution]
#Atheist #meditation             -> [Atheist, meditation]
#Audio #performance #melody      -> [Audio, performance, melody]
#Berlin #Amazon                  -> [Berlin, Amazon]
#CFAR                            -> [CFAR]
#CFAR #Beeminder creator         -> [CFAR, Beeminder]   (drops "creator")
#CFAR #Coaching                  -> [CFAR, Coaching]
#CFAR #rationality               -> [CFAR, rationality]
#CFAR #startup                   -> [CFAR, startup]
#CLI #UI                         -> [CLI, UI]
#California                      -> [California]
#Clojure                         -> [Clojure]
#DSL #editor #programming        -> [DSL, editor, programming]
#Dublin #Ukraine #Amazon         -> [Dublin, Ukraine, Amazon]
#Facebook #dating                -> [Facebook, dating]
#France                          -> [France]
#HSA                             -> [HSA]
#India                           -> [India]
#Kotlin #Java #JVM #DSL          -> [Kotlin, Java, JVM, DSL]
#PDF #reading                    -> [PDF, reading]
#Pharo                           -> [Pharo]
#Portland                        -> [Portland]
#Python                          -> [Python]
#Redshift #Amazon                -> [Redshift, Amazon]
#Roam                            -> [Roam]   (Roam page does not exist yet — will be created)
#Roam #Clojure                   -> [Roam, Clojure]
#Roam #SparkWave                 -> [Roam, SparkWave]
#Transhumanism                   -> [Transhumanism]
#Ukraine                         -> [Ukraine]
#Ukraine #HPMOR                  -> [Ukraine, HPMOR]
#abandoned #Alexa                -> [abandoned, Alexa]
#agent #economics                -> [agent, economics]
#art                             -> [art]
#capitalism #critique #coordination #civilization -> [capitalism, critique, coordination, civilization]
#choice                          -> [choice]
#concurrency                     -> [concurrency]
#contrast                        -> [contrast]
#dating                          -> [dating]
#design                          -> [design]
#driving                         -> [driving]
#economics                       -> [economics]
#economics #Pocker #longevity #CFAR #Mastermind -> [economics, Pocker, longevity, CFAR, Mastermind]
#employment                      -> [employment]
#epistomology #HPMOR             -> [epistomology, HPMOR]
#expectation #performance        -> [expectation, performance]
#favorite                        -> [favorite]
#favorite #rationality #fiction #inspiration -> [favorite, rationality, fiction, inspiration]
#fiction                         -> [fiction]
#fiction #science-fiction        -> [fiction, science-fiction]
#finance                         -> [finance]
#follow-up                       -> [follow-up]
#food #service #planning         -> [food, service, planning]
#friend #enemy #trust #seedling  -> [friend, enemy, trust, seedling]
#friendship                      -> [friendship]
#goals #planning                 -> [goals, planning]
#internet                        -> [internet]
#language #history               -> [language, history]
#log                             -> [log]
#macOS                           -> [macOS]
#make-public                     -> [make-public]
#manager #India                  -> [manager, India]
#market                          -> [market]
#math #rationality               -> [math, rationality]
#math #science #statistics       -> [math, science, statistics]
#meta                            -> [meta]
#monetization                    -> [monetization]
#negotiation                     -> [negotiation]
#negotiation #orange #win-win #make-public -> [negotiation, orange, win-win, make-public]
#networking #communication       -> [networking, communication]
#physics                         -> [physics]
#podcast                         -> [podcast]
#prediction                      -> [prediction]
#productivity                    -> [productivity]
#productivity #efficiency        -> [productivity, efficiency]
#programming                     -> [programming]
#randomness #simulation          -> [randomness, simulation]
#rationality #computation        -> [rationality, computation]
#rationality #economics          -> [rationality, economics]
#rationality #economics #Libertarianism #medecine -> [rationality, economics, Libertarianism, medecine]
#rationality #finance            -> [rationality, finance]
#rationality #training           -> [rationality, training]
#reading                         -> [reading]
#science-fiction                 -> [science-fiction]
#search #Exobrain                -> [search, Exobrain]
#sleep                           -> [sleep]
#sound                           -> [sound]
#to/try                          -> [to/try]
#toread                          -> [toread]
```
