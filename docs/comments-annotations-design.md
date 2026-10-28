# Comments and annotations

> **Status:** design proposal, not implemented. Last verified against code: 2026-10-28. An earlier design for the same feature is open as PR #332 (`docs/block-range-annotations-design.html` on its branch); the last section compares the two.

## What has to be true

1. Comments and annotations are blocks in the workspace, with everything blocks get: sync, undo, search, references, hand-editing, E2EE.
2. A separate side surface shows them beside the notes, and can be turned on and off.
3. A comment can point at part of a block: select some text, comment on that.
4. They sit sensibly next to references. A block already shows how many blocks reference it; comments are the adjacent idea, "what is being said about this block", and the UI should show the two side by side without counting one as the other.
5. Something outside the UI (an agent) can subscribe to comments in a scope (a page, a subtree, one block), read them, and reply.
6. Every comment shows who wrote it, human or agent.

## The shape in one screen

```
Comments (km)                      ← kernel page, one per workspace, created at the first comment
└─ thread root                     type annotation:thread, content ""
   │   annotation:target   ((B))   ← ref property: the block being annotated
   │   annotation:quote    "the selected text"   (absent = the whole block)
   │   annotation:quoteStart 42    ← where the quote started when it was made
   │   annotation:status   open | resolved
   ├─ "I don't think this holds"   ← a comment: an ordinary block, authored by a person
   └─ "Agreed, see [[Paper X]]"    ← a reply: an ordinary block, authored by an agent
```

- The target block is never written to. Everything about the annotation lives on the thread root.
- A thread with no comments is a highlight. A thread with comments is a discussion. They are the same record.
- The block id of the target lives in exactly one place, the `annotation:target` ref. Everything else about the anchor is text.
- Discovery runs through the references index: `block_references` rows with `source_field = 'annotation:target'`.

## What exists today

| Need | Existing seam | File |
|---|---|---|
| Typed records | `seedType` / `seedProperty`, `createTypedChild` (takes `references`, so a new thread is discoverable in its creating tx) | `src/data/typedRecords.ts` |
| Workspace container | `getOrCreateKernelPage` (deterministic id, restores a tombstone, alias required) | `src/data/kernelPage.ts` |
| Pointer to the target | `ref` property; projected into `block_references` with `source_field` set; indexed on `(target_id, workspace_id)` | `src/plugins/references/referenceProjection.ts`, `localSchema.ts` |
| Merges | the generic merge retargeter rewrites ref property VALUES as well as their entries | `src/plugins/references/mergeRetargetProcessor.ts:217-275` |
| Target deletion | `((id))` marks in referrers get inlined, but property values are exempt and keep the ref | `src/plugins/references/inlineDeletedBlockRefsProcessor.ts` |
| Reference count pill | `blockContentDecoratorsFacet` gutter pill; click expands backlinks under the block through `blockChildrenFooterFacet` | `src/plugins/backlinks/inline-counts/` |
| Backlink count and list | one batched SQL over `block_references`; no `source_field` filter today | `src/plugins/backlinks/sourceBatch.ts` |
| Authorship | `attribution:creators` / `attribution:editors` refLists to `contributor:profile` pages (kind human, agent or automation), recorded by a same-tx processor | `src/plugins/contributors/` |
| Edit mode | CodeMirror 6; plugins add extensions through `codeMirrorExtensionsFacet`; the selection is raw content offsets; `flushEditorContent(view)` forces the debounced write | `src/editor/` |
| Read mode | react-markdown; plugins add remark/rehype plugins through `markdownExtensionsFacet` | `src/markdown/extensions.ts` |
| Live queries | `defineQuery` handles, `useHandle` | `src/data/api/query.ts` |
| Agent wake-ups | bridge `watch-events` (`sql` and `backlinks` watchers, pushed from the tab); agent-dispatch `backlinks` and `query` watchers, claims in `agent:*` properties | `src/plugins/agent-runtime/watchEvents.ts`, `packages/agent-dispatch/` |

