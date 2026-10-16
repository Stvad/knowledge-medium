# Agent memory: graph-stored instructions injected at connect

> **Status:** proposal, not built. Refs #472, part of the agent-ergonomics epic #1237. Last verified against code: 2026-10-15 (master `0f3e878c76`).

## The proposal in brief

- Each workspace gets one **Agent memory** system page. Every top-level child of that page is one memory. The child's content is the memory's one-line index entry, and its children are the body. If a block is on the page, it is active. Taking it off the page retires it.
- When an agent connects, the km MCP server puts a memory section into its `instructions`. Pinned memories appear in full. Every other memory appears as one index line. The section ends with a few lines on how to propose changes. Agents read full text with a `memory` tool.
- A memory can narrow itself to part of the graph with `agent-memory:applies-to` refs. A memory with no refs applies to the whole workspace.
- **Agents never write the memory page.** An agent proposes a memory through a `remember` tool, and the proposal lands on a separate **Agent memory proposals** page. It only reaches future agents after the user moves it onto the memory page, which is what Accept does. One check inside the writing transaction refuses any agent-origin write to the memory page's subtree.
- Composition is plain concatenation with a stated precedence: host files (CLAUDE.md / AGENTS.md) and the current task come first, then graph memory, then the server's static guide.

The sections below answer the issue's four questions in order. Each gives one recommendation, the rejected alternatives in a line each, and the facts it rests on.

## What exists today

These are the facts the design leans on, checked against code on the date in the banner.

