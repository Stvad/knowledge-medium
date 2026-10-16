# Agent memory: graph-stored instructions injected at connect

> **Status:** proposal, not built. Refs #472, part of the agent-ergonomics epic #1237. Last verified against code: 2026-10-15 (master `0f3e878c76`).

## The proposal in brief

- Each workspace gets one **Agent memory** system page. Every top-level child of that page is one memory. The child's content is the memory's one-line index entry, and its children are the body. If a block is on the page, it is active. Taking it off the page retires it.
- When an agent connects, the km MCP server puts a memory section into its `instructions`. Pinned memories appear in full. Every other memory appears as one index line. The section ends with a few lines on how to propose changes. Agents read full text with a `memory` tool.
- A memory can narrow itself to part of the graph with `agent-memory:applies-to` refs. A memory with no refs applies to the whole workspace.
- **Agents never write the memory page.** An agent proposes a memory through a `remember` tool, and the proposal lands on a separate **Agent memory proposals** page. It only reaches future agents after the user accepts it. Accept checks the proposal and publishes a fresh copy onto the memory page; it doesn't move the proposal. One check inside the writing transaction refuses any agent-origin write to the memory page's subtree.
- Composition is plain concatenation with a stated precedence: host files (CLAUDE.md / AGENTS.md) and the current task come first, then graph memory, then the server's static guide.

The sections below answer the issue's four questions in order. Each gives one recommendation, the rejected alternatives in a line each, and the facts it rests on.

## What exists today

These are the facts the design leans on, checked against code on the date in the banner.

