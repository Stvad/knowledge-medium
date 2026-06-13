# Cleanup plan: junk `#tag` pages from the `isa::` hashtag bug

Status: **proposal — not executed.** Code fix already shipped in
`fa347605` (`fix(roam-import): rewrite #tags in isa:: values before alias
extraction`). This doc covers cleaning up the 91 junk pages that the bug
already created in the `ff-vlad-dev` graph.

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

The junk page ids are `uuidv5(`${ws}:${title}:0`, ALIAS_NS)` (verified).
But the **correct** target pages (`CFAR`, `Python`, …) do *not* use that
formula — they're real imported Roam pages with a different id scheme.
Most already exist (`CFAR`, `Coaching`, `Python`, `Ukraine`,
`economics`, `rationality`, `Beeminder`, `capitalism`,
`science-fiction`, `to/try` all found; `Roam` does **not** exist yet).

So the migration must **resolve each split alias by querying the live
graph** (page where `content = alias` or `aliases` contains `alias`,
within the workspace), and only create a new alias seat when none
exists. Do **not** assume `computeAliasSeatId(alias)` equals the target
— it won't for real pages.

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
3. **Resolve** each split alias to a target page id: existing page by
   `content`/`aliases` lookup, else create an alias seat (the same path a
   correct import would use). Record created pages.
4. **Repoint referrers**: for every block whose ref-list property
   (`roam:isa`, and generically any `roam:*` ref-list / `page_alias`)
   array contains `j.id`, replace `j.id` with `j`'s resolved target ids,
   dedup, keep the other entries and order. Write via `repo.update`
   (whole properties map) so the ref index rebuilds.
5. **UI state** (`recentBlockIds`, `topLevelBlockId`,
   `focusedBlockLocation` — 3 rows): drop `j.id`; if an open panel/focus
   points at a junk page, repoint to its first target or clear. Low
   stakes.
6. **Content wikilink** (the 1 user-authored block): **skip by default**.
   Only rewrite `[[#capitalism …]]` → `[[capitalism]] [[critique]]
   [[coordination]] [[civilization]]` if you confirm (see decisions).
7. **Delete** each `j` via `repo.delete` (tombstone — recoverable,
   history preserved, syncs as a normal delete).

**Dry-run first**: the script's default mode emits the full change-set
(per-referrer before/after, pages to create, pages to delete) to a
scratch file for review; a `{apply:true}` flag performs writes.

**Idempotency / recovery**: re-running after a partial pass is safe —
repointing an already-absent id is a no-op, deleting an already-deleted
page is a no-op, and resolved targets are stable. Tombstoned pages can be
restored if anything looks wrong. Run it during a coordinated window with
other clients drained (small fleet) to avoid mid-flight reprojection.

## Decisions needed before executing

1. **The one user-authored `[[#capitalism #critique #coordination
   #civilization]]` link** — rewrite into four page links, or leave the
   literal page intact (the user's note suggests it may be an
   intentional "aliases file" page)? Default: **leave it** (and therefore
   keep that one junk page, since it has a real content backlink).
2. **Typo targets** (`Pocker`, `epistomology`, `medecine`) — create
   faithfully as-is (default, recommended) or skip/merge to the correct
   spelling?
3. **`#CFAR #Beeminder creator`** → `[CFAR, Beeminder]`, dropping
   `creator` — confirm acceptable.

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
