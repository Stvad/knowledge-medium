# Agent memory: graph-stored instructions injected at connect

> **Status:** proposal, not built. Refs #472, part of the agent-ergonomics epic #1237. Last verified against code: 2026-10-17 (master `90973a13a2`).

## The proposal in brief

- **The page.** Each workspace gets one **Agent memory** system page. Every top-level child of that page is one memory. The child's content is the memory's one-line index entry, and its children are the body. If a block is on the page, it is active, and the page's order is the priority.
- **What an agent gets at connect.** The km MCP server adds a memory section to its `instructions`. The memories that apply to the whole workspace come first, in page order: in full while they fit, then one line each. Each scoped memory gets one line. `memory {at}` reads what applies under a block, and `subtree [[Agent memory]]` reads everything.
- **Scope.** A memory can narrow itself to part of the graph with `agent-memory:applies-to` refs to pages. A memory with no refs applies to the whole workspace.
- **Agents write memory with the ordinary tools.** `append_markdown` to `[[Agent memory]]` adds a memory, and `edit_block` or `delete_block` changes one. Nothing is reviewed first.
- **Unattended agents can't write it.** That means dispatch runs and scheduled jobs. Each one pairs with an `unattended` token. The bridge lets that token run only reads and block writes. The app refuses any transaction from it that changes a row in the memory page's subtree, and that includes rows other processors rewrite.
- **Precedence.** Host files (CLAUDE.md, AGENTS.md) and the current task rank above graph memory, and graph memory ranks above the server's static guide. The memory section says so in words. It goes last in `instructions` and is sized to the client's cap, so the host never cuts into it.

The sections below answer the issue's four questions in order. Each gives one recommendation, the rejected alternatives in a line each, and the facts it rests on.

## What exists today

These are the facts the design leans on, checked against code on the date in the banner.

