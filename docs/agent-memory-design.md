# Agent memory: graph-stored instructions injected at connect

> **Status:** proposal, not built. Refs #472, part of the agent-ergonomics epic #1237. Last verified against code: 2026-10-17 (master `90973a13a2`).
>
> **Revised 2026-10-17.** Earlier revisions of this doc made every agent write a proposal that the user had to accept. Vlad judged that too much friction. Agents now write memory directly, as they do in beads, and only unattended dispatch runs are restricted. The proposal flow is in this PR's history.

## The proposal in brief

- Each workspace gets one **Agent memory** system page. Every top-level child of that page is one memory. The child's content is the memory's one-line index entry, and its children are the body. If a block is on the page, it is active. Taking it off the page retires it.
- When an agent connects, the km MCP server adds a memory section to its `instructions`. Pinned memories that apply to the whole workspace appear in full. Every other memory appears as one index line. The section ends with a short note on how to add memories. Agents read full text with a `memory` tool.
- A memory can narrow itself to part of the graph with `agent-memory:applies-to` refs to pages. A memory with no refs applies to the whole workspace.
- **Agents write memory directly.** `remember` adds a memory, and the ordinary write tools edit or delete one. The one exception is unattended dispatch runs, which read web content with nobody watching. By default, dispatch's MCP server refuses their memory writes, and they suggest a memory in their reply instead. A daemon setting lifts the restriction.
- Precedence: host files (CLAUDE.md, AGENTS.md) and the current task rank above graph memory, and graph memory ranks above the server's static guide. The memory section says so in words. It sits last in `instructions`, so if a host cuts the text short, only memory gets shorter.

The sections below answer the issue's four questions in order. Each gives one recommendation, the rejected alternatives in a line each, and the facts it rests on.

## What exists today

These are the facts the design leans on, checked against code on the date in the banner.