- **MCP `instructions`.** `createGraphMcpServer` (`packages/agent-cli/src/mcpServer.ts`) passes `serverOptions` straight to `McpServer` and sets no `instructions` of its own. The dispatch wrapper (`packages/agent-dispatch/src/mcp.ts`) passes a static 221-char channel string, and only when the channel listener is on. The read-path slice (#1236, in flight) adds a static default `instructions` plus a `guide` tool, and appends dispatch's string after its own.
- **Claude Code's handling of `instructions`.** This comes from the Claude Code docs, not from its source. Instructions load once, when the server connects. The docs say nothing about refreshing them mid-session. They are **cut at 4,096 chars by default**, without notice; `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` raises the cap. I don't know whether Codex surfaces `instructions` at all.
- **Token scopes.** There are two: `AgentTokenScope = 'read-write' | 'read-only'` (`src/plugins/agent-runtime/tokens.ts`). Tokens are stored per (user, workspace) in device-local storage. The bridge enforces read-only from each verb's `readOnly` flag in `knownCommandRegistry` (`packages/agent-cli/src/protocol.ts`), through `isReadOnlyCommand` in `server.ts`. A read-write token reaches every verb, including `eval`, `sql execute`, `install-extension` and `run-action`. The MCP server exposes much less: seven read tools and five block writes, with no eval.
- **Agent writes run as the user.** Verbs in `src/plugins/agent-runtime/commands.ts` call `repo.tx` with `ChangeScope.BlockDefault` and a description string such as `'agent runtime block update'`. `TxMeta` (`src/data/api/tx.ts`) carries `description, scope, user, txId, source, workspaceId` but no actor. Once a write commits, nothing distinguishes an agent write from one the user made. The only trace is the free-text `description` in `command_events`, which is a local table that does not sync.
- **The prefs blocks are not private.** `getUserPrefsBlock` / `getPluginPrefsBlock` (`src/data/stateBlocks.ts`) live under the user page, a deterministic id from (workspace, user), and write under `ChangeScope.UserPrefs`. That scope is not undoable and is allowed in read-only mode. Block RLS is workspace membership (`blocks_read` → `is_workspace_member`), so every member can read a user's prefs subtree. "Per-user" here means who owns the block, not who can read it.
- **System pages.** `systemPagesFacet` plus `getOrCreateKernelPage({namespace, alias, markerType})` give a page with a derived id per workspace. Journal, Properties, Types, Recents and Locations use this.
- **Same-tx processors.** These run inside the writing transaction and can reject it with `ProcessorRejection` (`sameTxProcessorsFacet`, `src/data/api/sameTxProcessor.ts`). Alias renames rewrite backlink text in the same transaction (`src/plugins/references/renameProcessor.ts`).
- **Dispatch.** Runs get `WebSearch` and `WebFetch` by default (`defaultAllowedTools` in `packages/agent-dispatch/src/config.ts`), with a documented trade-off: an injected page can steer a run that holds write tools. A launch breaker, `runsPerHour` (default 10), caps how many runs start per hour. `writeMcpConfig` writes the MCP config once per daemon, not once per run. `prompt.ts` renders each run's prompt from the mention's content, subtree and ancestors. `SPLIT_REPLY_GUIDANCE` is appended to the *rendered* prompt, so it reaches custom templates too.
- **Roles.** Workspace roles are `owner`, `editor` and `viewer`.

## The shape: stored blocks and what an agent sees

### Stored blocks

The agent-runtime plugin registers two system pages through `systemPagesFacet`, so both are ensured when a workspace opens. Both have ids derived from the workspace id, the same way the Journal page does. The key contains no user text, so under e2ee the id reveals no more than Journal's does.

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

Agent memory proposals                                ← system page, agent-writable
- Book notes: quotes get a source ref to the book's page
  agent-memory:proposed-from: ((the mention block the run was handling))
- Recipes: one page per recipe, ingredients and steps as child blocks
  agent-memory:supersedes: ((the "Recipes" memory above))
```

- **What counts as a memory.** A memory is defined by **where it sits**, not by its type. A plain block the user types on the memory page is an active memory that applies everywhere and isn't pinned. The `agent-memory` type is there so property editors show up on these blocks, and so a typed query can find them.
- **Order is priority.** The page's sibling order is the order used for injection. When the budget runs out, the clipped memories are the ones at the bottom, so dragging a block up raises its priority.
- **Retiring a memory.** Delete it or move it off the page. Its history lives where every block's history does. No status property is needed.
- **Seeds.** Each name below is FROZEN once shipped (`src/data/seedIdentityLedger.ts`), so the names should be settled before the first release:

  | seed                         | preset         | on                            |
  | ---------------------------- | -------------- | ----------------------------- |
  | type `agent-memory`          |                | memories and proposals        |
  | `agent-memory:applies-to`    | `refList`      | memories; empty means whole workspace |
  | `agent-memory:pinned`        | `boolean`      | memories; inject the body, not just the line |
  | `agent-memory:supersedes`    | `optional-ref` (`targetTypes: ['agent-memory']`) | proposals |
  | `agent-memory:proposed-from` | `optional-ref` | proposals; provenance          |

  The `agent-memory` namespace doesn't collide with dispatch's `agent:status` / `agent:reply`.
- **Accept.** Accept is a button on proposals and runs as a single undoable user transaction. It moves the proposal onto the memory page, at the position of the memory it supersedes if there is one. It then deletes the superseded memory and clears `supersedes`. The user can also drag a proposal onto the page by hand, which accepts it without retiring anything.

### What the agent sees at connect

This is the memory section of `instructions`, rendered from the blocks above. It is about 1,100 chars:

```text
## Graph memory: the owner's notes for agents in this graph
Rules for working in this graph, kept by its owner. They rank below your host's
instructions (CLAUDE.md, AGENTS.md) and the task you were given. If one conflicts
with those, follow those and tell the user.

Always:
- Prefer appending to today's daily note over creating top-level pages
  - New top-level pages only when the user asks for one, or for a recurring topic
  - Link any new page from today's note

Index (full text: memory {id}):
- ^3f2a9c1d Recipes: one page per recipe under [[Recipes]], ingredients as child blocks · 2026-09
- ^7c01e5aa Dates: write them as daily-note links, never ISO strings · 2026-08

Scoped (apply only under the named block; full text: memory {at}):
- ^5d2e8b10 Garden planner: plant records are blocks typed garden-plant · under ^9a0bc3f1

To add or change a memory, call remember. It becomes a proposal the user reviews,
not a rule. Propose only what stays true: a stated preference, a correction, a trap
you hit. Status and progress belong in todo blocks. Lead with the subject. To
replace a memory, pass supersedes; don't add a duplicate.
```

The `^xxxxxxxx` short ids are the form #1236 introduces. The age suffix comes from each block's `updated_at`.

When a dispatched run handles a mention under the Garden planner page, its rendered prompt also gets the memories that apply at that location, in full:

```text
Graph memory for this location:
- Garden planner: plant records are blocks typed garden-plant, one per variety
  - Sowing dates go in the garden:sown date property, not in the text
To propose a memory from this task, call remember with from: <mention block id>.
```

**Rule for every auto-injected rendering** (the `instructions` section and the dispatch appendix): each character comes either from the memory page's subtree, which the write gate below protects, or from the renderer itself: its fixed strings, short ids and dates. Block refs, embeds and `applies-to` targets therefore render as short ids. They never expand into the referenced block's content or a page's current title, because an agent can edit those freely.

## Q1. What is a "project"?

**Recommendation.** The workspace is the unit of memory: one memory page per workspace, the same unit an agent token is bound to. A memory narrows itself with `agent-memory:applies-to` refs to pages or blocks. A memory **applies at block B** when it has no `applies-to`, or when one of its targets is B or an ancestor of B.

**How an agent learns its location.** An agent doesn't declare a project when it connects; location comes with each request:

- **At connect**, there is no location. `instructions` carries workspace-wide memories (pinned ones in full, the rest as index lines) and one index line for each scoped memory.
- **Dispatch** knows each run's mention block. It renders the memories that apply there onto the per-run prompt, using the same bridge verb with `at: <blockId>`. The prompt is the right place because the MCP config is per daemon, not per run. This follows the `SPLIT_REPLY_GUIDANCE` precedent, so custom templates get it too.
- **Interactive sessions** call `memory {at}` when they start working under a page. Optionally, the bounded page and outline views from #1236 add one hint line when memories apply under the block being viewed.

This also gives backlinks at no extra cost: `applies-to` is a ref, so the Garden planner page's backlinks list the memories that govern it.

**Rejected.**
- *A separate project entity* (a project type, or a picker at connect). This adds a second scoping concept to maintain beside the tree, and the tree already says "under this page."
- *Placement as scope* (memories living under the pages they govern). Memory would be scattered across the graph, so there would be no single page to review, and review is the safety story (Q4). Moving a block would also silently change its scope.
- *An agent-declared project name* (an env var or argument). A name is not an identity: it breaks on rename (record-grain doctrine), and nothing validates it.
- *Workspace only, with no sub-scope.* A workspace holds unrelated contexts, which is the issue's own premise. Every project's conventions would land in every session and use up the 4,096-char budget.

## Q2. Where does memory live?

**Recommendation.** Memory is shared by the workspace. There is one system page per workspace, owned by the agent-runtime plugin. User edits to it are ordinary `ChangeScope.BlockDefault` writes, which are undoable and refused in read-only mode. There is no per-user tier in v1.

Memories are documents. The user wants to edit, undo, link and review them like any page. The prefs blocks give none of that and don't deliver the privacy their name suggests. Their scope can't be undone and is allowed in read-only mode, which is the wrong policy for text that steers every agent. In a shared workspace, an editor's agent proposes and any editor accepts through the UI. That matches the trust model the workspace already has: editors can edit anything, viewers can't. If a shared workspace ever needs a per-user audience, a later `agent-memory:for-user` ref to a user page can be added without breaking anything.

**Rejected.**
- *Under `getUserPrefsBlock` / plugin prefs.* Other members can read it anyway. It isn't undoable, it's allowed in read-only mode, and it's buried in the user-page tree where nobody reviews it.
- *Workspace and per-user tiers now.* That means two places to look for one rule, and with about two users there is no need yet.
- *A list of memories in one JSON property.* This is a record-grain violation: no references, no undo per memory, and concurrent writes overwrite each other.
- *Outside the graph* (a device-local file, like the tokens #71 moved out). It doesn't sync across devices, doesn't reach a dispatch daemon on another machine, and can't be edited in the app. Tokens are credentials; memory is content the owner edits in the graph, which is the point of the issue.

## Q3. Precedence and composition

**Facts.** We control only the text inside our server's `instructions`. The host decides where that text sits and how it's framed. In Claude Code, CLAUDE.md is presented as user instructions that override defaults, while MCP instructions are a section provided by the server. All of our `instructions` share one 4,096-char cap.

**Recommendation.** Graph memory covers the graph's domain; it doesn't compete with CLAUDE.md. It governs how to work with this graph. It ranks **below** the host's instruction files and the current task, and **above** the server's static defaults. Composition is concatenation in a fixed order, with a budget for each section and no merging:

```text
[#1236 static guide ~2,000] → [graph memory ~1,500] → [caller's instructions, e.g. dispatch channel ~220]
```

- The memory header states the precedence in one sentence, so the model gets it whatever framing the host uses (see the example above). It also says to tell the user about any conflict, so conflicts surface rather than getting resolved silently.
- Each section is clipped to its own budget by our renderer. That keeps the total under the host's cap, so the host's silent cut never lands in the middle of our text.
- Dispatch's own rules cannot be overridden: the reply shape, and never writing the watcher wikilink. They are part of the task, which ranks above memory, and dispatch's instructions come last in the composed text. A memory saying "always mention [[claude]]" would still be outranked.
- **Unverified:** I don't know whether Codex surfaces `instructions`. If it doesn't, the Codex executor also gets the workspace-wide section in its prompt, from the same renderer.

**Rejected.**
- *Memory above host files.* Both are the user's text, but agents can propose into this one. The more closely reviewed source should win.
- *Semantic merge or dedup across sources.* It would mean judging conflicts between texts that nobody diffs. Concatenation, a stated precedence and "tell the user" are easier to follow.
- *Memory only through a tool, with nothing injected.* That loses what the issue is about: a learnable system prompt that is always visible. Agents skip optional tool calls.
- *Injection into dispatch prompts only.* Interactive MCP sessions would get nothing.

## Q4. Safety

**Threat.** A dispatched run is unattended, has `WebFetch` by default, and holds graph write tools. A fetched page tells it to plant a memory, and that memory then reaches every future session. Today the same run can already write any block, and the dispatch config accepts that risk. What memory adds is **auto-injection**: one write becomes standing instructions for all future runs.

**Recommendation: only the user writes the memory page.**

1. **Proposals are the only agent path.** `remember` creates a typed block on the proposals page. That page is ordinary, so agents may create, edit and delete proposals freely. A proposal is never injected.
2. **Accept is the review.** It is a UI action. The MCP surface has no `run-action`, so no MCP agent can invoke it.
3. **One gate, inside the writing transaction.** The bridge command executor stamps every transaction it opens as agent-origin. One same-tx processor, contributed by agent-runtime, rejects any agent-origin transaction that touches a row in the memory page's subtree, including the page itself. That covers create, edit, move in or out, delete and restore. The rejection message states the fact and the fix: *"The Agent memory page is edited only by the user. Use remember to propose a change."*
   - **Why app-side and inside the transaction.** The check has to happen inside the writing transaction, not against an earlier snapshot. With one owner, every write verb is covered, including the new ones from #1235, and no verb has to remember to call a check.
   - **What it needs from core.** One small addition: an `actor: 'agent'` field on `RepoTxOptions`, surfaced on `TxMeta`. The executor stamps it by handing verbs a repo facade, the same way `repo.undoGroup` injects `groupId`. Agent-origin transactions are small, and the ancestor walk runs only for them, so the UI commit path pays nothing.
   - **Ordering requirement.** The gate must see every row the transaction wrote, including rows other same-tx processors amend. Example: an agent renames a page that a memory links to. The rename processor then rewrites the memory's `[[…]]` text in the same transaction, and that rewrite must be refused, because it is an indirect way to edit memory text. The consequence is that an agent can't rename a page a memory links to, though the user can. That's rare, so I accept it. The test that pins the gate covers this case.
4. **No new token scope.** Read-only tokens can read memory (the `agent-memory` verb is `readOnly: true`). They cannot propose, because `remember` is a write and the existing per-verb gate returns 403.

**The boundary, stated plainly.** The gate protects against agents on the MCP surface: dispatched runs and MCP clients, which never had eval. A read-write token used through the CLI can run `eval`, `sql execute`, `install-extension` and `run-action`, and those can reach the database without going through the facade. Nothing here changes that, because such a token already carries the user's full authority in the app. A dispatched run granted `Bash` can reach the CLI with the same token profile. Per-watcher `Bash` is already a documented opt-in.

**Accepted residual risks.**
- **Rubber-stamping.** An accepted memory that contains injected text still gets injected; the user's Accept is the only content review. Each proposal shows `proposed-from` so the user can see where it came from. The header's "these are notes" framing is not a security boundary, and nothing relies on it.
- **Proposal spam.** Bounded by dispatch's `runsPerHour` breaker. There is no separate cap.
- **Leaking memory.** A run can read memory and leak it through a `WebFetch` URL. This is already true of all graph content.
- **Injection through ordinary blocks.** An agent can still leave instructions in ordinary blocks that a later run reads. That isn't amplified by auto-injection and is unchanged from today.

**Rejected.**
- *Free agent writes, as in beads.* Beads runs attended, in a repo under review. Dispatch runs unattended on web input, which is exactly the case the issue names.
- *A `status` property (proposed/active) on one page, with the gate keyed on status.* A gate that depends on status has more cases to get right: editing a proposal is fine, flipping status isn't, moving a body block between memories isn't. Two pages make the gate positional and unconditional.
- *An MCP-layer guard* (`GraphMcpWriteGuard`, like dispatch's blocked wikilinks). It runs outside the transaction, so there's a race between check and write. It only protects clients built on `createGraphMcpServer`, and it needs an ancestry round-trip on every write.
- *Content-hash stamps at accept.* Anything that can set properties can forge them, unless they're keyed by a secret agents can't read, and a secret held on one device doesn't verify on the others.
- *A `memory-write` token scope.* Dispatch and interactive sessions share one token profile, so a scope can't separate the injected run from the trusted one. Proposals already make a write harmless until it's reviewed.
- *A new `ChangeScope`.* ChangeScope is deliberately not extensible by plugins, and it sets undo, upload and read-only policy, not authorization. The missing fact is the actor, not the scope.

## Beads as precedent: what carries over

This repo's beads memory works: a SessionStart hook injects a clipped one-line index of every memory, and agents `bd recall` the full text.

**Carries over.**
- **Index at start, full text on demand.** `memory {id}` plays the role of `bd recall`. Previews are clipped evenly to fit the budget, as `scripts/bd-prime-hook.mjs` does for the 10K hook limit.
- **The first line is the index entry, so lead with the subject.** In an outliner this comes naturally: the block's content is the line and its children are the body.
- **Memory versus issue.** Memories hold what stays true. Anything with state goes into a todo block. The update guidance says so.
- **Replace instead of piling up.** `supersedes` does the job of `bd remember --key`.

**Better here.**
- **Timestamps.** bd memories have none, which is the staleness problem AGENTS.md describes. Blocks have `updated_at`, so the index shows each memory's age.
- **Links.** Memories can link pages, and scoped memories show up in their target's backlinks.

**Doesn't carry over.**
- **Free writes** (see Q4).
- **Key prefixes as kinds** (`feedback_`, `reference_`). Here the block id is the identity, and v1 doesn't need a kind property.
- **The delivery channel.** Beads uses a Claude Code SessionStart hook with a 10K limit. Graph memory uses MCP `instructions`, capped at 4,096 chars but available to any MCP client. For agents that use only the CLI, a `kmagent memory --index` verb could feed a SessionStart hook the same way `bd prime` does. That is optional.
- **Privacy.** Beads memory syncs to a private remote. Every member of the workspace can read graph memory.

## Delivery mechanics

- **Bridge verb `agent-memory`** (`readOnly: true`), executed in the app by agent-runtime.
  - Arguments: `{at?, ids?, budget?}`. It returns `{text, counts, truncated}`.
  - Rendering sits next to #1236's `agentViews/`, so knowledge of the type and its properties stays in the plugin.
  - It reads by derived id and **never creates** a page; a missing page means no memories. `remember` also get-or-creates the proposals page at the point of use, as the `systemPagesFacet` guidance recommends, in case the ensure at workspace open was skipped.
- **Budget rendering.**
  - Pinned bodies go first. If they alone overflow, they're clipped with "N pinned memories didn't fit".
  - Then index lines, clipped evenly and in page order.
  - Then a "+N more: memory {}" line.
  - Every cut is stated in the text.
- **At connect.** Both MCP entrypoints await the verb before `connect`, with a short timeout of about 2s. They compose the result through a shared `composeInstructions(sections)` helper that applies each section's budget. If the bridge doesn't answer, the memory section is one line: *"Graph memory was not loaded at connect (the app's bridge did not answer). Call memory to read it."* With no memories at all, it is one line naming `remember`.
  - Today `createGraphMcpServer` takes `instructions` only through `serverOptions`, so it needs an async loader, or the entrypoints fetch first and pass the composed string. Either way the change touches the same function #1236 is editing, so the two need to coordinate.
- **Tools, mirrored as CLI verbs.**
  - `memory`, which reads: with no arguments it returns the full index, bounded like #1236's views; `{id}` returns the full subtree; `{at}` returns the memories that apply there.
  - `remember`, which writes: it takes `{summary, body?, appliesTo?, pinned?, supersedes?, from?}`, creates a proposal, and returns *"Proposed ^abcd1234. Not active until the user accepts it."*
  - Both names go into `KM_MCP_TOOL_NAMES`. Dispatch's allowlist derives from that list, so it picks them up.
- **Staleness within a session.** Instructions are fixed at connect. A memory accepted mid-session shows up through `memory` but isn't injected again. Beads behaves the same way.
- **Failure paths.**
  - Bridge down: the one-line notice above.
  - Tab on another workspace (#1234): the memory loaded is the active workspace's, as with every other read.
  - `applies-to` pointing at a deleted block: the memory applies nowhere, and `memory` lists it as such.
  - Accept when the superseded memory is already gone: it just moves the proposal in.
  - Gate rejection: the agent's transaction rolls back atomically and the agent gets the message above.

## Implementation slices (for when this is accepted)

1. **Seeds, pages and the proposal UI.** In agent-runtime: the type and property seeds, the two system pages, and a memory-page renderer with Accept.
2. **Actor stamp and gate.** `actor` on transaction options, the executor's facade, and the same-tx gate. Verify the guard per verb and per clause, including the rename-cascade case and a body block moved between memories: delete the clause and confirm a named test fails.
3. **Verb, renderer and tools.** The `agent-memory` verb and its renderer with budgets, plus the `memory` / `remember` tools and CLI verbs.
4. **Connect-time injection.** `composeInstructions` in both MCP entrypoints. This lands after #1236's static `instructions`.
5. **Dispatch.** Location-scoped memory appended to rendered prompts, and the Codex `instructions` check.
6. **Optional.** The #1236 view hint line, and the CLI SessionStart-hook recipe.

## Decisions for Vlad

1. **Should every agent memory write go through review, including ones from interactive sessions you're watching?** I recommend yes for v1. The bridge can't tell an attended session from a dispatched one, because both use the same token. Revisit an auto-accept toggle only if the review step turns out to be real friction.
2. **Workspace-shared memory only, with no per-user tier in v1?** I recommend yes. A later `agent-memory:for-user` ref can be added without breaking anything if a shared workspace needs it.
3. **Scope memories with `applies-to` refs, rather than placing them under the pages they govern?** I recommend refs. Keeping every memory on one page is what makes review, and so the safety story, workable.
4. **Accept a small core addition, `actor: 'agent'` on transaction options and `TxMeta`, so the gate can be one same-tx processor?** I recommend yes. The alternative is a check inside each agent write verb. That's smaller today, but every new verb (#1235) would have to remember to call it.
5. **Give memory about 1,500 of Claude Code's 4,096 `instructions` chars, with pinned bodies first and index lines clipped, and the rest reached through `memory`?** I recommend yes. It leaves room for #1236's static guide and dispatch's channel text.
6. **Approve the frozen names: type `agent-memory`, and `agent-memory:applies-to`, `agent-memory:pinned`, `agent-memory:supersedes` and `agent-memory:proposed-from`?** I recommend yes. They can't be renamed after the first release without a migration.
7. **Leave the read-write CLI surface (`eval`, `sql execute`, `install-extension`, `run-action`) outside the gate, documented as trusted?** I recommend yes. Gating it would mean sandboxing eval, which this design doesn't attempt. Such a token already holds the user's full authority in the app.