- **MCP `instructions`.**
  - `createGraphMcpServer` (`packages/agent-cli/src/mcpServer.ts`) sends a static `KM_MCP_INSTRUCTIONS` guide of 1,818 chars (PR #1241), then appends the caller's `serverOptions.instructions`.
  - The dispatch wrapper (`packages/agent-dispatch/src/mcp.ts`) adds a 221-char channel string, but only in ambient channel sessions. Spawned runs and plain km sessions carry the 1,818 chars alone.
  - Every write tool calls `beforeWrite`, and the `GraphMcpWriteOperation` type covers all eight write operations. `create_block`'s `parentId` and `append_markdown`'s `target` reach that hook as typed, before the app resolves them.
- **Claude Code's handling of `instructions`.**
  - From the Claude Code docs: instructions load once, when the server connects, and the docs say nothing about refreshing them mid-session.
  - From its changelog, text past the cap is cut without notice. Versions from 2.1.84 cut at **2,048 chars**; from 2.1.296 the default is 4,096. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` changes the cap.
  - The version installed on the machine where this was written is 2.1.285, the binary dispatch spawns. On it, a spawned run has about 228 chars left after the static guide, and an ambient channel session about 7.
  - The MCP SDK records the client's `clientInfo` (name and version) when it handles initialize.
  - I don't know whether Codex surfaces `instructions` at all.
- **Tokens.**
  - Since PR #1244, tokens are bound to the user, not a workspace (`src/plugins/agent-runtime/tokens.ts`).
  - Reads take an optional `workspaceId`. Without one, a call goes to the most recently focused tab, and that tab's views refuse a workspace it doesn't have open. Writes go to the open workspace.
  - There are two scopes (`tokenScopeSchema`, `packages/agent-cli/src/protocol.ts`): `read-write` and `read-only`.
  - The bridge server refuses a read-only token any verb not marked `readOnly` in `knownCommandRegistry`. A read-write token reaches every bridge verb, including `eval`, `sql execute`, `install-extension` and `run-action`.
  - The server enqueues the caller's payload plus a command id. The app is not told which token sent a command.
- **Attribution.**
  - Bridge writes run as the user, under `ChangeScope.BlockDefault`. Each transaction is described `agent runtime <verb>` (`src/plugins/agent-runtime/agentWrites.ts`), and `recent_changes` lists agent writes by that description.
  - The description lives in the local `command_events` table. It doesn't sync, and `eval`, `sql execute` and `run-action` don't set it.
  - `TxMeta` (`src/data/api/tx.ts`) has no actor field.
- **The prefs blocks are not private.** `getUserPrefsBlock` / `getPluginPrefsBlock` (`src/data/stateBlocks.ts`) live under the user page and write under `ChangeScope.UserPrefs`. That scope is not undoable and is allowed in read-only mode. Block RLS is workspace membership (`blocks_read` → `is_workspace_member`), so every member can read a user's prefs subtree.
- **System pages.**
  - `systemPagesFacet` plus `getOrCreateKernelPage({namespace, alias, markerType})` give a page with a derived id per workspace. Journal, Properties, Types, Recents and Locations use this.
  - The helper requires an alias and uses it as the page's title. It gives up an alias another page already holds instead of failing.
- **Processors that rewrite other blocks.** Two same-tx processors run inside the writing transaction and rewrite blocks the transaction never named. The alias-rename processor rewrites `[[old]]` to `[[new]]` in blocks that link the renamed page. The deleted-block-ref processor inlines a deleted block's content where other blocks referenced it. Both write with `skipMetadata`, which moves `updated_at` but not `user_updated_at`.
- **Dispatch.**
  - Runs get `WebSearch` and `WebFetch` by default (`defaultAllowedTools`), with a documented trade-off: an injected page can steer a run that holds write tools.
  - The daemon posts each run's reply under the mention block itself, through its own bridge client, with the daemon's token.
  - `buildClaudeArgs` passes no `--setting-sources`, so spawned Claude runs inherit the user's and the project's permission allow rules (#1287).
  - `writeMcpConfig` writes one MCP config per daemon. Ambient channel sessions use a `.mcp.json` the user writes.
  - `prompt.ts` renders each run's prompt from the mention, and `SPLIT_REPLY_GUIDANCE` is appended to the *rendered* prompt.
  - A query-watcher run's final text goes only to the daemon log.

## The shape: stored blocks and what an agent sees

### Stored blocks

The agent-runtime plugin registers the memory page through `systemPagesFacet` with `getOrCreateKernelPage`, alias "Agent memory", exactly as Journal is registered. Its id is derived from the workspace id, so under e2ee it reveals no more than Journal's does.

The alias can be contested. If a workspace already has an ordinary page called "Agent memory", the helper leaves that alias where it is. `[[Agent memory]]` then names the old page, and a memory written through it lands outside the memory page. Journal carries the same exposure today, and I accept it here too.

```text
Agent memory                                          ← system page
- Prefer appending to today's daily note over creating top-level pages
    - New top-level pages only when the user asks for one, or for a recurring topic
    - Link any new page from today's note
- Recipes: one page per recipe under [[Recipes]], ingredients as child blocks
    - Tag each with #recipe; never nest a recipe under a daily note
- Garden planner: plant records are blocks typed garden-plant, one per variety
  agent-memory:applies-to: [((Garden planner page))]
    - Sowing dates go in the garden:sown date property, not in the text
- Dates: write them as daily-note links, never ISO strings
```

- **What counts as a memory.** Position decides, and nothing else does: the memory set is the memory page's top-level children. A same-tx processor adds the `agent-memory` type to any block that becomes a top-level child, whether written there or moved in, so the `applies-to` editor is always there. If someone removes the type by hand, the block stays a memory and only loses the editor; accepted.
- **Order is priority.** Injection walks the page in order, so dragging a memory up makes it more likely to be shown in full.
- **Retiring a memory.** Delete it or move it off the page.
- **Seeds.** Each name below is FROZEN once shipped (`src/data/seedIdentityLedger.ts`):

  | seed                      | preset                              | meaning |
  | ------------------------- | ----------------------------------- | ------- |
  | type `agent-memory`       |                                     | a memory |
  | `agent-memory:applies-to` | `refList` (`targetTypes: ['page']`) | empty means the whole workspace |

### What the agent sees

**One rendering rule.** Every rendering has a location or none.
- It lists the memories that apply there, in page order: in full while they fit half its budget, then one line each.
- At connect there is no location, so "apply" means applies to the whole workspace. Scoped memories follow as one line each, with the block they apply under.
- `memory {at: B}`, and a dispatch run's appendix at its mention, render at a location B. A memory applies at B when it has no `applies-to`, or when one of its target pages is B or an ancestor of B.

This is the connect section for the blocks above, at about 1,000 chars:

```text
## Graph memory for workspace "Home": notes for agents from its members
These rank below your host's instructions (CLAUDE.md, AGENTS.md) and the current
task, and above this server's general guidance. If one conflicts with your host's
instructions or the task, follow those and tell the user.

- ^1b4e7c20 Prefer appending to today's daily note over creating top-level pages
  - New top-level pages only when the user asks for one, or for a recurring topic
  - Link any new page from today's note
- ^3f2a9c1d Recipes: one page per recipe under [[Recipes]], ingredients as child blocks · 2026-09
- ^7c01e5aa Dates: write them as daily-note links, never ISO strings · 2026-08

Scoped (apply only under the named block; memory {at} reads them):
- ^5d2e8b10 Garden planner: plant records are blocks typed garden-plant · under ^9a0bc3f1

Add a memory by appending to [[Agent memory]]; change one by editing its block.
Keep only what stays true; status belongs in todo blocks. More: guide memory.
```

- The `^xxxxxxxx` short ids are the printed form the read tools use.
- The age suffix is the newest `updated_at` anywhere in the memory's subtree. It uses `updated_at` rather than `user_updated_at` so that a processor's rewrite also shows as a fresh edit.
- The full update guidance lives in a `memory` topic of the `guide` tool.

A dispatched run's prompt also gets the rendering at its mention block, below the task. It opens with the same precedence line. It repeats the workspace-wide memories the connect section carried, which I accept, because on a 2,048-char host the connect section has room only for a pointer. A run with an unattended token also gets this line:

```text
This run can't change graph memory. If you learned something worth keeping, end
your reply with a line starting "Memory suggestion:".
```

**Rule for every auto-injected rendering**, meaning the connect section and the dispatch appendix. Each character comes from one of three places:
- the memory page's subtree;
- the renderer itself, meaning its fixed strings, short ids and dates;
- the workspace's name, which members set and no agent tool can change.

Block refs, embeds and `applies-to` targets therefore render as short ids. They never expand into a referenced block's content or a page's current title. That way the injected text is exactly what a person sees on the memory page, and unattended agents, who can't write that page, can't change it. The precedence line comes from one place in the renderer.

## Q1. What is a "project"?

**Recommendation.** The workspace is the unit of memory: one memory page per workspace, the same unit every read and write already selects. A memory narrows itself with `agent-memory:applies-to` refs to pages, which gives the property a page picker. Pages are where projects live.

**How an agent learns its location.** An agent doesn't declare a project when it connects; location comes with each request:
- **At connect**, there is no location, so the agent gets the workspace rendering.
- **Dispatch** knows each run's mention block. It appends the rendering at that block to the run's prompt, using the same bridge verb with `at`. The prompt is the right place because the MCP config is per daemon, not per run.
- **Query-watcher runs** have no single location, and their final text goes only to the daemon log, so they get the connect section and nothing more.
- **Interactive sessions** call `memory {at}` when they start working under a page.

A bonus: `applies-to` is a ref, so a page's backlinks list the memories that govern it.

**Rejected.**
- *A separate project entity* (a project type, or a picker at connect). This is a second scoping concept beside the tree, and the tree already says "under this page."
- *Placement as scope* (memories living under the pages they govern). No single page would show what agents are told, and moving a block would silently change its scope.
- *An agent-declared project name.* A name is not an identity: it breaks on rename, and nothing validates it.
- *Workspace only, with no sub-scope.* A workspace holds unrelated contexts, which is the issue's own premise, and every project's conventions would use up the budget.

## Q2. Where does memory live?

**Recommendation.** Memory is shared by the workspace. There is one system page per workspace, owned by the agent-runtime plugin. Edits to it are ordinary `ChangeScope.BlockDefault` writes, which are undoable and refused in read-only mode. There is no per-user tier in v1.

Memories are documents. You want to edit, undo, link and read them like any page. In a shared workspace any editor, or the editor's attended agent, can write memory, as any editor can edit any page. If a shared workspace ever needs a per-user audience, a later `agent-memory:for-user` ref can be added without breaking anything.

**Rejected.**
- *Under `getUserPrefsBlock` / plugin prefs.* Other members can read it anyway. It isn't undoable, it's allowed in read-only mode, and nobody looks there.
- *Workspace and per-user tiers now.* That means two places to look for one rule, and with about two users there is no need yet.
- *A list of memories in one JSON property.* This breaks record grain: no references, no undo per memory, and concurrent writes overwrite each other.
- *Outside the graph* (a device-local file, like the tokens #71 moved out). It doesn't sync, doesn't reach a daemon on another machine, and can't be edited in the app.

## Q3. Precedence and composition

**Facts.** We control only the text inside our server's `instructions`. The host decides where it sits and how it's framed. In Claude Code, CLAUDE.md is presented as user instructions that override defaults, while MCP instructions are a section provided by the server.

**Recommendation.** Graph memory covers the graph's domain; it doesn't compete with CLAUDE.md. It ranks **below** the host's instruction files and the current task, and **above** the server's static guide. Composition is concatenation in a fixed order with no merging:

```text
[static guide, 1,818] → [caller's instructions: the channel string in ambient sessions, 221] → [graph memory, the rest]
```

- **Memory goes last** because it is the only section whose size varies. Rank is stated in words in the memory header.
- **The budget comes from the client.** At initialize, the server reads `clientInfo`. Claude Code below 2.1.296 gets 2,048 chars, and every other client gets 4,096. Memory gets what the fixed sections leave, and the renderer never emits more than that, so the host's silent cut never lands in our text.
- **On a 2,048-char host** a spawned run has about 228 chars, enough for a one-line pointer such as *"Graph memory: 4 memories apply here. Read them: memory."* An ambient channel session has about 7, so it gets nothing. Upgrading Claude Code gives both the full section.
- **One owner.** `createGraphMcpServer` becomes an async factory that fetches the memory before connecting. It composes the instructions in its own initialize handler. The SDK stores instructions in the `Server` constructor and records `clientInfo` only while handling initialize, so that handler is the only place the budget can be chosen.
- **Dispatch's protocol rules** (the reply shape, never writing the watcher wikilink) live in the per-run prompt. They are part of the task, so they outrank memory.
- **Unverified:** I don't know whether Codex surfaces `instructions`. If it doesn't, the Codex executor also gets the workspace rendering in its prompt.

**Rejected.**
- *Memory above host files.* Host files are reviewed where they live, and attended agents write memory freely, so the reviewed source wins.
- *A fixed budget.* With 4,096, a 2,048-char host cuts our header mid-sentence. With 2,048 everywhere, current clients lose most of their memory.
- *Semantic merge or dedup across sources.* That means judging conflicts between texts nobody diffs; a stated precedence plus "tell the user" is easier to follow.
- *Memory only through a tool, with nothing injected.* This loses the always-visible system prompt that the issue is about, because agents skip optional calls.

## Q4. Safety

**Threat.** An unattended agent reads content nobody reviews, such as a web page, and holds graph write tools. That agent could be a dispatch run with `WebFetch` (the default) or a scheduled job. The content tells it to plant a memory, and the memory then reaches every future session. Such an agent can already write any block. What memory adds is **auto-injection**: one write becomes standing instructions for every later run.

**Recommendation: attended agents write memory freely; unattended agents can't, and the app enforces it.**

1. **Attended sessions write memory like any page,** with nothing gating them. This is the beads trade. A person is watching, the page is a normal page, the index shows each memory's age, and undo works.
2. **An `unattended` token scope.** It's a third value beside `read-write` and `read-only`, chosen when pairing. Agent-dispatch's setup mints one for the daemon by default, and a scheduled job on the plain km server uses one too. An existing daemon keeps the read-write token it was paired with. So the daemon refuses to start unless its token's scope is `unattended`, and the message says how to re-pair. The bridge server does three things with the scope:
   - It lets this scope run only the read verbs and the block writes the MCP server exposes, and refuses everything else, the way it refuses read-only tokens their writes. It's an allowlist, so any other verb is refused by default. That includes a verb added later, and one that runs code indirectly, such as `enable-extension`, which approves an extension's current source and loads it.
   - It stamps each command it delivers with the sending token's scope. The server sets that stamp itself, so an agent can neither forge it nor strip it.
   - It delivers an unattended token's commands only to a tab that registers support for the scope. A tab running an app version from before this feature gets none, so it can never run them without the guard.
3. **One check, after everything else in the transaction.** The app runs an unattended command's transactions with `actor: 'unattended'`. The executor hands its verbs a repo facade that sets this, the same way `repo.undoGroup` injects `groupId`. A new terminal commit-guard phase in core runs after the same-tx processors. The agent-runtime plugin's guard there refuses any unattended transaction that changed a row whose ancestry, before or after the transaction, includes the memory page, or the page itself. The message is: *"Unattended agents can't change graph memory. Suggest it in your reply instead."* Running last, over the rows actually written, closes three gaps at once:
   - **Cascades.** A rename that rewrites a memory's `[[…]]` text is refused, and so is a delete whose block ref gets inlined into a memory. The same goes for any later processor that rewrites other blocks.
   - **Naming.** The guard sees resolved rows, so it doesn't matter whether the target was named by an id prefix, a page name or a date.
   - **Replies.** The daemon posts replies with the same token, so a reply under a mention inside memory is refused too. The daemon skips such mentions up front and logs why, rather than running them only to have the reply refused.
4. **Read-only tokens** can read memory and can't write it. That's the existing gate; nothing new.

**The boundary, stated plainly.** The check bounds what an unattended token can do through the bridge. It doesn't bound a run that can execute code or write files on the machine. Such a run can read another profile's token from the token store, or edit the daemon's config or its hooks, so it carries the user's full authority. Today that means three kinds of run:
- a Claude run granted `Bash`, `Write` or `Edit`, including through inherited settings (#1287);
- a Codex run with `networkAccess: true`, or with `sandbox: "workspace-write"`. Codex always runs shell commands, and its sandbox reads the whole disk. A writable one can also replace the token the km MCP server reads before each command;
- an ambient channel session, which is attended, so its token is the user's choice.

**Accepted residual risks.**
- **An attended session steered by injected content can plant a memory.** Beads carries the same risk. The memory shows on the page and is dated in the index, the edit can be undone, and `recent_changes` lists it on the device that made it.
- **A move another device hasn't synced yet.** The guard judges the tree as the device running the write sees it, and rows that arrive by sync aren't checked again. Suppose a person moves a block onto the memory page on one device, and an unattended run on another edits that block before the move syncs. The edit lands in memory. It takes a person's move plus a run's write in flight, so I accept it.
- **Leaking memory** through a fetched URL. This is already true of all graph content.
- **Instructions in ordinary blocks** that a later run reads. These aren't amplified by auto-injection, so nothing changes from today.

**Rejected.**
- *Review every agent write* (a proposals page and an Accept step, the earlier revision of this doc). Vlad judged it too much friction.
- *A check in dispatch's MCP write guard* (the previous revision). It sees requests, not their cascades, so it misses renames and inlined deletes. It gets targets unresolved. And it never sees the daemon's own reply writes.
- *No restriction at all, as in beads.* This is the cheapest option, but it leaves exactly the case the issue names.
- *A new `ChangeScope`.* ChangeScope is deliberately not extensible by plugins, and it sets undo, upload and read-only policy, not authorization.

## Beads as precedent

Beads memory works because the index is injected at session start, full text is read on demand, the first line is the index entry, and memories hold only what stays true. All four carry over, and agents write freely here too.

What's better here: each memory shows its age, which bd memories lack, and memories can link pages.

What doesn't carry over: beads' private sync, since graph memory is readable by every workspace member, and its 10K SessionStart hook. Graph memory shares the client's `instructions` cap, though a `kmagent memory` verb could feed a SessionStart hook the same way `bd prime` does.

## Delivery mechanics

- **Bridge verb `agent-memory`** (`readOnly: true`), executed in the app by agent-runtime.
  - It takes `{at?, budget?, workspaceId?}` and returns `{text, counts, truncated}`.
  - It reads by derived id and never creates the page; a missing page means no memories.
  - `workspaceId` has the same limit as every other read: the bridge needs a tab with that workspace open.
- **The `memory` tool**, mirrored as a CLI verb, takes `{at?, workspaceId?}`. With no arguments it returns the connect rendering unclipped. `subtree [[Agent memory]]` reads the whole page, bounded and paged like any outline.
- **Writes** use the existing tools, and the tag processor types new memories. A `[[Agent memory]]` target resolves the way any page target does, so if the system page doesn't exist yet and the alias is free, that write mints an ordinary page under the name. Journal has the same race between its ensure and the first link; accepted.
- **Rendering.**
  - Bodies go in full while they fit half the budget, then index lines, clipped evenly in page order.
  - Then comes a continuation line: *"+N more: subtree [[Agent memory]]."*
  - Every cut is stated in the text.
- **At connect.** The async factory awaits the verb with a timeout of about 2s. If the verb doesn't answer or refuses, the memory section is one line stating which. With no memories at all, it is one line saying how to add one.
- **Staleness within a session.** Instructions are fixed at connect, so a memory added mid-session shows up through `memory` but isn't injected again. Beads behaves the same way.
- **Failure paths.**
  - The bridge is down: the one-line notice above.
  - `applies-to` points at a deleted page: the memory applies nowhere, and `memory` says so.
  - An unattended write touches memory: refused with the message above.
  - A mention sits inside memory: the daemon skips it and logs why.

## Implementation slices (for when this is accepted)

1. **Seeds and the page.** The type and property seeds, the system page, and the tag-on-entry processor.
2. **Reading.** The `agent-memory` verb and its renderer, the `memory` tool and CLI verb, and the `memory` guide topic.
3. **Connect-time injection.** `createGraphMcpServer` becomes async and composes the instructions in an initialize handler, with the `clientInfo` budget and memory last.
4. **The unattended scope and the gate.** The scope, the server's refusals and its scope stamp, the actor facade, the terminal commit-guard phase, and the memory guard. Each needs a test that fails when its clause is removed:
   - a rename cascade into memory;
   - an inlined-delete cascade;
   - each write verb, including a move onto the page and off it, and a restore;
   - the scope's refusal of every verb outside its allowlist, `enable-extension` included;
   - a forged scope field in a command payload being ignored;
   - an unattended command never reaching a tab that doesn't register the scope.
5. **Dispatch.** The daemon pairs with an unattended token by default and refuses to start with any other, `decidePending` skips mentions inside memory, the location appendix carries its suggestion line, and the Codex `instructions` check gets done.

## Decisions for Vlad

1. **Should attended agents write memory freely, while unattended agents (the dispatch daemon, scheduled jobs) can't, enforced in the app by an `unattended` token scope?** I recommend yes. The cheaper alternative is no restriction, as in beads, which accepts that a web-steered run can plant standing instructions.
2. **Workspace-shared memory only, with no per-user tier in v1?** I recommend yes.
3. **Scope memories with `applies-to` refs, rather than placing them under the pages they govern?** I recommend refs, so that one page shows everything agents are told.
4. **If yes to 1, accept the core additions?** These are `actor` on transaction options and `TxMeta`, a terminal commit-guard phase after the same-tx processors, and the server stamping each command with its token's scope. I recommend yes. Only a check that runs after the processors sees what a transaction cascades into.
5. **Size the memory section from the client's `clientInfo`, and upgrade the Claude Code installed here?** I recommend yes. On 2.1.285 a spawned run gets a one-line pointer instead of memory.
6. **Approve the frozen names: type `agent-memory` and `agent-memory:applies-to`?** I recommend yes.
7. **Treat every run that can execute code or write files as trusted, and fix the inherited-settings gap separately (#1287)?** I recommend yes. Bounding such runs would mean sandboxing the shell, which this design doesn't attempt.