Missing today, and supplied here: anything that maps a rendered DOM selection back to raw offsets (none exists), a `Decoration.mark` anywhere in the editor (none exists), and a way to keep one edge field out of the backlink count.

## Data model

### A thread is a metadata block, and its children are the comments

The thread root holds the anchor and the status and has empty content. Each comment is a child block. Replies are further children, so a thread is just an outline: Enter at the end of a comment starts the next one, a nested reply is an indented block, and `[[links]]`, `((refs))` and formatting all work because nothing about a comment is special.

Putting the first comment's text on the root would save one block per thread. It is rejected for two reasons:

- **Attribution.** Contributors attribute any meaningful write to the block it lands on (`src/plugins/contributors/processor.ts:21-29`). If the root were also the first comment, resolving the thread, repairing its anchor, or an agent claiming it would list whoever did that as an editor of somebody's comment. With a separate root, those writes land on the metadata block, and a comment's authors are exactly the people who wrote it.
- **Uniform rendering.** Every comment is a sibling under the root, so the side surface renders one list, not "the root" plus "the rest".

Comment blocks carry no type. "A comment" means "a visible descendant of a thread root". A second marker would be a second source of truth that hand-typed replies would not carry.

### Where threads live

Threads live as children of one workspace kernel page, `Comments (km)`, created at the first comment through `getOrCreateKernelPage`. The ugly alias is deliberate, as with `System Migrations (km)`: aliases are unique per workspace, and a plain `Comments` alias would make comment creation abort in any workspace where the user already has a page of that name.

Two other places a thread could live, both rejected:

- **As children of the target.** This is local, and comments would move with the block. But every structural operation (indent, outdent, move, merge, child counts, the collapse arrow, keyboard navigation) would then have to step around them. The properties-as-blocks work measured that cost: of about 30 sites that had to opt property rows out of child handling, roughly two thirds were structural, not rendering. Comments would add a second such class.
- **As property values on the target.** Field rows hold a set of values deduplicated by content (two "+1" comments would merge into one), and their values are codec-encoded scalars, not records with children.

Where a thread lives is incidental, because the ref is what makes it a thread. A thread root that someone moves elsewhere by hand still works. Discovery never looks at the container.

### The anchor

`annotation:quote` is a substring of the target's raw markdown, the same text an agent reads through the API. So an agent can annotate a range by quoting it, and edit mode can decorate it with no translation step. `annotation:quoteStart` records where the quote began when it was made, and is used only to choose between repeated occurrences. With no quote, the thread annotates the whole block.

A quote never splits a reference span (`[[…]]`, `((…))`, `[label](((…)))`). Creation widens the selection to cover whole spans, so the reference plugins always see complete spans inside a highlight.

### Seeds

All are declared by a new `annotations` plugin, use `ChangeScope.BlockDefault`, and add one ledger line each (`src/data/seedIdentityLedger.ts`):

| Seed | Preset | Notes |
|---|---|---|
| type `annotation:thread` | — | `hideFromCompletion` |
| `annotation:target` | `ref` | hidden; no `targetTypes` restriction |
| `annotation:quote` | `optional-string` | hidden |
| `annotation:quoteStart` | `optional-number` | hidden |
| `annotation:status` | `strict-enum` `open`, `resolved` | Its config can widen later, for example to `accepted`/`rejected` for edit suggestions. A boolean `resolved` could not: a codec change is a frozen-identity break. |

On a workspace that stores properties as child blocks, each property becomes a field row under the root, which `visibleChildrenOf` already hides. Every "descendants of a thread" query therefore uses the visible subtree (`VISIBLE_SUBTREE_SQL`), so field rows are never mistaken for comments.

A `blockContentRendererFacet` contribution for `annotation:thread` renders the empty root as "comment on ⟨target excerpt⟩ · “quote”". That covers wherever the root itself shows up, for example on the container page or in a block-ref.

## Anchoring against changing text

Resolution is a pure, synchronous function of `(content, quote, quoteStart)`. It is recomputed at render time and never persisted.