- **MCP `instructions`.** `createGraphMcpServer` (`packages/agent-cli/src/mcpServer.ts`) passes `serverOptions` straight to `McpServer` and sets no `instructions` of its own. The dispatch wrapper (`packages/agent-dispatch/src/mcp.ts`) passes a static 221-char channel string, and only when the channel listener is on. The read-path slice (#1236, in flight) adds a static default `instructions` plus a `guide` tool, and appends dispatch's string after its own.
- **Claude Code's handling of `instructions`.** According to the Claude Code docs, instructions load once, when the server connects, and the docs say nothing about refreshing them mid-session. The cap comes from the Claude Code changelog. Text past it is cut without notice. Versions from 2.1.84 cut at **2,048 chars**. From 2.1.296 the default is 4,096. The version installed on the machine where this was written is 2.1.285, which still cuts at 2,048. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` changes the cap. I don't know whether Codex surfaces `instructions` at all.
- **Token scopes.** There are two: `AgentTokenScope = 'read-write' | 'read-only'` (`src/plugins/agent-runtime/tokens.ts`). Tokens are stored per (user, workspace) in device-local storage, and the tab registers only the open workspace's tokens. PR #1244 (open) changes that: tokens become bound to the user, and reads take the workspace as a per-call parameter that defaults to the tab's open workspace. The bridge enforces read-only from each verb's `readOnly` flag in `knownCommandRegistry` (`packages/agent-cli/src/protocol.ts`), through `isReadOnlyCommand` in `server.ts`. A read-write token reaches every verb, including `eval`, `sql execute`, `install-extension` and `run-action`. The MCP server exposes much less: seven read tools and five block writes, with no eval.
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
  agent-memory:reported-source: ((the block the agent says it was working on))
- Recipes: one page per recipe, ingredients and steps as child blocks
  agent-memory:supersedes: ((the "Recipes" memory above))
```

- **What counts as a memory.** Position decides, and nothing else does: the memory set is the memory page's top-level children. The renderer and the gate both read it that way. Nothing lists memories by type, because proposals and blocks moved off the page carry the type too, so a type query never equals the memory set. Property editors still need the type, so a same-tx processor adds `agent-memory` to any block that becomes a top-level child of the page, whether it was created there or moved in. The tag lands in the user's own transaction. So a plain block the user types on the page gets typed as it's created, and it's an active memory that applies everywhere and isn't pinned.
- **Order is priority.** The page's sibling order is the order used for injection. When the budget runs out, the clipped memories are the ones at the bottom, so dragging a block up raises its priority.
- **Retiring a memory.** Delete it or move it off the page. Its history lives where every block's history does. No status property is needed.
- **Seeds.** Each name below is FROZEN once shipped (`src/data/seedIdentityLedger.ts`), so the names should be settled before the first release:

  | seed                         | preset         | on                            |
  | ---------------------------- | -------------- | ----------------------------- |
  | type `agent-memory`          |                | memories and proposals        |
  | `agent-memory:applies-to`    | `refList` (`targetTypes: ['page']`) | memories; empty means whole workspace |
  | `agent-memory:pinned`        | `boolean`      | memories; inject the body, not just the line |
  | `agent-memory:supersedes`    | `optional-ref` (`targetTypes: ['agent-memory']`) | proposals; a placement and display hint only |
  | `agent-memory:reported-source` | `optional-ref` (untyped) | proposals; agent-reported, not provenance |

  `reported-source` is deliberately untyped. What an agent works on can be any block, `targetTypes` is optional in `RefCodecOptions`, and core's `groupWith` is an untyped `refList` too.

  The `agent-memory` namespace doesn't collide with dispatch's `agent:status` / `agent:reply`.
- **Accept treats the proposal as untrusted input.** The agent wrote everything on a proposal: its text, its `supersedes` target and its reported source. Accept is a button on proposals. It acts only on what the user saw: it publishes the shown snapshot, and it deletes the proposal only if the proposal still matches that snapshot. It never deletes or edits an existing memory. It runs in these steps:
  1. **Refuse mid-edit, then freeze.** If any row of the proposal is open in the editor when the user clicks, Accept refuses before anything is dispatched: *"Finish editing the proposal first."* The editor shows text that isn't in the displayed snapshot yet, so Accept would publish something other than what's on screen. Otherwise the proposal renders read-only from the click until Accept finishes, so no new edit can start while the transaction is pending, and step 3 can't delete a draft the user began after clicking.
  2. **Publish what the user saw.** The renderer keeps the snapshot it displayed: every row of the proposal with its stored text and properties, and the tree shape. Accept writes the snapshot's text and shape, plus the root's `applies-to` and `pinned`, under new ids. It publishes from the snapshot, never from a fresh read of the database, so a change the user never saw can't be published, whatever made it. That covers an agent edit, a sync arrival, and a rename rewrite that leaves edit timestamps unchanged (`skipMetadata`). Other properties on body rows are not copied. The memory page is ensured inside the same transaction, because the workspace-open ensure may have been skipped (see the in-transaction ensure under Delivery mechanics). The copy goes right after the memory `supersedes` names, when that is a live top-level child of the memory page. Otherwise it goes at the end of the page. A wrong `supersedes` can only misplace the copy.
  3. **Delete the proposal, only if it still matches.** The proposal's current rows must be exactly the snapshot's: the same rows, with the same text, properties and shape. If anything differs, such as an edit or a row added or removed after the user looked, Accept keeps the proposal and says so: *"Published the version you reviewed. The proposal changed since, so it was kept."*

  Steps 2 and 3 run as one undoable user transaction.

  **Replacing a memory takes two gestures.** When a proposal names a live memory in `supersedes`, the renderer shows the two side by side. After accepting, the user deletes the old memory themselves, like any block they can see. Accept never discards text the user hasn't looked at.

  **Accepted case: a block ref in the proposal's text that points at one of the proposal's own rows dangles after the copy.** `remember` creates those rows, so only a later edit could add such a ref, and injected renderings show refs as ids anyway.

  The copy closes a stale-write gap. The gate judges each agent write on the device that runs it, against that device's view, and rows that arrive by sync are not checked again. An agent on a device that hasn't yet seen the acceptance can still edit the proposal, and that edit syncs later. If Accept had moved the proposal, the edit would land in active memory. With a copy, the edit lands on the proposal, which Accept deletes or keeps, and never on active memory. The new memory's ids didn't exist until Accept ran, so no agent edit can already be in flight against them.

  Dragging a proposal onto the page by hand also makes it active, but the block keeps its id, so it doesn't get this protection. Accept is the safe path (see the accepted risks in Q4).

### What the agent sees at connect

This is the memory section of `instructions`, rendered from the blocks above. It is about 1,100 chars. The full update guidance, covering what to propose, leading with the subject, and `supersedes`, lives in a `memory` topic of #1236's `guide` tool, so the injected footer costs two lines:

```text
## Graph memory for workspace "Home": notes for agents from its members
Rules for working in this graph, kept by the people who work in it. They rank
below your host's instructions (CLAUDE.md, AGENTS.md) and the task you were given,
and above this server's general guidance. If one conflicts with your host's
instructions or the task, follow those and tell the user.

Always:
- Prefer appending to today's daily note over creating top-level pages
  - New top-level pages only when the user asks for one, or for a recurring topic
  - Link any new page from today's note

Index (full text: memory {id}):
- ^3f2a9c1d Recipes: one page per recipe under [[Recipes]], ingredients as child blocks · 2026-09
- ^7c01e5aa Dates: write them as daily-note links, never ISO strings · 2026-08

Scoped (apply only under the named block; full text: memory {at}):
- ^5d2e8b10 Garden planner: plant records are blocks typed garden-plant · under ^9a0bc3f1

To add or change a memory, call remember: it files a proposal the user reviews.
Propose only what stays true; status belongs in todo blocks. More: guide memory.
```

The `^xxxxxxxx` short ids are the form #1236 introduces. The age suffix is the newest `user_updated_at` anywhere in the memory's subtree, so editing one body line counts as an edit.

When a dispatched run handles a mention under the Garden planner page, its rendered prompt also gets the memories that apply at that location, in full:

```text
Graph memory for this location. The task above comes first. If a memory conflicts
with it, follow the task and tell the user.
- Garden planner: plant records are blocks typed garden-plant, one per variety
  - Sowing dates go in the garden:sown date property, not in the text
To propose a memory from this task, call remember with source: <mention block id>.
```

**Rule for every auto-injected rendering** (the `instructions` section and the dispatch appendix): each character comes either from the memory page's subtree, which the write gate below protects, or from the renderer itself: its fixed strings, short ids and dates. Block refs, embeds and `applies-to` targets therefore render as short ids. They never expand into the referenced block's content or a page's current title, because an agent can edit those freely. Both renderings also open with the same precedence line, which comes from one place in the renderer: memory ranks below the host's instructions and the current task, and above the server's static guide. That way the dispatch appendix can't drift from the connect section. The ranking is stated because position alone doesn't tell a model which instruction wins.

## Q1. What is a "project"?

**Recommendation.** The workspace is the unit of memory: one memory page per workspace, the same unit every read and write already selects. A memory narrows itself with `agent-memory:applies-to` refs to pages. A memory **applies at block B** when it has no `applies-to`, or when one of its target pages is B or an ancestor of B. Pages are where projects live, and limiting the targets to pages gives the property a page picker.

**How an agent learns its location.** An agent doesn't declare a project when it connects; location comes with each request:

- **At connect**, there is no location. `instructions` carries workspace-wide memories (pinned ones in full, the rest as index lines) and one index line for each scoped memory.
- **Dispatch** knows each run's mention block. It renders the memories that apply there onto the per-run prompt, using the same bridge verb with `at: <blockId>`. The prompt is the right place because the MCP config is per daemon, not per run. This follows the `SPLIT_REPLY_GUIDANCE` precedent, so custom templates get it too.
- **Query-watcher runs** have no single location. Their rows can span several pages, or not be blocks at all, so they get no location appendix. They still get what connect gives: each scoped memory's index line, with the block it applies under. The query prompt gains one line: before changing a block, call `memory {at}` for it. A union of every row's scoped memories was rejected: a batch of rows has no bound on how many pages it spans.
- **Interactive sessions** call `memory {at}` when they start working under a page. Optionally, the bounded page and outline views from #1236 add one hint line when memories apply under the block being viewed.

This also gives backlinks at no extra cost: `applies-to` is a ref, so the Garden planner page's backlinks list the memories that govern it.

**Rejected.**
- *A separate project entity* (a project type, or a picker at connect). This adds a second scoping concept to maintain beside the tree, and the tree already says "under this page."
- *Placement as scope* (memories living under the pages they govern). Memory would be scattered across the graph, so there would be no single page to review, and review is the safety story (Q4). Moving a block would also silently change its scope.
- *An agent-declared project name* (an env var or argument). A name is not an identity: it breaks on rename (record-grain doctrine), and nothing validates it.
- *Workspace only, with no sub-scope.* A workspace holds unrelated contexts, which is the issue's own premise. Every project's conventions would land in every session and use up the instructions budget, which is 2,048 chars by default.

## Q2. Where does memory live?

**Recommendation.** Memory is shared by the workspace. There is one system page per workspace, owned by the agent-runtime plugin. User edits to it are ordinary `ChangeScope.BlockDefault` writes, which are undoable and refused in read-only mode. There is no per-user tier in v1.

Memories are documents. The user wants to edit, undo, link and review them like any page. The prefs blocks give none of that and don't deliver the privacy their name suggests. Their scope can't be undone and is allowed in read-only mode, which is the wrong policy for text that steers every agent. In a shared workspace, an editor's agent proposes and any editor accepts through the UI. That matches the trust model the workspace already has: editors can edit anything, viewers can't. If a shared workspace ever needs a per-user audience, a later `agent-memory:for-user` ref to a user page can be added without breaking anything.

**Rejected.**
- *Under `getUserPrefsBlock` / plugin prefs.* Other members can read it anyway. It isn't undoable, it's allowed in read-only mode, and it's buried in the user-page tree where nobody reviews it.
- *Workspace and per-user tiers now.* That means two places to look for one rule, and with about two users there is no need yet.
- *A list of memories in one JSON property.* This is a record-grain violation: no references, no undo per memory, and concurrent writes overwrite each other.
- *Outside the graph* (a device-local file, like the tokens #71 moved out). It doesn't sync across devices, doesn't reach a dispatch daemon on another machine, and can't be edited in the app. Tokens are credentials; memory is content that the workspace's members edit in the graph, which is the point of the issue.

## Q3. Precedence and composition

**Facts.** We control only the text inside our server's `instructions`. The host decides where that text sits and how it's framed. In Claude Code, CLAUDE.md is presented as user instructions that override defaults, while MCP instructions are a section provided by the server. All of our `instructions` share one cap: 2,048 chars on Claude Code before 2.1.296, 4,096 from it.

**Recommendation.** Graph memory covers the graph's domain; it doesn't compete with CLAUDE.md. It governs how to work with this graph. It ranks **below** the host's instruction files and the current task, and **above** the server's static defaults. Composition is concatenation in a fixed order, with a budget for each section and no merging:

```text
[static guide 633 (PR #1241)] → [graph memory ≤ ~1,100] → [caller's instructions, e.g. dispatch channel 221]
```

- The memory header states the precedence in one sentence, so the model gets it whatever framing the host uses (see the example above). It also says to tell the user about any conflict, so conflicts surface rather than getting resolved silently.
- The composition is budgeted for **2,048 chars in total by default**. That is the cap of every Claude Code release before 2.1.296, including the version installed here, which is the binary dispatch spawns. The total is a setting, for clients known to allow more (4,096 from 2.1.296, or whatever `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` says). The static guide and the caller's text are fixed sizes, so memory gets what's left, about 1,100 chars by default. Each section is clipped to its own budget by our renderer. That keeps the total under the host's cap, so the host's silent cut never lands in the middle of our text.
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
2. **Accept is the review, and it publishes a copy.** It is a UI action, and the MCP surface has no `run-action`, so no MCP agent can invoke it. It publishes the snapshot the user was shown, under new ids (see Accept above). So no later change to the proposal, a stale agent edit arriving by sync included, can reach active memory.
3. **One gate, inside the writing transaction.** The bridge command executor stamps every transaction it opens as agent-origin. One commit guard, contributed by agent-runtime, rejects any agent-origin transaction that touches a row in the memory page's subtree, including the page itself. That covers create, edit, move in or out, delete and restore. It checks each written row's ancestry both before and after the transaction. So moving a memory off the page is refused as well as moving a block onto it, and an agent can't retire a memory and then edit it. The gate judges each write against the tree as the executing device sees it. Rows that arrive by sync are not checked again, which is why Accept copies instead of moving. The rejection message states the fact and the fix: *"The Agent memory page is edited only by the user. Use remember to propose a change."*
   - **Why app-side and inside the transaction.** The check has to happen inside the writing transaction, not against an earlier snapshot. With one owner, every write verb is covered, including the new ones from #1235, and no verb has to remember to call a check.
   - **What it needs from core.** Two small additions. The first is an `actor: 'agent'` field on `RepoTxOptions`, surfaced on `TxMeta`. The second is the terminal commit-guard phase described in the next point. The executor stamps the actor by handing verbs a repo facade, the same way `repo.undoGroup` injects `groupId`. Agent-origin transactions are small, and the ancestor walk runs only for them, so the UI commit path pays nothing.
   - **It runs last, as a commit guard, not as a same-tx processor.** The gate must see every row the transaction wrote, including rows that same-tx processors amend. Those processors run once each, in registration order, with no fixpoint (`src/data/api/sameTxProcessor.ts`). So a gate written as one of them would miss the amendments of any processor registered after it, and staying correct would depend on registration order. Core therefore gains a terminal phase that runs after the whole processor pipeline, over every row the transaction wrote. A guard in this phase can only reject; it writes nothing, so nothing runs after it. Example: an agent renames a page that a memory links to. The rename processor then rewrites the memory's `[[…]]` text in the same transaction, and that rewrite must be refused, because it is an indirect way to edit memory text. The consequence is that an agent can't rename a page a memory links to, though the user can. That's rare, so I accept it. The test that pins the gate covers this case.
4. **No new token scope.** Read-only tokens can read memory (the `agent-memory` verb is `readOnly: true`). They cannot propose, because `remember` is a write and the existing per-verb gate returns 403.

**The boundary, stated plainly.** The gate protects against agents on the MCP surface: dispatched runs and MCP clients, which never had eval. A read-write token used through the CLI can run `eval`, `sql execute`, `install-extension` and `run-action`, and those can reach the database without going through the facade. Nothing here changes that, because such a token already carries the user's full authority in the app. The same holds for any run that can execute shell commands and reach loopback, because it can call the bridge with the daemon's token. Two cases exist today:
- **A Claude run granted `Bash`.** Per-watcher `Bash` is a documented opt-in.
- **A Codex run with `networkAccess: true`.** Codex always runs model-generated shell commands and ignores `allowedTools` (`packages/agent-dispatch/README.md`, "Sandboxing"), and its sandbox reads the whole disk, token store included. Enabling network access is enough to reach the bridge.

Both kinds of run hold the user's full authority in the app, and the gate doesn't bound them. Withholding the token from such a shell isn't possible while the sandbox can read the whole disk.

**Accepted residual risks.**
- **Rubber-stamping.** An accepted memory that contains injected text still gets injected; the user's Accept is the only content review. A proposal shows the source the agent reported, labelled as agent-reported. An injected run can name any block, so that field is context, not provenance. The header's "these are notes" framing is not a security boundary, and nothing relies on it.
- **Proposal spam.** Nothing limits how many proposals one run files: `runsPerHour` caps launches, not tool calls within a run. Proposals are never injected, so spam costs the user review effort and nothing more. That is the same as an agent flooding any ordinary page today, so I accept it. If it becomes a problem, the cheap fix is a cap on pending proposals inside `remember`.
- **Blocks moved onto the page by hand.** When the user drags a proposal, or any other block, onto the memory page, the block keeps its id. An agent edit made against that id on a device that hadn't yet seen the move can still sync in. It takes a deliberate move plus an agent write already in flight, so I accept it. Accept is the path that avoids it.
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
- **Replace instead of piling up.** `supersedes` does the job of `bd remember --key`, except that the user deletes the old memory.

**Better here.**
- **Timestamps.** bd memories have none, which is the staleness problem AGENTS.md describes. Blocks carry edit times, so the index shows each memory's age, taken from the newest edit anywhere in its subtree.
- **Links.** Memories can link pages, and scoped memories show up in their target's backlinks.

**Doesn't carry over.**
- **Free writes** (see Q4).
- **Key prefixes as kinds** (`feedback_`, `reference_`). Here the block id is the identity, and v1 doesn't need a kind property.
- **The delivery channel.** Beads uses a Claude Code SessionStart hook with a 10K limit. Graph memory uses MCP `instructions`, capped at 2,048 chars by default (4,096 on newer Claude Code) but available to any MCP client. For agents that use only the CLI, a `kmagent memory --index` verb could feed a SessionStart hook the same way `bd prime` does. That is optional.
- **Privacy.** Beads memory syncs to a private remote. Every member of the workspace can read graph memory.

## Delivery mechanics

- **Bridge verb `agent-memory`** (`readOnly: true`), executed in the app by agent-runtime.
  - Arguments: `{at?, ids?, budget?, workspaceId?}`. It returns `{text, counts, truncated}`.
  - It picks the workspace the way every read does. Today a token works only while the tab shows its workspace, so a session can reach that one workspace and no other. Under PR #1244 the workspace becomes a per-call parameter that defaults to the tab's open workspace, and this verb takes the same optional `workspaceId`. The connect section names the workspace it loaded, so an agent working in a different workspace knows to call `memory {workspaceId}`. The verb needs no server-verified token workspace: in both models a token reaches only workspaces its user may read, so naming a workspace grants nothing new.
  - Rendering sits next to #1236's `agentViews/`, so knowledge of the type and its properties stays in the plugin.
  - It reads by derived id and **never creates** a page; a missing page means no memories.
- **In-transaction page ensure.** `remember` ensures the proposals page inside the same transaction that writes the proposal, and Accept does the same for the memory page. `getOrCreateKernelPage` commits its own transaction, so a delete could land between it and the write, and the insert would then fail on a dead parent. Both writers therefore use one in-transaction get-or-create-or-restore helper.
- **Budget rendering.**
  - Pinned bodies go first. If they alone overflow, they're clipped with "N pinned memories didn't fit".
  - Then index lines, clipped evenly and in page order.
  - Then a continuation line: "+N more: call memory to page through the full index." It carries no cursor. Pinned bodies come first, so the memories listed are not a contiguous run in page order, and resuming after any one of them could skip some. Paging from the top repeats a few lines but never skips one.
  - Every cut is stated in the text.
- **At connect.** Both MCP entrypoints await the verb before `connect`, with a short timeout of about 2s. They compose the result through a shared `composeInstructions(sections)` helper that applies each section's budget. If the verb doesn't answer or refuses, the memory section is one line stating which, for example *"Graph memory was not loaded at connect (the app's bridge did not answer). Call memory to read it."* A refusal quotes the verb's own reason instead. With no memories at all, it is one line naming `remember`.
  - Today `createGraphMcpServer` takes `instructions` only through `serverOptions`, so it needs an async loader, or the entrypoints fetch first and pass the composed string. Either way the change touches the same function #1236 is editing, so the two need to coordinate.
- **Tools, mirrored as CLI verbs.**
  - `memory`, which reads: with no arguments it returns the index one bounded page at a time, in page order, like #1236's views; `{after: id}` continues after that memory, so a memory cut by any budget can still be reached; `{id}` returns the full subtree; `{at}` returns the memories that apply there; `{workspaceId}` picks the workspace.
  - `remember`, which writes: it takes `{summary, body?, appliesTo?, pinned?, supersedes?, source?}`, creates a proposal, and returns *"Proposed ^abcd1234. Not active until the user accepts it."*
  - Both names go into `KM_MCP_TOOL_NAMES`. Dispatch's allowlist derives from that list, so it picks them up.
  - **Every MCP write tool, `remember` included, goes through the server's `beforeWrite` guard.** `GraphMcpWriteOperation` gains a `remember` variant carrying the summary and body. Dispatch's blocked-wikilink guard then refuses a proposal whose text holds a watcher target. Without it, a run could file a proposal containing `[[claude]]`, and that proposal would itself become a watcher target and start a new run.
- **Staleness within a session.** Instructions are fixed at connect. A memory accepted mid-session shows up through `memory` but isn't injected again. Beads behaves the same way.
- **Failure paths.**
  - Bridge down: the one-line notice above.
  - An agent working in a workspace other than the one named at connect: `memory {workspaceId}` reads that workspace's memory.
  - `applies-to` pointing at a deleted block: the memory applies nowhere, and `memory` lists it as such.
  - Accept when `supersedes` names nothing live on the memory page: the copy goes at the end of the page.
  - Accept on a proposal that changed after it was shown: the shown version is published, and the proposal is kept with a notice.
  - Accept while a proposal row is open in the editor: refused before anything is written.
  - The memory page is missing when Accept runs, or the proposals page is missing when `remember` runs: the in-transaction helper creates or restores it as part of the write.
  - Gate rejection: the agent's transaction rolls back atomically and the agent gets the message above.

## Implementation slices (for when this is accepted)

1. **Seeds, pages and the proposal UI.** In agent-runtime: the type and property seeds, the two system pages, the tag-on-entry processor, and the proposal renderer with Accept, which refuses mid-edit and publishes the displayed snapshot. Each Accept behaviour needs a test that fails when it is removed: Accept clicked mid-edit; a proposal rewritten after it was shown, including by a rename, still publishes the shown version and keeps the proposal; a missing memory or proposals page.
2. **Actor stamp and gate.** `actor` on transaction options, the executor's facade, the terminal commit-guard phase, and the gate as its first guard. Verify the guard per verb and per clause, including the rename-cascade case, a body block moved between memories, and a memory moved off the page: delete the clause and confirm a named test fails.
3. **Verb, renderer and tools.** The `agent-memory` verb and its renderer with budgets, plus the `memory` / `remember` tools and CLI verbs. `remember` goes through `beforeWrite`, and a test pins that a proposal containing a blocked watcher wikilink is refused under the dispatch entrypoint.
4. **Connect-time injection.** `composeInstructions` in both MCP entrypoints. This lands after #1236's static `instructions`.
5. **Dispatch.** Location-scoped memory appended to rendered prompts, and the Codex `instructions` check.
6. **Optional.** The #1236 view hint line, and the CLI SessionStart-hook recipe.

## Decisions for Vlad

1. **Should every agent memory write go through review, including ones from interactive sessions you're watching?** I recommend yes for v1. The bridge can't tell an attended session from a dispatched one, because both use the same token. Revisit an auto-accept toggle only if the review step turns out to be real friction.
2. **Workspace-shared memory only, with no per-user tier in v1?** I recommend yes. A later `agent-memory:for-user` ref can be added without breaking anything if a shared workspace needs it.
3. **Scope memories with `applies-to` refs, rather than placing them under the pages they govern?** I recommend refs. Keeping every memory on one page is what makes review, and so the safety story, workable.
4. **Accept two small core additions, so the gate can be one check that sees every row a transaction wrote?** The additions are `actor: 'agent'` on transaction options and `TxMeta`, and a terminal commit-guard phase that runs after the same-tx processors. I recommend yes. The alternative is a check inside each agent write verb. That's smaller today, but every new verb (#1235) would have to remember to call it, and it would miss rows that processors rewrite, such as a rename cascade.
5. **Budget the whole `instructions` string for 2,048 chars by default, giving memory what's left after the static guide and dispatch text (about 1,100), with a setting to raise the total for newer clients?** I recommend yes. Pinned bodies go first, index lines are clipped, and the rest is reached through `memory`. 2,048 is the cap on every Claude Code before 2.1.296, including the one installed here, so a 4,096 default would be cut silently on those versions.
6. **Approve the frozen names: type `agent-memory`, and `agent-memory:applies-to`, `agent-memory:pinned`, `agent-memory:supersedes` and `agent-memory:reported-source`?** I recommend yes. They can't be renamed after the first release without a migration.
7. **Leave the read-write CLI surface (`eval`, `sql execute`, `install-extension`, `run-action`) outside the gate, documented as trusted?** I recommend yes. Gating it would mean sandboxing eval, which this design doesn't attempt. Such a token already holds the user's full authority in the app. The trusted class includes every run with a shell and loopback access: a Claude run granted `Bash`, and a Codex run with `networkAccess: true`.