- **MCP `instructions`.** `createGraphMcpServer` (`packages/agent-cli/src/mcpServer.ts`) sends a static `KM_MCP_INSTRUCTIONS` guide of 1,818 chars (from #1236, PR #1241). It appends the caller's `serverOptions.instructions` after the guide. The dispatch wrapper (`packages/agent-dispatch/src/mcp.ts`) passes a 221-char channel string, and only when the channel listener is on. The server has 19 tools (`KM_MCP_TOOL_NAMES`). Every write tool calls `beforeWrite` with a `GraphMcpWriteOperation` first, and that type covers all eight write operations. Dispatch plugs its blocked-wikilink guard into this hook.
- **Claude Code's handling of `instructions`.** According to the Claude Code docs, instructions load once, when the server connects, and the docs say nothing about refreshing them mid-session. The cap comes from the Claude Code changelog, and text past it is cut without notice. Versions from 2.1.84 cut at **2,048 chars**; from 2.1.296 the default is 4,096. The version installed on the machine where this was written is 2.1.285, the binary dispatch spawns. On it, the static guide plus dispatch's text already take 2,041 of the 2,048 chars. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` changes the cap. I don't know whether Codex surfaces `instructions` at all.
- **Tokens.** Since PR #1244, tokens are bound to the user, not a workspace (`src/plugins/agent-runtime/tokens.ts`). Reads take the workspace as a per-call parameter that defaults to the tab's open workspace. There are two scopes, `read-write` and `read-only`. The bridge enforces read-only from each verb's `readOnly` flag in `knownCommandRegistry` (`packages/agent-cli/src/protocol.ts`). A read-write token reaches every bridge verb, including `eval`, `sql execute`, `install-extension` and `run-action`. The MCP server exposes no eval.
- **Agent writes run as the user.** Verbs in `src/plugins/agent-runtime/commands.ts` call `repo.tx` with `ChangeScope.BlockDefault`. `TxMeta` (`src/data/api/tx.ts`) carries no actor, so once a write commits, nothing distinguishes an agent write from one the user made. The `recent_changes` tool lists recent transactions on the local device.
- **The prefs blocks are not private.** `getUserPrefsBlock` / `getPluginPrefsBlock` (`src/data/stateBlocks.ts`) live under the user page and write under `ChangeScope.UserPrefs`. That scope is not undoable and is allowed in read-only mode. Block RLS is workspace membership (`blocks_read` → `is_workspace_member`), so every member can read a user's prefs subtree.
- **System pages.** `systemPagesFacet` plus `getOrCreateKernelPage({namespace, alias, markerType})` give a page with a derived id per workspace. Journal, Properties, Types, Recents and Locations use this. `getOrCreateKernelPage` commits its own transaction.
- **Same-tx processors.** These run inside the writing transaction (`sameTxProcessorsFacet`, `src/data/api/sameTxProcessor.ts`).
- **Dispatch.** Runs get `WebSearch` and `WebFetch` by default (`defaultAllowedTools` in `packages/agent-dispatch/src/config.ts`), with a documented trade-off: an injected page can steer a run that holds write tools. `writeMcpConfig` writes one MCP config per daemon, not per run. `prompt.ts` renders each run's prompt from the mention's content, subtree and ancestors. `SPLIT_REPLY_GUIDANCE` is appended to the *rendered* prompt, so it reaches custom templates too.
- **Roles.** Workspace roles are `owner`, `editor` and `viewer`.

## The shape: stored blocks and what an agent sees

### Stored blocks

The agent-runtime plugin registers the memory page through `systemPagesFacet`, so it is ensured when a workspace opens. Its id is derived from the workspace id, the same way the Journal page's is. The key contains no user text, so under e2ee the id reveals no more than Journal's does.

Unlike Journal, the page claims **no alias**. An existing workspace may already have an ordinary page called "Agent memory". With a contested alias, `[[Agent memory]]` would keep opening that old page while agents use the system page. Users open it with an "Open agent memory" command and from the agent tokens dialog instead. Both get-or-create or restore the page before navigating, because the ensure at workspace open may have been skipped. A `[[Agent memory]]` link typed by hand is an ordinary page link; accepted.

```text
Agent memory                                          ← system page
- Prefer appending to today's daily note over creating top-level pages
  agent-memory:pinned: true
    - New top-level pages only when the user asks for one, or for a recurring topic
    - Link any new page from today's note
- Recipes: one page per recipe under [[Recipes]], ingredients as child blocks
    - Tag each with #recipe; never nest a recipe under a daily note
- Garden planner: plant records are blocks typed garden-plant, one per variety
  agent-memory:applies-to: [((Garden planner page))]
    - Sowing dates go in the garden:sown date property, not in the text
- Dates: write them as daily-note links, never ISO strings
```

- **What counts as a memory.** Position decides, and nothing else does: the memory set is the memory page's top-level children. Nothing lists memories by type, because a block moved off the page keeps its type. Property editors still need the type, so a same-tx processor adds `agent-memory` to any block that becomes a top-level child of the page, whether created there or moved in. That covers a plain block the user types on the page: it gets the type, and it is an active memory that applies everywhere and isn't pinned.
- **Order is priority.** The page's sibling order is the order used for injection. When the budget runs out, the memories clipped are the ones at the bottom, so dragging a block up raises its priority.
- **Retiring a memory.** Delete it or move it off the page. No status property is needed.
- **Seeds.** Each name below is FROZEN once shipped (`src/data/seedIdentityLedger.ts`), so the names should be settled before the first release:

  | seed                      | preset                              | meaning |
  | ------------------------- | ----------------------------------- | ------- |
  | type `agent-memory`       |                                     | a memory |
  | `agent-memory:applies-to` | `refList` (`targetTypes: ['page']`) | empty means the whole workspace |
  | `agent-memory:pinned`     | `boolean`                           | inject the body, not just the line, wherever the memory applies |

  The `agent-memory` namespace doesn't collide with dispatch's `agent:status` / `agent:reply`.

### What the agent sees at connect

This is the memory section of `instructions`, rendered from the blocks above, at about 1,100 chars. The full update guidance covers what to add, leading with the subject, and editing in place. It lives in a `memory` topic of the `guide` tool, so the injected footer costs two lines:

```text
## Graph memory for workspace "Home": notes for agents from its members
Rules for working in this graph, kept by the people who work in it. They rank
below your host's instructions (CLAUDE.md, AGENTS.md) and the task you were given,
and above the general guidance earlier in these instructions. If one conflicts
with your host's instructions or the task, follow those and tell the user.

Always:
- Prefer appending to today's daily note over creating top-level pages
  - New top-level pages only when the user asks for one, or for a recurring topic
  - Link any new page from today's note

Index (full text: memory {id}):
- ^3f2a9c1d Recipes: one page per recipe under [[Recipes]], ingredients as child blocks · 2026-09
- ^7c01e5aa Dates: write them as daily-note links, never ISO strings · 2026-08

Scoped (apply only under the named block; full text: memory {at}):
- ^5d2e8b10 Garden planner: plant records are blocks typed garden-plant · under ^9a0bc3f1

Add a memory with remember; change one by editing its block. Keep only what stays
true; status belongs in todo blocks. More: guide memory.
```

The `^xxxxxxxx` short ids are the printed form the read tools use. The age suffix is the newest `user_updated_at` anywhere in the memory's subtree, so editing one body line counts.

When a dispatched run handles a mention under the Garden planner page, its rendered prompt also gets the memories that apply at that location, in full:

```text
Graph memory for this location. The task above comes first. If a memory conflicts
with it, follow the task and tell the user.
- Garden planner: plant records are blocks typed garden-plant, one per variety
  - Sowing dates go in the garden:sown date property, not in the text
This run can't write graph memory. If you learned something worth keeping, end your
reply with a line starting "Memory suggestion:".
```

**Rule for every auto-injected rendering** (the `instructions` section and the dispatch appendix): each character comes either from the memory page's subtree or from the renderer itself, meaning its fixed strings, short ids and dates. Block refs, embeds and `applies-to` targets therefore render as short ids. They never expand into a referenced block's content or a page's current title. There are two reasons. The injected text should be exactly what a person sees when they read the memory page. And dispatch runs, which can't write the memory page by default, can write every block outside it. Both renderings open with the same precedence line, which comes from one place in the renderer, so the dispatch appendix can't drift from the connect section. The ranking is stated in words because position alone doesn't tell a model which instruction wins.

## Q1. What is a "project"?

**Recommendation.** The workspace is the unit of memory: one memory page per workspace, the same unit every read and write already selects. A memory narrows itself with `agent-memory:applies-to` refs to pages. A memory **applies at block B** when it has no `applies-to`, or when one of its target pages is B or an ancestor of B. Pages are where projects live, and limiting the targets to pages gives the property a page picker.

**How an agent learns its location.** An agent doesn't declare a project when it connects; location comes with each request:

- **At connect**, there is no location. `instructions` carries workspace-wide memories (pinned ones in full, the rest as index lines) and one index line for each scoped memory, pinned or not.
- **Dispatch** knows each run's mention block. It renders the memories that apply there onto the per-run prompt, using the same bridge verb with `at: <blockId>`. The prompt is the right place because the MCP config is per daemon, not per run. This follows the `SPLIT_REPLY_GUIDANCE` precedent, so custom templates get it too.
- **Query-watcher runs** have no single location. Their rows can span several pages, or not be blocks at all, so they get no location appendix. They still get each scoped memory's index line from connect, with the block it applies under. The query prompt gains one line: before changing a block, call `memory {at}` for it. I rejected merging every row's scoped memories, because a batch of rows can span any number of pages.
- **Interactive sessions** call `memory {at}` when they start working under a page. Optionally, the bounded page and outline views add one hint line when memories apply under the block being viewed.

There's a bonus: `applies-to` is a ref, so the Garden planner page's backlinks list the memories that govern it.

**Rejected.**
- *A separate project entity* (a project type, or a picker at connect). This adds a second scoping concept to maintain beside the tree, and the tree already says "under this page."
- *Placement as scope* (memories living under the pages they govern). Memory would be scattered across the graph, so no single page would show what agents are told. Moving a block would also silently change its scope.
- *An agent-declared project name* (an env var or argument). A name is not an identity: it breaks on rename (record-grain doctrine), and nothing validates it.
- *Workspace only, with no sub-scope.* A workspace holds unrelated contexts, which is the issue's own premise. Every project's conventions would land in every session and use up the instructions budget.

## Q2. Where does memory live?

**Recommendation.** Memory is shared by the workspace. There is one system page per workspace, owned by the agent-runtime plugin. Edits to it are ordinary `ChangeScope.BlockDefault` writes, which are undoable and refused in read-only mode. There is no per-user tier in v1.

Memories are documents. You want to edit, undo, link and read them like any page. The prefs blocks give none of that, and they aren't as private as the name suggests. Their scope can't be undone and is allowed in read-only mode, which is the wrong policy for text that steers every agent. In a shared workspace, any editor or their agent can write memory, just as any editor can edit any page; viewers can't. If a shared workspace ever needs a per-user audience, a later `agent-memory:for-user` ref to a user page can be added without breaking anything.

**Rejected.**
- *Under `getUserPrefsBlock` / plugin prefs.* Other members can read it anyway. It isn't undoable, it's allowed in read-only mode, and it's buried in the user-page tree where nobody looks.
- *Workspace and per-user tiers now.* That means two places to look for one rule, and with about two users there is no need yet.
- *A list of memories in one JSON property.* This is a record-grain violation: no references, no undo per memory, and concurrent writes overwrite each other.
- *Outside the graph* (a device-local file, like the tokens #71 moved out). It doesn't sync across devices, doesn't reach a dispatch daemon on another machine, and can't be edited in the app. Tokens are credentials; memory is content the workspace's members edit in the graph, which is the point of the issue.

## Q3. Precedence and composition

**Facts.** We control only the text inside our server's `instructions`. The host decides where that text sits and how it's framed. In Claude Code, CLAUDE.md is presented as user instructions that override defaults, while MCP instructions are a section provided by the server. All of our `instructions` share one cap: 2,048 chars on Claude Code before 2.1.296, and 4,096 from 2.1.296 on.

**Recommendation.** Graph memory covers the graph's domain; it doesn't compete with CLAUDE.md. It governs how to work with this graph. It ranks **below** the host's instruction files and the current task, and **above** the server's static guide. Composition is concatenation in a fixed order with no merging:

```text
[static guide, 1,818] → [caller's instructions, e.g. dispatch channel, 221] → [graph memory, the rest]
```

- **The order follows size, not rank.** Memory is the only section whose size varies, so it goes last. If a host's cap is smaller than the text, the host's silent cut can only shorten memory, never the static guide or dispatch's rules. Rank is stated in words in the memory header.
- **The total budget defaults to 4,096 chars**, which has been Claude Code's default since 2.1.296. It's a setting, for clients with a different cap. Memory gets what's left after the fixed sections, about 2,000 chars. Our renderer clips memory to that budget and says so in the text.
- **On Claude Code older than 2.1.296**, including the 2.1.285 installed here, the static guide and dispatch's text already fill the 2,048 cap, so memory is cut entirely. Agents there can still call `memory`. The fix is upgrading Claude Code, or trimming the static guide.
- Dispatch's own rules cannot be overridden: the reply shape, and never writing the watcher wikilink. They are part of the task, which ranks above memory. A memory saying "always mention [[claude]]" would still be outranked.
- **Unverified:** I don't know whether Codex surfaces `instructions`. If it doesn't, the Codex executor also gets the workspace-wide section in its prompt, from the same renderer.

**Rejected.**
- *Memory above host files.* Host files are reviewed where they live, in a repo or a home directory. Agents write memory freely, so the reviewed source should win.
- *Order by rank (memory before the caller's text).* On a host with a small cap, the cut would then drop dispatch's rules instead of memory.
- *Choosing the budget from the client's `clientInfo`.* The MCP SDK records it at initialize, so it's possible. But on a 2,048 client there's no room to give memory anyway.
- *Semantic merge or dedup across sources.* It would mean judging conflicts between texts that nobody diffs. Concatenation, a stated precedence and "tell the user" are easier to follow.
- *Memory only through a tool, with nothing injected.* That loses what the issue is about: a learnable system prompt that is always visible. Agents skip optional tool calls.

## Q4. Safety

**Threat.** A dispatched run is unattended, has `WebFetch` by default, and holds graph write tools. A fetched page tells it to plant a memory, and that memory then reaches every future session. Today the same run can already write any block, and the dispatch config accepts that risk. What memory adds is **auto-injection**: one write becomes standing instructions for all future runs.

**Recommendation: agents write memory directly; unattended dispatch runs don't, by default.**

1. **Interactive sessions and other MCP clients write memory like any page.** That means `remember`, `edit_block`, `update_block`, `delete_block` and the rest, with nothing gating them. This is the beads trade. A person is watching, the page is a normal page, the index shows each memory's age, and undo works.
2. **Dispatch runs are refused by dispatch's own write guard.** The dispatch MCP wrapper already plugs a guard into `beforeWrite` for watcher wikilinks. A second check joins it there. It refuses `remember`, and any write whose target block or new parent is the memory page or inside it. Per operation, that means:
   - `create_block`: the parent.
   - `update_block`, `edit_block`, `delete_block`, `restore_block`: the block.
   - `move_block`: the block's current place and its new parent.
   - `append_markdown`: the target.

   The message names the fix: *"This run can't write graph memory. Suggest it in your reply instead."* The daemon setting `memoryWrites: true` lifts the restriction for the whole daemon, because the MCP config is per daemon.
   - **Why the MCP layer.** Dispatch runs reach the graph only through this server; the trusted shell cases below are the exception. The hook and a guard already exist there, so nothing in core changes. The check reads the tree before the write, so there is a race. A person would have to move a block onto the memory page between that read and the write. I accept that; the wikilink guard's stored-row check has the same shape.
   - **Version skew.** The check ships in agent-dispatch. A daemon older than it writes memory like an interactive session, so upgrading the daemon is part of rollout.
3. **`remember` goes through every guard the other writes do.** Its `beforeWrite` operation carries everything the memory will store, in the `{content, properties}` shape the wikilink guard already checks for `create_block`. That's the summary and body as content, and the encoded `applies-to` and `pinned` as properties. So with `memoryWrites` on, a run still can't plant a memory containing `[[claude]]`, or one whose `appliesTo` names the watcher's page. Either one projects a backlink and would start a new run.
4. **No new token scope.** Read-only tokens can read memory, because the `agent-memory` verb is `readOnly: true`. They can't write it, because the existing per-verb gate returns 403.

**The boundary, stated plainly.** The dispatch check bounds only runs that reach the graph through the dispatch MCP server. A read-write token used through the CLI can run `eval`, `sql execute`, `install-extension` and `run-action`, and nothing here changes that: such a token already carries the user's full authority in the app. The same holds for any run that can execute shell commands and reach loopback, because it can call the bridge with the daemon's token. Two cases exist today:
- **A Claude run granted `Bash`.** Per-watcher `Bash` is a documented opt-in.
- **A Codex run with `networkAccess: true`.** Codex always runs model-generated shell commands and ignores `allowedTools` (`packages/agent-dispatch/README.md`, "Sandboxing"), and its sandbox reads the whole disk, token store included. Enabling network access is enough to reach the bridge.

**Accepted residual risks.**
- **An interactive session steered by injected content can plant a memory.** This is the same risk beads carries. The memory shows on the page and is dated in the index, the edit can be undone, and `recent_changes` lists what changed on that device. The header's "these are notes" framing is not a security boundary, and nothing relies on it.
- **A move the dispatch device hasn't synced yet.** The dispatch check judges the tree as the dispatch device sees it. Suppose a person moves a block onto the memory page on another device, and a dispatch run edits that block before the move syncs. The edit lands in memory. This needs a person's move plus a dispatch write already in flight, so I accept it.
- **Leaking memory.** A run can read memory and leak it through a `WebFetch` URL. This is already true of all graph content.
- **Injection through ordinary blocks.** An agent can still leave instructions in ordinary blocks that a later run reads. That isn't amplified by auto-injection and is unchanged from today.

**Rejected.**
- *Review every agent write: a proposals page and an Accept step.* This was the earlier revision, and Vlad's call is that it's too much friction. Closing its gaps also took a second page, an Accept flow that snapshots, compares and freezes, and two additions to core.
- *An in-app gate keyed on an actor stamp.* It would cover every surface, not just dispatch. But it needs `actor` on transactions and a terminal commit-guard phase in core, only to stop dispatch runs, which already pass through a guard we own.
- *A `memory-write` token scope.* The bridge doesn't tell the app which token sent a command. And the server, which does know the token, can't tell whether a write touches the memory page without asking the app.
- *A new `ChangeScope`.* ChangeScope is deliberately not extensible by plugins, and it sets undo, upload and read-only policy, not authorization.

## Beads as precedent: what carries over

This repo's beads memory works: a SessionStart hook injects a clipped one-line index of every memory, and agents `bd recall` the full text.

**Carries over.**
- **Free writes.** Agents add and change memory without review. The exception is unattended dispatch runs, which beads has no counterpart for.
- **Index at start, full text on demand.** `memory {id}` plays the role of `bd recall`. Previews are clipped evenly to fit the budget, as `scripts/bd-prime-hook.mjs` does for the 10K hook limit.
- **The first line is the index entry, so lead with the subject.** In an outliner this comes naturally: the block's content is the line and its children are the body.
- **Memory versus issue.** Memories hold what stays true. Anything with state goes into a todo block. The update guidance says so.
- **Update in place.** An agent edits the memory's block, the way `bd remember --key` updates the same key.

**Better here.**
- **Timestamps.** bd memories have none, which is the staleness problem AGENTS.md describes. Blocks carry edit times, so the index shows each memory's age, taken from the newest edit anywhere in its subtree.
- **Links.** Memories can link pages, and scoped memories show up in their target's backlinks.

**Doesn't carry over.**
- **Key prefixes as kinds** (`feedback_`, `reference_`). Here the block id is the identity, and v1 doesn't need a kind property.
- **The delivery channel.** Beads uses a Claude Code SessionStart hook with a 10K limit. Graph memory uses MCP `instructions`, which share the client's cap with the static guide but reach any MCP client. For agents that use only the CLI, a `kmagent memory --index` verb could feed a SessionStart hook the same way `bd prime` does. That is optional, and it is also a way around the `instructions` cap.
- **Privacy.** Beads memory syncs to a private remote. Every member of the workspace can read graph memory.

## Delivery mechanics

- **Bridge verb `agent-memory`** (`readOnly: true`), executed in the app by agent-runtime.
  - Arguments are `{at?, ids?, after?, budget?, workspaceId?}`, and it returns `{text, counts, truncated}`.
  - It picks the workspace the way every read does: `workspaceId`, or the tab's open workspace. The connect section names the workspace it loaded, so an agent working in a different one knows to call `memory {workspaceId}`. Naming a workspace grants nothing new, because a token reaches only workspaces its user may read.
  - Rendering sits next to the agent views in `src/plugins/agent-runtime/`, so knowledge of the type and its properties stays in the plugin.
  - It reads by derived id and **never creates** the page; a missing page means no memories.
- **Creating the page.** `remember` ensures the memory page inside the same transaction that writes the memory. `getOrCreateKernelPage` commits its own transaction, so a delete could land between it and the write, and the insert would then fail on a dead parent. `remember` therefore uses an in-transaction get-or-create-or-restore helper. The open command and the dialog link use the same helper before navigating.
- **Budget rendering.**
  - Pinned bodies go first, but only for memories that apply where this rendering is. At connect that means workspace-wide ones, and in a location rendering, those matching `at`. A pinned scoped memory is an index line at connect. If the pinned bodies alone overflow, they're clipped with "N pinned memories didn't fit".
  - Then index lines, clipped evenly and in page order.
  - Then a continuation line: "+N more: call memory to page through the full index." It carries no cursor. Pinned bodies come first, so the memories listed are not a contiguous run in page order, and resuming after any one of them could skip some. Paging from the top repeats a few lines but never skips one.
  - Every cut is stated in the text.
- **At connect.** Both MCP entrypoints await the verb before `connect`, with a short timeout of about 2s. They compose the sections in Q3's order through a shared `composeInstructions(sections)` helper, which gives memory whatever the fixed sections leave of the total. If the verb doesn't answer or refuses, the memory section is one line stating which. For example: *"Graph memory was not loaded at connect (the app's bridge did not answer). Call memory to read it."* A refusal quotes the verb's own reason. With no memories at all, the section is one line naming `remember`.
  - `createGraphMcpServer` builds its `instructions` when the server object is constructed, and the constructor is synchronous. So it needs an async loader, or the entrypoints fetch first and pass the memory section in.
- **Tools, mirrored as CLI verbs.**
  - `memory` reads:
    - With no arguments, it returns the index one bounded page at a time, in page order.
    - `{after: id}` continues after that memory, so a memory cut by any budget can still be reached.
    - `{id}` returns the full subtree, `{at}` returns the memories that apply there, and `{workspaceId}` picks the workspace.
  - `remember` writes. It takes `{summary, body?, appliesTo?, pinned?}`, adds a memory at the end of the page, and returns *"Remembered ^abcd1234."*
  - To change or retire a memory, agents use the ordinary write tools on its block.
  - Both names go into `KM_MCP_TOOL_NAMES`.
- **Staleness within a session.** Instructions are fixed at connect. A memory added mid-session shows up through `memory` but isn't injected again. Beads behaves the same way.
- **Failure paths.**
  - Bridge down: the one-line notice above.
  - An agent working in a workspace other than the one named at connect: `memory {workspaceId}` reads that workspace's memory.
  - `applies-to` pointing at a deleted page: the memory applies nowhere, and `memory` lists it as such.
  - A dispatch run writing memory without `memoryWrites`: refused with the message above.
  - The memory page is missing when `remember`, the command or the dialog link runs: the in-transaction helper creates or restores it.

## Implementation slices (for when this is accepted)

1. **Seeds and the page.** In agent-runtime: the type and property seeds, the memory system page (no alias), the tag-on-entry processor, the "Open agent memory" command, and the tokens-dialog link. Both entry points get-or-create the page before navigating.
2. **Verb, renderer and tools.** The `agent-memory` verb and its renderer with budgets, plus the `memory` / `remember` tools and CLI verbs. `remember` goes through `beforeWrite`.
3. **Connect-time injection.** `composeInstructions` in both MCP entrypoints, with memory last.
4. **Dispatch.** The memory check in dispatch's `beforeWrite` guard and the `memoryWrites` setting.
   - Tests must fail when the check is removed, covering each write operation: a create under the page, an edit or delete of a memory, a move onto the page and a move off it, and an `append_markdown` into it.
   - Tests also pin the wikilink guard's refusal of a `remember` that contains `[[claude]]`, or whose `appliesTo` names the watcher's page, under `memoryWrites`.
   - Also in this slice: the location appendix with its suggestion line, and the Codex `instructions` check.
5. **Optional.** The view hint line, and the CLI SessionStart-hook recipe.

## Decisions for Vlad

1. **Should agents write memory directly, with only unattended dispatch runs refused by default?** I recommend yes. Refused runs suggest a memory in their reply, and `memoryWrites: true` lifts the restriction.
2. **Workspace-shared memory only, with no per-user tier in v1?** I recommend yes. A later `agent-memory:for-user` ref can be added without breaking anything if a shared workspace needs it.
3. **Scope memories with `applies-to` refs, rather than placing them under the pages they govern?** I recommend refs, so that one page shows everything agents are told.
4. **Put memory last in `instructions`, budget the total for 4,096 chars, and upgrade the Claude Code installed here?** I recommend yes. Version 2.1.285 has no room left once the static guide and dispatch's text are in. The alternative is trimming the 1,818-char static guide.
5. **Approve the frozen names: type `agent-memory`, plus `agent-memory:applies-to` and `agent-memory:pinned`?** I recommend yes. They can't be renamed after the first release without a migration.
6. **Treat the read-write CLI surface and every run with a shell and loopback access as trusted, outside the dispatch check?** I recommend yes. The CLI surface is `eval`, `sql execute`, `install-extension` and `run-action`. The shell cases are a Claude run granted `Bash` and a Codex run with `networkAccess: true`. Gating them would mean sandboxing eval and the shell, which this design doesn't attempt.