1. No quote: anchor the whole block.
2. `content.slice(quoteStart, quoteStart + quote.length) === quote`: anchor there.
3. Otherwise anchor at the occurrence of `quote` nearest `quoteStart`.
4. No occurrence: **stale**. The thread stays on the block, and its card shows the original quote marked as changed. The user can select new text to re-anchor, or anchor the thread to the whole block.

Repeated occurrences are settled by nearest-to-hint, not by prefix and suffix context. Blocks are short (they average under 100 characters on a large real graph), so ties are rare, and each extra property is two more rows on a children-stored workspace. Fuzzy matching (small edits inside the quote) can be added later inside step 3 without changing storage.

Re-anchoring is an explicit user action. It runs in one tx, and inside that tx it re-finds the confirmed text in the content as of that tx and computes the offsets from that same snapshot. If the text no longer matches, the tx refuses rather than storing whatever now sits at the old offsets.

| What happens to the target | Result |
|---|---|
| Text edited outside the quote | Still found; the hint picks the occurrence. |
| Text inside the quote edited | Stale; re-anchor or anchor the thread to the whole block. |
| Moved, indented, reordered, moved to another page | Nothing changes: the ref is by id. |
| Merged into another block | The generic retargeter rewrites `annotation:target` (value and entry). The quote then resolves in the merged text. |
| Split, and the quote ends up in the new block | Stale in v1. Later, the split gesture can retarget, in the same tx, threads whose quote lies after the split point. |
| Deleted | The thread is kept and its ref kept. It is hidden from the margin, listed as "on a deleted block", and restoring the target brings it back. |
| Undo of an edit | It just re-resolves; nothing was persisted. |
| A page in the quote renamed (`[[Old]]` → `[[New]]`) | On children-stored workspaces the quote's value row is rewritten by the same rename, so it still resolves (reasoned, not measured). On cell-stored workspaces it goes stale. Accepted. |

Comments never write the target row, so commenting cannot conflict with someone editing the note.

## Comments and references

The anchor is a real reference: `annotation:target` projects into `block_references` like any ref property. That is what makes discovery cheap. It also means that today it would be counted and listed as a backlink.

- **Two pills, disjoint counts.** The block's right gutter shows `[3] [💬 2]`: references, then open threads. Clicking the reference pill expands backlinks under the block, as it does now. Clicking the comment pill focuses the block's threads in the margin, or expands them inline under the block when the margin is off (the same footer mechanism the backlinks expansion uses).
- **One exclusion, owned by the backlinks plugin.** The backlinks plugin declares a facet that lists the edge fields which have their own surface. The pill count, the inline expansion and Linked References (flat and grouped) all skip those fields, in `sourceBatch.ts` and the grouped query. `annotation:target` is the first entry. The `attribution:*` edges on contributor pages are the obvious second candidate. That change is out of scope here; it is noted because the same rule applies.
- **References inside a comment are ordinary mentions.** A comment saying "see [[Paper X]]" shows up in Paper X's backlinks, with a breadcrumb through the container and the thread. That is correct: the comment does mention it.
- **Mentions reach agents.** A comment containing a dispatch watcher's target page (`[[claude]]`) is a backlink to it, so the existing backlinks watcher already fires (see Queries and subscriptions).

Later, the margin could also show a block's plain backlinks as "mentions" next to its threads. A note elsewhere that references this block is commentary living somewhere else. That is a display toggle on top of this model, not part of it.

## UI

### Highlights

- **Edit mode:** a CodeMirror extension (through `codeMirrorExtensionsFacet`) turns resolved ranges into mark decorations. Those offsets are exact, because the quote is raw content.
- **Read mode:** a remark plugin, ordered before the reference plugins, splits positioned text nodes at range boundaries and wraps the pieces in an `annotation-mark` node. Ordering is the risk: text slices split out by other plugins lose their positions (`src/markdown/blockSeparators.ts` notes this). Spike it first. If it can't be made exact, read mode shows the pill and no inline highlight.
- **Render-surface policy:** inline highlights appear only in a panel's primary outline and the focused editor. Nested surfaces (backlinks, embeds, block refs, breadcrumbs) show none. The comment pill follows the reference pill's rule (`inline-counts/applies.ts`).

### The side margin

The margin is a toggle per panel: the action `annotations.toggleMargin`, plus a header item. The flag is stored on the panel's UI-state block, so it survives a reload.

- **Layout:** a `blockLayoutFacet` contribution on the panel's top-level block adds a right column inside the same scroll container, so cards scroll with the text.
- **Card placement:** a card is placed at the measured top of its target's row in that panel's primary render scope. Cards stack in document order (target position, then quote start). Each card goes at its anchor's height, or just below the previous card if that is lower. The focused card pins to its anchor and pushes the others down.
- **Collapsed blocks:** threads anchored inside a collapsed subtree collapse into one stub on the nearest rendered ancestor ("3 comments inside").
- **What a card contains:** the thread root rendered through `BlockComponent` in a nested surface. The comments are therefore normal editable blocks. The header shows the quote ("whole block" when there is none), a stale badge when it applies, and Resolve. The footer has Reply.
- **Resolved threads:** hidden behind a "show resolved" toggle.
- **Narrow panels and mobile:** no margin. The comment pill expands threads inline under the block instead.
- **All comments:** an action opens the container page, where the thread renderer shows each target. A filtered query view (open threads, by author, by scope) comes later.

### Creating, replying, resolving

- **Comment on a selection** (`annotations.commentOnSelection`, edit-mode context; the default binding is to be chosen against the shortcut-conflict check):
  1. `flushEditorContent(view)`. The stored row lags the editor by its debounce, and the anchor must be checked against what the user sees.
  2. Read the selection and widen it to whole reference spans.
  3. Open a composer in the margin, or inline.
  4. On submit, run one `repo.tx`: create the root with `createTypedChild` (passing its `references`, so it is discoverable in that same tx) and the first comment. Inside that tx, re-check that the quote still sits at its offsets, falling back to the nearest occurrence. The container is ensured before the tx.

  The action has an icon, so it also appears in the mobile keyboard toolbar.
- **The composer:** a draft in UI state, written only on submit. An abandoned comment leaves no empty thread behind.
- **Block-level comment:** the same action in normal mode, or an item in the bullet context menu.
- **Highlight:** the same flow with no composer. The result is a thread with no comments.
- **Reply:** creates an empty child of the root, focused for editing. From then on it is ordinary block editing.
- **Resolve and reopen:** set `annotation:status`.
- **Delete:** deleting the thread deletes the root's subtree. Deleting the last comment from its card deletes the thread too; that is a UI rule. A root with no comments that arises any other way (sync, an agent, hand-editing) is simply a highlight, a valid state.
- **Not in v1:** commenting on a read-mode selection. It needs a DOM-to-raw-offset mapping, which does not exist, and a guard so that a drag-select does not end in the click that enters edit mode (`plain-outliner/clickToEditAction.ts`). The guard would decorate that action through the action-dispatch seam, the way vim-normal-mode does.
- **Not in v1:** a selection that spans several blocks. One thread has one target.

### Authorship

Each comment shows its author, its kind and its time:

- **Author:** the first `attribution:creators` entry, resolved to its contributor profile. The name is the profile's content, and the kind is shown as a person, agent or automation glyph.
- **Time:** relative, from `created_at`.
- **"Edited":** shown when the comment has editors other than its creator.

The author is not taken from `created_by`. Bridge and MCP writes run inside the tab and stamp the tab's human user id, so an agent's comment would show as the person's. Nothing in the app has avatars or per-user colours yet, so the chip is initials plus the kind glyph.

## Queries and subscriptions

### In the app

These are `defineQuery` handles, read with `useHandle`:

- **`annotations.threadsForBlocks({workspaceId, ids, includeResolved})`:** thread roots grouped by target, batched over the rendered blocks the way the backlink count is. It drives the pills, highlights and margin.
- **`annotations.threadsInScope({workspaceId, rootId, includeResolved})`:** `VISIBLE_SUBTREE_SQL` from `rootId`, joined to `block_references` on `target_id` with `source_field = 'annotation:target'`, joined to live `annotation:thread` roots.
- **`annotations.thread({id})`:** the root, its visible descendants, and their attribution.

The typed query language cannot say "the target lies under X". Its `target` operator matches the target's properties, not its ancestry (`src/data/api/typedBlockQuery.ts`). So scope is a dedicated query rather than a widening of the compiler. Widening `target` to accept an ancestor predicate would be more general, but nothing else needs it yet.

### For agents: tools

These are km MCP tools, plus matching bridge verbs:

- **`comments({scope | block, includeResolved})`:** the threads, each with its resolved or stale anchor, the quote, an excerpt of the target, and the comments with author names and kinds.
- **`add_comment({target, quote?, occurrence?, content})`:** creates a thread.
- **`reply_comment({thread, content})`:** adds a comment to a thread.
- **`set_comment_status({thread, status})`:** resolves or reopens a thread.

Writes go through the bridge, so contributor attribution records the agent automatically. Agents could do all of this with the generic block tools, but writing an anchor correctly (exact raw substring, whole reference spans, the start hint) is exactly the kind of thing a dedicated tool should own. The agent-facing guide gets a `comments` topic.

### For agents: being woken

There are two paths. The first works almost as-is.

1. **A mention inside a thread.** `[[claude]] can you check this?` in a comment is a backlink to the watcher's target page, so today's backlinks watcher claims it and replies. The new part is in the prompt builder: when the mention sits inside a thread, it adds the anchor context (the target block's content, the quote, the page path, and the thread so far with authors). Without that, the agent would see only the container and the thread.
2. **A `comments` watcher kind, for monitoring a scope without being mentioned.** Configured as `{kind: 'comments', name, scope: <page alias or block id>, quietMs}`.
   - **What counts as pending:** an open thread in scope whose latest comment was written by someone other than the watcher's contributor, after the baseline. This is derived from the graph every tick, so it needs no cursor and survives restarts. The agent's own reply makes the thread not pending, so the loop guard comes for free.
   - **Claim and session state** (`agent:status`, `agent:session`) go on the thread **root**, never on a person's comment. `agent:*` properties are `BlockDefault`, and the attribution processor counts them as meaningful edits, so a claim on a comment would list the agent as one of its editors.
   - **The reply** is a child of the root, marked `agent:reply`.
   - **Detection** is pushed through a `watch-events` `sql` watcher running the scope query; the poll stays as the backstop, as for the other watchers.

## Deliberately not handled

| Case | Why it is acceptable |
|---|---|
| Read-only workspace viewers cannot comment | Viewer writes are local-ephemeral. A "commenter" role is a server-side RLS change, and under E2EE the server cannot tell a comment from any other block. |
| Concurrent writes to one thread root's metadata | Cell-stored workspaces merge `properties_json` last-writer-wins, as for every block. Thread roots are low-traffic. Children-stored workspaces keep one row per property. |
| Sync can land `references_json` from one writer and properties from another | Projection runs only in `repo.tx`. Discovery tolerates a stale edge, and the next local write to the root re-projects it. |
| Comments don't follow a copied or duplicated target | They annotate that block, not its text. |
| A future subtree share would not include the threads anchored into it | Subtree sharing is designed but not built. Its row scope will need to include "threads targeting blocks in the share". This is the one real cost of not storing threads under their target. |
| Search and recents show comments, agent replies included | Comments are blocks, so this is wanted. Recents filling up with agent writes is a recents question, and today's dispatch replies already raise it. |

## Slices

1. **Data, plus comments from edit mode:**
   - seeds and ledger lines, the container, and the create, reply, resolve and re-anchor writes;
   - the resolver, a pure function, unit-tested;
   - the three queries;
   - the backlinks edge-field exclusion;
   - the comment pill and inline expansion;
   - CodeMirror highlights;
   - comment on selection, block-level comments, highlight-only threads;
   - author chips.
2. **Agents:** the MCP tools and bridge verbs, the guide topic, anchor context in the mention prompt, and the `comments` watcher kind.
3. **The side margin:** the margin itself, read-mode highlights (spike first), and the stale and re-anchor UI.
4. **Later:** read-mode selection, split retargeting, fuzzy repair, the filtered "all comments" view, mentions in the margin, edit suggestions.

Slices 2 and 3 both depend on 1 and not on each other.

Tests follow the repo's rules:

- **Resolver:** unchanged, shifted, repeated, missing and non-ASCII text, and widening to whole reference spans.
- **Flush before anchoring:** an edit still held in the editor's debounce is anchored against what the editor shows, not the stale row.
- **Backlinks exclusion:** delete the clause and a named count test and a named list test fail.
- **Merge:** a merge through the production processor order moves the thread.
- **Target lifecycle:** delete and restore the target.
- **Watcher:** an agent's own reply clears pending, and a root claim does not make the agent an editor of anyone's comment.

## Decisions

1. **Comments appear in search and recents.** Decided 2026-10-28. #332 instead hid threads from those surfaces, through an ancestor-based filter that each enumerating surface routes through. That was rejected: it is a seam every future enumerating surface has to remember, and it leaks wherever one forgets it. With comments shown, searching for "fix the intro" finds the comment that says it, and a comment just written is one recents click away. The accepted cost is agent replies in recents.
2. **Open: margin before agents, or agents before margin?** The two slices are independent. The pick is agents first, because the mention path needs only prompt context, and the margin needs the read-mode spike.
3. **Open: the container alias.** `Comments (km)` is unique, but visible and ugly. The alternative is a kernel-page variant with no alias, as #332 proposed: cleaner, and one more page mechanism to keep. Pick: the alias.

## Compared with the earlier design (#332)

This design was drafted before reading #332. The two agree on most of the core:

- threads are blocks under a workspace container;
- the anchor is properties on the thread root, never markers in the content;
- discovery goes through a ref property and `source_field`;
- resolution is lazy, with a stale fallback, and no automatic anchor writers;
- creation starts from an edit-mode selection;
- deleting the target orphans the thread and restoring it brings the thread back;
- no synced annotations table.

**Taken from it:**

- the metadata root with comments as children (this design first had the root double as the first comment; attribution is what settled it);
- flushing the debounced editor write before anchoring;
- re-validating an anchor inside the tx that persists it;
- the render-surface policy;
- a widenable status enum;
- a container alias that cannot collide.

**Where this one differs:**

- **One `ref` target and scalar quote properties, instead of a `refList` mirror plus a JSON segments payload.**
  - Why this one: the generic merge retargeter rewrites ref-property values as well as their entries (`mergeRetargetProcessor.ts:217-275`, since 9d93fd9bfe8). So a block id that lives only in a ref property follows a merge with no help. What the retargeter cannot see is a block id inside a JSON payload. That copy of the id is what forced #332's dedicated annotation merge processor, its mirror invariant and the tests for both.
  - The cost: a multi-block comment would need a new property, because changing `ref` to `refList` is a frozen codec change. No multi-block selection model exists to need one.
- **No hiding seam.** Comments are blocks that search and recents show, per requirement 1. The only special case is the anchor edge in generic backlinks, and that is one exclusion owned by the backlinks plugin.
- **A lazy container** through the existing `getOrCreateKernelPage`, instead of an eager `systemPagesFacet` ensure that mints a page in every workspace on open.
- **Disambiguation by nearest-to-hint** instead of prefix and suffix context, as explained under Anchoring.
- **Added:** the side margin, authorship, the queries, agent tools, the watcher kind, and mentions.
- **Dropped:** edit suggestions. They are not asked for here. The status enum can widen for them, and a `kind` property can arrive as a new seed.
