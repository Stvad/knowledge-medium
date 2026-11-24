# @knowledge-medium/agent-dispatch

Dispatch note-graph events to local agent CLIs. A backlink watcher can turn `[[claude]] summarize the meeting notes below` into a full-harness `claude` run, or `[[codex]] fix this` into a `codex` run, with graph access through the shared km MCP tools and replies threaded back as child blocks. Watchers generalize the same loop to *any* page's new backlinks and to arbitrary SQL query changes.

```
┌─ app tab (live client, decrypted) ─┐        ┌─ km-agent-dispatch (launchd) ─────────┐
│  you type: [[claude]] do X         │        │ poll: backlinks/sql via the bridge   │
│  reply appears as a child block ◀──┼─bridge─┼─▶ claim: agent:status=running        │
└────────────────────────────────────┘        │ spawn: claude/codex (login billing,  │
                                              │   --mcp-config → km graph tools)     │
                                              │ write: reply block + agent:status    │
                                              └──────────────────────────────────────┘
```

Design notes: task state lives **in the graph** (`agent:*` block properties), so the daemon is restart-safe for mention watchers — it re-derives pending work from block properties, and a mention synced from your iPad triggers once the Mac client sees it. **Give each trigger page exactly one daemon across the fleet**, though: the claim is a plain property write with no cross-device compare-and-swap, so two daemons watching the same page can both claim the same mention within sync latency (the claim-verify and pidfile only prevent a *same-instance, same-machine* double-claim). Daemons on different trigger pages are fine, including on one machine: see [A second listener](#a-second-listener). Active dispatch requires a writable client to claim work and post replies. The headless host defaults to a download-only connection and read-only token. Set `writable: true` for a scratch write test and run `pnpm agent --profile headless-scratch health` with the configured profile. The real-graph dispatch cutover is a separate deployment step. [Host setup and write verification](../../docs/headless-client.md#owner-verification-for-slice-3)

## Billing invariant (subscription, not API)

Runs execute via `claude -p` on a machine authenticated with `claude login`. The daemon **scrubs `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and the `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` switches from every child environment** — any of them would silently redirect billing. One thing env-scrubbing can't reach: a user-level `settings.json` `apiKeyHelper` — check yours if runs bill unexpectedly. Nothing here touches the Agent SDK (API-key-only by policy).

**Spend circuit-breaker:** `runsPerHour` (default 45, a top-level config key) caps launches across all watchers in a rolling hour. Any watcher-loop bug or misconfigured query becomes a bounded bill, not an unbounded one. Additionally each task is attempted at most 3 times (crashed/dropped runs re-queue via the 65-min stale sweep) before being parked as `error` with a visible reply.

## Executors

By default a watcher runs `claude`. Configure `"runner": {"executor": "codex"}` on any watcher to run [OpenAI's `codex` CLI](https://github.com/openai/codex) instead:

```jsonc
{
  "kind": "backlinks",
  "name": "codex-mentions",
  "target": "codex",
  "runner": {
    "executor": "codex"
  }
}
```

- **Billing:** codex runs authenticate with `codex login` (ChatGPT plan) on this machine. The daemon scrubs `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` from the child environment — same rationale as the claude billing invariant above (any of these env credentials beats the ChatGPT-plan OAuth session in codex's credential order). **Caveat:** a key stored with `codex login --with-api-key` lives in `auth.json`, not the env — env scrubbing can't override it, so if you've done that, daemon codex runs bill the API (the analogue of the claude `apiKeyHelper` caveat above).
- **Sandboxing — weaker than the claude executor, read this:** codex defaults to `-s read-only --skip-git-repo-check --ignore-user-config`. `read-only` does **not** mean "no shell" — codex still *executes* model-generated shell commands; the sandbox restricts them to **reading the filesystem (full-disk read) with network egress blocked**. So a prompt-injected `[[codex]]` mention (or content a run pulled in from the web) can read local files — `~/.ssh`, dotfiles, other repos — into the model's context and thus into the reply block. A watcher can explicitly opt into `"sandbox": "workspace-write"`, `"addDirs": [...]`, and `"networkAccess": true` under `runner`. This is a materially weaker posture than the claude executor, which gets no Bash and a fail-closed allowlist. `--ignore-user-config` skips `$CODEX_HOME/config.toml` (the user's own MCP servers/settings there) but does **not** guarantee plugins, skills, or a global `AGENTS.md` outside config.toml stay out of the run — so it's a *weaker* analogue of claude's `--strict-mcp-config`, not an equal one. **Point a codex watcher only at content you'd trust with the configured local access.**
- **Approvals:** codex `exec` runs default to headless `approval_policy = "never"`; interactive `-a/--ask-for-approval` is not a supported exec-runner control. To route approval requests through Codex's classifier instead of a human prompt, set `"approvalPolicy": "on-request"` together with `"approvalsReviewer": "auto_review"` under the codex runner. Other non-`never` policies are rejected at config parse time because `codex exec` would not honor them here.
- **Tools:** the km MCP server is injected into the codex run via `-c mcp_servers.*` config overrides (not a config file), alongside codex's own built-in tools. Claude's `runner.allowedTools` and the top-level `defaultAllowedTools` are **claude-only** and are ignored for a codex watcher — there's no equivalent allowlist gate at the codex CLI layer today.
- **Sessions don't cross executors:** `agent:session` ids are executor-scoped — codex thread ids are stored as `codex:<id>`, claude session ids bare (matching every pre-executor session). A follow-up whose nearest thread session belongs to the *other* executor starts a **fresh** thread instead of forwarding the foreign id to `--resume`/`resume` (which would fail the run outright). Switching a watcher's `runner.executor` therefore drops thread continuity, never mixes histories, and never burns retries on doomed resumes.

## Upgrade to 0.10.0

Watcher prompts now carry a summary index of memory notes. Runs use the km tools to read the details they need. Upgrade to `@knowledge-medium/agent-cli` 0.15.0 and `@knowledge-medium/agent-dispatch` 0.10.0, reload the Knowledge Medium tab with the updated app to register the new memory view, and restart the bridge and dispatch daemon. Existing memory blocks need no migration.

## Upgrade to 0.9.7

A claude watcher whose `allowedTools` (or the top-level `defaultAllowedTools`) names `Skill` can now load skills: the run is offered `Skill` and is no longer started with `--disable-slash-commands`, which withdrew `Skill` even when `--tools` named it, so listing it did nothing before. A watcher that doesn't name `Skill` gets the same argv as before. For skills that run scripts, the watcher also needs the tools those scripts use, for example `Bash` and `Read`.

## Upgrade to 0.9.6

A second daemon can now run on the same machine, beside the first, on its own trigger page (see [A second listener](#a-second-listener)), named by the new top-level `instance` field. An existing config keeps its file paths and behaviour. Upgrade and restart the daemon: `launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch`.

## Upgrade to 0.9.4

Comment-thread requests now include the annotated block's ID and its containing root page's ID, so agents can address them directly instead of searching by text or breadcrumb. If the ancestry does not reach a root, the page ID is marked unavailable. Upgrade `@knowledge-medium/agent-dispatch` and restart the daemon; no app update is required.

## Upgrade to 0.9.3

0.9.3 requires `@knowledge-medium/agent-cli` 0.14.1. The status chip shows the oldest outstanding tool's age, with a warning when a `km:` call has waited more than 20 seconds. Other activities show age without warnings. Activity details remain in the title and menu, and the pill keeps the same width in every state.

Upgrade both packages, reload the app, and restart the daemon: `launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch`. Older daemons retain the existing chip behavior without step ages.

## Upgrade to 0.9.2

0.9.2 requires `@knowledge-medium/agent-cli` 0.14.0. Runs now get `add_media`, which stores a file the run writes itself (such as an SVG) as a media block. It never reads a local path. Upgrade both packages and restart the daemon: `launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch`.

## Upgrade to 0.9.0

Backlinks watchers now keep a memory in your notes (see [Memory](#memory)), on by default. On a watcher's first run the daemon adds a `Memory` block under its target page, for example under `[[claude]]`. Every run then sees what is in it and keeps it itself, and a run's reply ends with a `Memory changed during this run: …` line when the run changed it.

- To keep a watcher out of it, set `"memory": false` on that watcher. Do this for a watcher whose custom `prompt` should not write to the notes.
- Notes an earlier run saved to Claude Code's auto-memory (`~/.claude/projects/*/memory/`) are not moved. Copy any you want to keep into the `Memory` block by hand, one block per note.
- Restart the daemon: `launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch`.

## Upgrade to 0.8.6

`runsPerHour` now defaults to 45 (was 10). Set it at the top level of the config to keep a lower cap.

## Upgrade to 0.8.5

A claude run is offered only the built-in tools its `allowedTools` names, and no skills, so its fixed prompt no longer carries every tool definition and every installed plugin's skill listing on each request. This also makes the allow list the real boundary: `--allowedTools` only pre-approves, and before 0.8.5 a run without them could still use the tools that need no approval — read-only shell commands (`ls`, `cat`, `git status`), `Read`/`Glob`/`Grep`, subagents, and writes to Claude Code's auto-memory. A watcher that wants any of these now lists them in `runner.allowedTools`, except subagents: `Agent` joins `defaultAllowedTools`, and a subagent gets only the tools its run is offered. A run that waits on a background subagent ends with a second result line; the reply and the logged usage come from the last one, and the usage covers every model and subagent. Each run's `done` / `FAILED` log line now ends with its token usage, for example `tokens: in 4 · cache read 14.2k · cache write 14.6k · out 34`.

## Upgrade to 0.8.4

`maxConcurrent` now defaults to 4 (was 2). A follow-up that has to wait for its thread's run to finish now shows as `agent:status=queued`, its chip says why, and the log says so once. Earlier versions treat `queued` as finished, so if you downgrade, delete the `agent:*` properties on any block still queued to run it.

## Upgrade to 0.8.3

0.8.3 requires `@knowledge-medium/agent-cli` 0.13.1. For `spawn` delivery, the daemon's `agent:*` writes and its replies no longer go on the person's undo stack, so a cmd-Z in the app undoes their own edit instead of flipping a finished task back to `running`. With `channel` delivery the ambient session still closes the task through the generic MCP tools, whose writes stay undoable. An app tab older than this release ignores the option, and the writes stay undoable there until it reloads.

## Upgrade to 0.8.1

`runner.timeoutMs` may now be up to 60 min (was 25), and a `running` task left by a crashed daemon re-queues after 65 min instead of 30. Stopping the daemon (`launchctl kickstart -k`, a reboot) waits at most 60 s for in-flight runs: launchd caps a user agent's `ExitTimeOut` there whatever the plist asks for. A run still going then is killed, and its task re-queues after the stale sweep, so restart while nothing is running.

## Upgrade to 0.8.0

0.8.0 requires `@knowledge-medium/agent-cli` 0.13.0. A mention now waits until it leaves the editor, on any device, instead of waiting for a quiet period. The `quietMs` watcher option is gone, and a config that still sets it is a config error: the daemon logs `config error: … quietMs was removed in 0.8.0 …` to `~/Library/Logs/km-agent-dispatch.log` and exits without restarting.

1. Remove `quietMs` from every watcher in `~/.config/knowledge-medium/agent-dispatch.json`. The two new options have defaults, so you can leave them out:
   - `settleMs` (default 250): how long after a mention's last change it waits, so the last write lands.
   - `editHoldMs` (default 120000): how long a mention still open in an editor is held once neither its text nor the editor has moved.
2. Upgrade both packages: `npm i -g @knowledge-medium/agent-dispatch @knowledge-medium/agent-cli`.
3. Reload the app tab too. With an older tab the daemon still holds correctly, but only notices a mention leaving the editor on the next sweep.
4. Restart the daemon: `launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch`.

## Upgrade to 0.4.0

0.4.0 requires `@knowledge-medium/agent-cli` 0.9.0. Upgrade both packages, restart the bridge as described in the agent-cli README's [Upgrading](https://github.com/Stvad/knowledge-medium/tree/master/packages/agent-cli#upgrading) section, then restart the daemon. A `delivery: "channel"` watcher's ambient session loads the dispatch channel MCP when it starts, so restart that session too.

```bash
npm i -g @knowledge-medium/agent-dispatch @knowledge-medium/agent-cli
launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch
```

What changes:

- The daemon's `agent:*` bookkeeping on the block that mentioned it is written with no attribution; the saved contributor is credited only with the run's own writes (see [Contributor selection](#contributor-selection)). The daemon still needs that saved choice to start.
- A mention that is a comment in a thread gets the thread in its prompt (step 3 of [How a mention task runs](#how-a-mention-task-runs)). A custom `prompt` places it with `{{thread}}`; one without the placeholder gets the thread appended. Reading the thread needs an app build with the `comments` verb: against an older tab the daemon logs `no thread context for <id>` and answers the mention without it.
- Runs get the km `comments` and `add_comment` tools.

## Upgrade to 0.3.0

0.3.0 requires `@knowledge-medium/agent-cli` 0.8.0. Before starting active watchers, save an agent or automation contributor for the daemon's configured profile and workspace with `kmagent --profile agent-dispatch contributor use <id> --workspace <workspace-id>`; `contributor use none` explicitly opts out by sending null attribution. You can also create and select an automation profile with `contributor create`.

Upgrade both packages, restart the bridge as described in the agent-cli README's [Upgrading](https://github.com/Stvad/knowledge-medium/tree/master/packages/agent-cli#upgrading) section, save the choice, then restart the daemon. It and its spawned agents use the same saved profile/workspace selection. The ambient channel MCP reads the saved choice when it starts, so restart that MCP client after changing the selection. With no saved choice, active dispatch exits with setup instructions before contacting the bridge; all-disabled watcher cleanup still works without attribution.

```bash
npm i -g @knowledge-medium/agent-dispatch @knowledge-medium/agent-cli
launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch
```

## Upgrade to 0.2.0

0.2.0 requires `@knowledge-medium/agent-cli` 0.7, and a config that names its workspace. A config without `workspaceId` is now a config error: the daemon logs a `config error` saying `workspaceId is required` and exits cleanly, so launchd does not restart it and dispatch stops until the field is added.

1. Add `"workspaceId"` to `~/.config/knowledge-medium/agent-dispatch.json` (step 2 of [Setup](#setup-from-a-repo-checkout)). List your workspaces with `kmagent --profile agent-dispatch sql all "SELECT id, name FROM workspaces"`.
2. Upgrade both packages: `npm i -g @knowledge-medium/agent-dispatch @knowledge-medium/agent-cli`.
3. Stop the old bridge, as the agent-cli README's [Upgrading](https://github.com/Stvad/knowledge-medium/tree/master/packages/agent-cli#upgrading) section says; the daemon starts the new one.
4. Restart the daemon: `launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch`.

## Upgrade from claude-tasks

This rename intentionally does **not** carry a permanent `claude:*` compatibility layer in app or daemon code. Do the migration once before loading the new LaunchAgent:

1. Stop the old LaunchAgent so old and new daemons cannot both claim the same `[[claude]]` block:

   ```bash
   launchctl bootout gui/$(id -u)/org.knowledge-medium.claude-tasks 2>/dev/null || true
   ```

2. Preserve query cursors and backlink baselines by copying the old local state file if the new one does not exist yet:

   ```bash
   config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/knowledge-medium"
   if [ -f "$config_dir/agent-dispatch-state.json" ]; then
     echo "agent-dispatch-state.json already exists; stop and reconcile it with claude-tasks-state.json before continuing" >&2
     exit 1
   fi
   if [ -f "$config_dir/claude-tasks-state.json" ]; then
     cp "$config_dir/claude-tasks-state.json" "$config_dir/agent-dispatch-state.json"
   fi
   ```

3. With the app tab open and a read-write bridge profile paired, run a one-time bridge eval to copy existing task properties into the new namespace. This leaves the old `claude:*` keys in place and writes only missing `agent:*` keys:

   ```js
   const pairs = [
     ['claude:status', 'agent:status'],
     ['claude:session', 'agent:session'],
     ['claude:watcher', 'agent:watcher'],
     ['claude:updated-at', 'agent:updated-at'],
     ['claude:attempts', 'agent:attempts'],
     ['claude:error', 'agent:error'],
     ['claude:reply', 'agent:reply'],
     ['claude:activity', 'agent:activity'],
     ['claude:asked-at', 'agent:asked-at'],
     ['claude:cancel', 'agent:cancel'],
   ]

   const rows = await sql(
     "select id, properties_json from blocks where deleted = 0 and properties_json like ?",
     ['%claude:%'],
   )

   let updated = 0
   for (const row of rows) {
     const props = JSON.parse(row.properties_json || '{}')
     const patch = {}
     for (const [from, to] of pairs) {
       if (Object.hasOwn(props, from) && !Object.hasOwn(props, to)) patch[to] = props[from]
     }
     if ((Object.hasOwn(props, 'claude:status')
       || Object.hasOwn(props, 'claude:session')
       || Object.hasOwn(props, 'claude:reply'))
       && !Object.hasOwn(props, 'agent:executor')) {
       patch['agent:executor'] = 'claude'
     }
     if (Object.keys(patch).length > 0) {
       await updateBlock({id: row.id, properties: patch})
       updated += 1
     }
   }

   return {scanned: rows.length, updated}
   ```

## Contributor selection

Before starting active watchers, save a contributor for the configured profile and workspace:

```bash
kmagent --profile agent-dispatch contributor create "Dispatch" --kind automation --workspace <workspace-id>
```

Creation selects the profile. To reuse one, run `contributor use <id>` with the same profile/workspace flags; `contributor use none` explicitly opts out. From a repo checkout, use `pnpm agent` in place of `kmagent`. The daemon and its spawned agents use this saved choice; restart the daemon after changing it. Without a choice, active dispatch stops with setup instructions before contacting the bridge. Disabling all watchers can still clear their registration without a contributor.

The contributor is credited only with the agent's own writes: its replies, and whatever its run changes through the km tools. The daemon's `agent:*` bookkeeping on the block that mentioned it (claim, progress, session, completion, cancel) records no attribution, so a person's note keeps exactly the authors who wrote it. With `delivery: "channel"` the ambient session closes the task itself through the km tools, so that one completion write is credited to the contributor.

## Install from npm

If you only want to *run* the daemon (not hack on the repo), install the published packages instead of cloning. You need **both**: `agent-dispatch` (the daemon) and `agent-cli` (the `kmagent` bridge it reaches the live app through).

```bash
npm i -g @knowledge-medium/agent-dispatch @knowledge-medium/agent-cli
```

That puts `km-agent-dispatch` and `kmagent` on your PATH. Then:

1. **Pair a bridge profile** with the global `kmagent` (same as step 1 of Setup below):

   ```bash
   kmagent --profile agent-dispatch connect
   ```

2. **Create the config** at `~/.config/knowledge-medium/agent-dispatch.json` — see step 2 of **Setup** below for the full schema and watcher examples.

3. **Run once by hand** to check it:

   ```bash
   km-agent-dispatch --once
   ```

4. **Install under launchd.** The plist template ships inside the package; re-point it at the globally-installed daemon (the template's path is repo-shaped, so the specific `daemon.js` substitution must come before the generic `__REPO__` → `$HOME`):

   ```bash
   PKG="$(npm root -g)/@knowledge-medium/agent-dispatch"
   sed -e "s|__NODE__|$(command -v node)|g" \
       -e "s|__REPO__/packages/agent-dispatch/dist/daemon.js|$PKG/dist/daemon.js|g" \
       -e "s|__REPO__|$HOME|g" \
       -e "s|__HOME__|$HOME|g" \
       "$PKG/launchd/org.knowledge-medium.agent-dispatch.plist" \
       > ~/Library/LaunchAgents/org.knowledge-medium.agent-dispatch.plist
   launchctl load ~/Library/LaunchAgents/org.knowledge-medium.agent-dispatch.plist
   tail -f ~/Library/Logs/km-agent-dispatch.log
   ```

   (`npx -p @knowledge-medium/agent-dispatch km-agent-dispatch --once` works for a one-off run — the package ships two bins so plain `npx @knowledge-medium/agent-dispatch` can't pick one — but launchd needs a stable installed path, so global install is the right call for the always-on daemon.)

## Setup (from a repo checkout)

1. **Pair a dedicated bridge profile** (revocable independently of your interactive one) with a **read-write** token:

   ```bash
   pnpm agent --profile agent-dispatch connect
   ```

2. **Create the config** at `~/.config/knowledge-medium/agent-dispatch.json`:

   ```jsonc
   {
     "profile": "agent-dispatch",
     "workspaceId": "YOUR_WORKSPACE_ID", // required: the workspace the daemon acts on
     "pollIntervalMs": 5000,
     "maxConcurrent": 4,
     "runsPerHour": 45, // launches per rolling hour, across all watchers
     "watchers": [
       {
         "kind": "backlinks",
         "name": "claude-mentions",
         "target": "claude"           // page alias; [[claude]] anywhere becomes a task
       },
       {
         "kind": "backlinks",
         "name": "reading-inbox",
         "target": "to-claude-review",
         "prompt": "A new item was filed under [[to-claude-review]]:\n{{subtree}}\nWrite a 3-bullet critical summary as your reply."
       },
       {
         "kind": "query",
         "name": "stale-actions",
         "sql": "SELECT id, content FROM blocks WHERE workspace_id = 'YOUR_WORKSPACE_ID' AND json_extract(properties_json, '$.\"action:status\"') = 'open'",
         "prompt": "New open action items appeared:\n{{newRows}}\nTriage them: add a priority property to each via update_block."
       },
       {
         "kind": "backlinks",
         "name": "repo-claude",
         "target": "claude-repo",
         "prompt": "Handle this repo task:\n{{subtree}}",
         "runner": {
           "executor": "claude",
           "allowedTools": ["Bash(git:*)"],
           "cwd": "/Users/YOU/code/YOUR_REPO"
         }
       },
       {
         "kind": "backlinks",
         "name": "repo-codex",
         "target": "codex",
         "prompt": "Handle this repo task:\n{{subtree}}",
         "runner": {
           "executor": "codex",
           "cwd": "/Users/YOU/code/YOUR_REPO",
           "sandbox": "workspace-write",
           "addDirs": ["/private/tmp"],
           "networkAccess": true
         }
       }
     ]
   }
   ```

   The `claude` page must exist (type `[[claude]]` once and click it).

   **`workspaceId` is required.** It is the workspace the daemon acts on. List yours with `pnpm agent --profile agent-dispatch sql all "SELECT id, name FROM workspaces"`.
   - Every graph call the daemon and its runs make names this workspace. Backlink watchers resolve their page alias in it, whatever workspace the app tab has open.
   - Its writes (claims, replies) only run while an app tab has this workspace open. While none does, it claims nothing and starts no runs.

   **Also scope query watchers' SQL to the same `workspace_id`.** The local `blocks` table holds *every* synced workspace, and a query watcher's SQL runs as written, so an unscoped query fires runs against workspaces you aren't working in.

   Set `"disabled": true` on any watcher to keep it parked in the config without registering it, blocking its target wikilinks, affecting billing posture, or processing tasks. Disabled watchers still have to be valid watcher objects, so broken parked config is caught at startup instead of drifting silently. They also still reserve their `name`, because cursors and baselines are keyed by watcher name. If every configured watcher is disabled, the daemon clears its existing push registration and stops.

3. **Build + run once by hand:**

   ```bash
   pnpm run compile
   node packages/agent-dispatch/dist/daemon.js --once   # or: pnpm agent-dispatch
   ```

4. **Install under launchd** (keeps it running, restarts on crash):

   ```bash
   sed -e "s|__NODE__|$(command -v node)|g" -e "s|__REPO__|$(pwd)|g" -e "s|__HOME__|$HOME|g" \
     packages/agent-dispatch/launchd/org.knowledge-medium.agent-dispatch.plist \
     > ~/Library/LaunchAgents/org.knowledge-medium.agent-dispatch.plist
   launchctl load ~/Library/LaunchAgents/org.knowledge-medium.agent-dispatch.plist
   tail -f ~/Library/Logs/km-agent-dispatch.log
   ```

## A second listener

A second daemon can run on the same machine, beside the first, with its own trigger page and its own bridge profile, and read the first one's memory. For example, a listener on `[[Assistant (host)]]` that answers through a headless host's `headless` profile while `[[Assistant]]` keeps answering through the app tab:

```jsonc
// ~/.config/knowledge-medium/agent-dispatch-host.json
{
  "instance": "host",     // names this daemon's files; see below
  "profile": "headless",  // a read-write profile on a writable host
  "workspaceId": "YOUR_WORKSPACE_ID",
  "watchers": [
    {"kind": "backlinks", "name": "assistant-host", "target": "Assistant (host)"}
  ]
}
```

- **`instance`** gives the daemon its own pidfile, generated MCP config, state file (unless `statePath` is set) and watch-events registration: `daemon.pid`, `mcp.json` and `state.json` in `~/.config/knowledge-medium/agent-dispatch-host/`. A config without `instance` keeps the original files (`agent-dispatch.pid`, …). Two configs without one share a pidfile, so the second refuses to start.
- **The rule: no two daemons watch the same `target`.** Nothing checks this across configs; two daemons on one page would both claim its mentions.
- To share an index between listeners, put the common notes under a page and add a page embed such as `![[Shared notes]]` to each listener’s `Memory`. Each page child appears as a shared summary. A block embed such as `!((<id>))` shares that one block as a note. If it points at another watcher’s entire `Memory` block, the index shows one shared entry with a child count. The run can read its contents with `subtree`. Each listener saves new notes under its own `Memory`.
- **Write guard:** each daemon refuses only its own targets, so a run of either can write the other's `[[target]]` and start one run there (`runsPerHour` bounds it).
- **Threads:** a follow-up under the other daemon's reply resumes that daemon's session, without the other daemon knowing. Keep each thread to one trigger page.
- `runsPerHour` and `maxConcurrent` hold per daemon. With `delivery: "channel"`, give it its own `channelPort` as well.

To start it:

1. Make the profile writable and select the contributor its writes are credited to, for example the first daemon's: `kmagent --profile agent-dispatch contributor list`, then `kmagent --profile headless contributor use <id> --workspace YOUR_WORKSPACE_ID`. For the headless host, see [Host setup and write verification](../../docs/headless-client.md#owner-verification-for-slice-3).
2. Create the `[[Assistant (host)]]` page with a child block titled `Memory`, and under it one block `!((<id>))` with the id of `[[Assistant]]`'s `Memory` block (`kmagent --profile agent-dispatch subtree Assistant` prints it after the `^`).
3. Run it once by hand: `km-agent-dispatch --config ~/.config/knowledge-medium/agent-dispatch-host.json --once` (from a checkout: `node packages/agent-dispatch/dist/daemon.js --config …`). Its first tick only records a baseline, so mention `[[Assistant (host)]]` after it.
4. Install it under launchd as its own job, from a copy of the first one's plist:

   ```bash
   P=~/Library/LaunchAgents/org.knowledge-medium.agent-dispatch-host.plist
   cp ~/Library/LaunchAgents/org.knowledge-medium.agent-dispatch.plist "$P"
   plutil -replace Label -string org.knowledge-medium.agent-dispatch-host "$P"
   plutil -insert ProgramArguments -string --config -append "$P"
   plutil -insert ProgramArguments -string "$HOME/.config/knowledge-medium/agent-dispatch-host.json" -append "$P"
   plutil -replace StandardOutPath -string "$HOME/Library/Logs/km-agent-dispatch-host.log" "$P"
   plutil -replace StandardErrorPath -string "$HOME/Library/Logs/km-agent-dispatch-host.log" "$P"
   launchctl load "$P"
   tail -f ~/Library/Logs/km-agent-dispatch-host.log
   ```

   Restart it with `launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch-host`; for a by-hand run, stop it with `launchctl bootout gui/$(id -u)/org.knowledge-medium.agent-dispatch-host`.

## How a mention task runs

0. A watcher's **first tick establishes a baseline without firing**: pre-existing backlinks to `target` are history, not a backlog — pointing a watcher at an established page (hundreds of old mentions) must not claim and bill them. Only blocks **edited after** the baseline become tasks; editing an old mention deliberately re-surfaces it. Baselines persist in the state file — delete the watcher's `backlinkBaselines` entry there to re-baseline.
1. Watcher sees a new backlink to `target` whose source block has no `agent:status` property (one batched SQL per tick — processed mentions stay cheap forever). A block that references the target only through attribution (`attribution:creators` / `attribution:editors`, which credit a contributor page) is not a mention, so the target page can double as the runs' contributor without every block a run writes summoning it again. A property's value block (a child of a property row, in a workspace whose properties are stored as blocks) is never a mention source either: the property belongs to the block it is on, which is where the daemon judges it. A mention waits until it is ready, so the daemon doesn't claim (and bill) a request you are still writing:
   - **It leaves the editor.** Edit state lives on each panel's ui-state row, which syncs, so this works for a request written on another device as well as in the daemon's own tab. The mention fires `settleMs` (default 250 ms) after it leaves the editor, the time for the edit's last write to land. Pausing to think, or switching to another app, doesn't count as leaving; moving to another block does, including pressing Enter.
   - **Or neither its text nor its editor has moved for `editHoldMs`** (default 2 min) while it is still open. Typing and moving the caret count; switching to another app or locking the device does not, so a request left open that way fires after the cap. A closed tab or dead device leaves its flag set forever, so the flag can only hold a mention this long; the next sweep then claims it.
   - **Or you use Ask Agent**, which fires from inside the editor without waiting for you to leave. It covers the text as you asked about it: keep writing afterwards and the mention waits again.
2. Claim: `agent:status=running` + `agent:watcher` + `agent:executor` + `agent:attempts` + `agent:updated-at` written to the block, then **claim-verified** (re-read; if a competing daemon overwrote it, this one backs off).
3. Prompt = mention content + full subtree outline + ancestor path (`prompt.ts` template, overridable per watcher; `{{target}}` is the watcher's page alias), delivered over **stdin** (never argv — `ps`-visible and ARG_MAX-capped). A mention that is a comment in a thread also gets the thread: the annotated block's text and page path, the quote, and the comments from the thread's first one down to the mention, with their authors (`{{thread}}`; a custom `prompt` without it gets the thread appended). Reading it needs an app with the `comments` verb; without one the mention is answered without it.
4. The configured runner starts with the km MCP graph tools. Claude uses fail-closed `--allowedTools` + `--strict-mcp-config`, is offered only the built-in tools its allow list names (`--tools`) and no skills (`--disable-slash-commands`) unless that list names `Skill`, so the user's interactive plugins don't ride along on every request, and gets the km tools in its first prompt (`alwaysLoad`) rather than behind tool search; `runner.model` and `runner.effort` pass through as `--model` and `--effort`, and unset they take your Claude Code defaults; `WebSearch`, `WebFetch` and `Agent` (subagents, which get only the tools the run is offered) come from the top-level `defaultAllowedTools`, and `runner.allowedTools` opts into more. Codex uses its `runner.sandbox` / `runner.addDirs` / `runner.networkAccess` / `runner.approvalPolicy` / `runner.approvalsReviewer` settings. `runner.cwd` defaults to `$HOME`. `runner.timeoutMs` kills a run that is still going after it (default 10 min, at most 60 min).
5. The prompt also carries the watcher's memory (see [Memory](#memory)) unless the watcher sets `"memory": false`.
6. Reply text lands as a child block (marked `agent:reply` so it can never re-trigger), status flips to `done`, and the session id is stored as `agent:session`.
7. **Threads:** a later `[[claude]]` mention anywhere under that block — including directly under Claude's reply — finds the nearest ancestor `agent:session` and `--resume`s it (never two concurrent resumes of one session: a follow-up whose thread is still running is marked `agent:status=queued`, with an `agent:activity` saying why, and runs once that run ends). For parallel runs, mention outside the running thread — that starts a fresh session.

Failures reply visibly (`⚠️ …`) and set `agent:status=error` + `agent:error` — including infrastructure failures (bridge blip, spawn error), not just failed runs. A `running` block older than 65 min (the longest allowed run plus grace) is treated as a crashed run and re-queued, at most 3 attempts total. To re-run a mention manually, delete its `agent:*` properties.

**One daemon per trigger page.** A pidfile prevents two daemons of one instance on one machine (launchd + a manual run would double-claim and double-bill). Across machines, and across instances, there is no claim atomicity over LWW sync, so no two daemons may watch the same `target`: install each LaunchAgent on exactly one device, and give each daemon on a machine its own targets.

## Memory

Each backlinks watcher keeps a memory under a block titled `Memory` that sits directly under the watcher's target page. Watchers with the same target share it. The daemon creates that block on the first run and finds it again after you retitle it. You can also create the `Memory` block yourself. Every run, including follow-ups, gets an index of up to 100 note summaries with full block IDs and child counts where applicable. IDs for summaries beyond the limit are listed for lookup. A run can read relevant details with the km `subtree` and `get_block` tools.

The run keeps its memory with the ordinary km write tools. New notes use a short summary block with details in children. When updating or merging notes, the run reads the existing notes and preserves details that still apply. Embedded notes appear as `[shared]`. The run changes them only at your explicit request and keeps new entries under its own `Memory` block. Memory is for corrections, lasting preferences, and facts you state that later requests will need. Edit, move or delete the notes by hand as you would any block.

When a run changes the memory, the daemon adds a line to the end of its reply, failed and cancelled runs included: `Memory changed during this run: saved …; edited …; removed "…" (id)`, with links to the saved and edited blocks. A removed note is soft-deleted: `kmagent restore-block <id>` brings it back. The daemon compares the subtrees under `Memory` and the shared roots known at the start of the run. The comparison includes nested details even when the prompt omits them and also catches changes made meanwhile by another run on the same target or by you. Past 1000 blocks it says the memory is too large to compare instead. With `delivery: "channel"` the run gets the memory too, but no such line, since the ambient session posts its own reply. If the memory can't be read, the run goes ahead without it and is not asked to keep it. Set `"memory": false` on a watcher to turn this off.

A `[[claude]]` you write inside the memory starts a run like anywhere else; children of the target page are not backlinks to it, so the memory itself never does.

### Loop guards

- Replies carry `agent:reply` and are skipped. (User-typed follow-ups *under* a reply are legit and do fire.)
- The default prompts forbid writing the watcher's own `[[target]]`, and the dispatch MCP wrapper's write guard **refuses** any reference to a watcher-target page — every alias of the page (`[[any-alias]]`) and its id in every block-ref form (`((id))`, `!((id))`, `[label](((id)))`). The daemon passes the target names (`KM_MCP_BLOCKED_WIKILINKS`); the dispatch wrapper resolves each page's full alias set + id at write time.
- `runsPerHour` bounds whatever slips past both.

## Live progress

Spawned executors stream progress where their CLI supports it, so the daemon sees progress as the run goes, not just the final result. While a run is in flight, the source block carries `agent:activity` — a short label for whatever the run is doing right now (a tool name, humanized: `km: search`, `Searching the web`, `Fetching a page`, …) — and `agent:activity-at`, its start time in epoch milliseconds. The companion UI's fixed-width status chip pairs a compact activity label (`Thinking`, `Reading`, `Writing`, …) with the current step age. Its title and menu show the runner, exact activity, time on this step, and total run time separately. A `km:` step outstanding for more than 20 seconds gets a warning; this is an early indication of a long wait, not proof of a bridge failure. Other steps show age without warnings. It uses a client-side clock, with no heartbeat writes. The label and timestamp clear together at a terminal state (`''` and `0` respectively). Without a step timestamp, the chip omits the step timer; total run time remains in the details when the claim timestamp is available.

Set `"streamReply": true` on a backlinks watcher to also show the reply being **built live** as the run streams, instead of posting it once at the end. Each tick reconciles the reply to the growing text (throttled to roughly one write per 1.5s, writing only the diff), so leave it off for watchers where that write churn matters — the default (`false`) posts the whole reply in one shot when the run finishes.

## Reply as a block hierarchy

By default (`"splitReply": true`) a reply is shaped as a block hierarchy split along its **markdown outline** under the mention — top-level lines/bullets become sibling blocks, indented bullets become child blocks, headings nest their following content, and fenced code stays whole. Free-form lines stay one-block-per-line and fenced code stays intact, so this fragments *structure*, not code. The spawned run is also nudged to write a nested outline so the split threads naturally (the "prompting" half; the parsing is the "injection" half).

`streamReply` and `splitReply` are **orthogonal and share one mechanism**: the reply is a keyed block subtree the app *reconciles* to match the reply markdown — `splitReply` picks its shape (outline vs one block), `streamReply` picks the cadence (rebuild it live on every tick, or once at the end). Parsing + insertion happen **app-side**: the daemon sends the markdown over the `reconcile-markdown-subtree` bridge command, and the app runs its **own paste parser** (`parseMarkdownToBlocks`) and makes the tagged subtree equal the parsed tree in **one transaction**. So the split matches "paste as markdown" exactly, a failure never leaves a partial reply, and — because the write is idempotent (keyed per run) — a growing stream just extends the tail in place and a transient bridge blip is **retried** rather than surfacing as `status=error`. With `streamReply` also on, the live text builds directly into that same subtree (a split reply threads out as it's written; a single-block reply grows in place), so there's no end-of-run "explosion" and no orphaned placeholder.

Set `"splitReply": false` on a watcher to keep the reply as a single block. Notes:
- A structureless reply (one paragraph) lands as a single block either way.
- A **failed** run never splits — any streamed partial collapses to a single block with the error note appended.
- Ignored for `delivery: "channel"` watchers — the ambient session writes its own reply.
- Requires an app build new enough to handle the `reconcile-markdown-subtree` command; against an older tab the run errors visibly rather than silently falling back.

## Push detection (watch-events)

By default (`"push": true`) the daemon registers its watchers **inside the tab** via the bridge `watch-events` command: the tab re-runs each watcher's read-only query when its tables change, waits for the result set to be stable (`settleMs`), and pushes a `watcher-settled` event over the bridge events channel (`/runtime/events`). A mention's query result includes whether it is open in an editor, so leaving the editor wakes the daemon too. The daemon long-polls those events and ticks immediately, so detection latency is the settle window, not the next poll.

Events are accelerators, not truth: every tick still re-derives everything from graph state, so missed/duplicate/spurious events cost at most one cheap tick. The poll loop stays on as the correctness backstop — with push active, raise `pollIntervalMs` to a slow sweep (30 000 is plenty); without push (old tab bundle, `"push": false`), keep it low because it IS the detection latency.

Registrations are ephemeral tab state: they die with the tab and expire after 10 min without a refresh (the daemon re-registers every 5 min and after any error). All of it is bounded — a dead daemon can't leave watchers running, and a dead tab just means the daemon falls back to sweep cadence until it's back.

## Query watchers

Rows must select a stable `id` column. First tick establishes a baseline without firing (no backlog replay); afterwards, new ids fire one batched run. Cursors live in the state file, `~/.config/knowledge-medium/agent-dispatch-state.json` unless `statePath` or `instance` says otherwise (alongside the backlink-watcher baselines); the cursor advances **before** the run so a failing prompt can't re-bill every tick (failures are logged, not retried).

## km MCP server standalone

The same generic graph tools work from any MCP client — e.g. Claude Desktop / interactive Claude Code:

```json
{
  "mcpServers": {
    "km": {
      "command": "node",
      "args": ["<repo>/packages/agent-cli/dist/mcp.js"],
      "env": {"AGENT_RUNTIME_PROFILE": "agent-dispatch", "AGENT_RUNTIME_CONTRIBUTOR_ID": "<contributor-id>"}
    }
  }
}
```

Tools: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query` (single read-only statement — SELECT, or WITH without mutating keywords; multi-statement, `WITH … UPDATE` forms, and side-effecting `powersync_*()` function calls are rejected), `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block` (single block only; descendants remain deleted unless restored separately). Deliberately excluded: `eval`, `sql execute`, extension lifecycle. The standalone `agent-cli` `km-mcp` server does not apply dispatch watcher-target guards; use `packages/agent-dispatch/dist/mcp.js` when the session is acting as part of an agent-dispatch watcher loop.

The server also offers `read_media` and `add_media`, and dispatch runs get both. `read_media` images arrive inline; a non-image comes back as a file a run can open only if it has a tool for that. `add_media` here stores only bytes the run passes in (`content`, such as an SVG it wrote): dispatch's server has no `path` argument, so no note can turn it into a read of this machine's files. Uploads sync to everyone in the workspace, like any other write.

## Security posture

- The daemon's bridge token is scoped to its own profile — revoke it in the app's token dialog to kill all graph access at once.
- **Claude executor:** spawned runs get **no Bash and no filesystem tools by default**; graph MCP tools plus `WebSearch`/`WebFetch` and subagents (the top-level `defaultAllowedTools`); a subagent gets the same tools as its run, no more. Watchers that operate on code repos must opt in via `runner.allowedTools` + `runner.cwd`, which is a deliberate, per-watcher decision. Naming `Skill` there lets a run load skills: those under `runner.cwd`'s `.claude/skills/`, its `.claude/commands/`, the user's own, installed plugins', and Claude Code's bundled ones. `Skill` needs no approval in print mode, so every one of them is admitted (a `Skill(name)` rule narrows nothing), each one's description rides along on every request, and a prompt that starts with `/` runs as a command, which matters only for a custom `prompt` that starts with note text. A skill still gets only the tools its run is offered. **This fail-closed posture is claude-only** — a `"runner": {"executor": "codex"}` watcher runs shell commands under Codex's configured sandbox and ignores `allowedTools` entirely (see the codex Sandboxing bullet above).
- **Web-tools trade-off:** `WebFetch` ingests arbitrary page text, so a prompt-injected page can steer a run that also holds graph *write* tools — including exfiltrating note content through crafted fetch URLs. Neither web tool touches the local machine, and `runsPerHour` bounds the blast radius, but if your notes are sensitive set `"defaultAllowedTools": []` to keep runs graph-only.
- **Billing — safe by default, opt in on purpose:** `"billing": "subscription"` (default) scrubs every API-key/token/provider-reroute env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, bedrock/vertex/base-url switches, …) from the child, so a key you exported for something else can't silently put an unattended daemon on usage-based billing — the CLI's plan login (OAuth) wins. To *intentionally* run on API credits, set `"billing": "api"`, which skips the scrub. The daemon logs the effective mode at startup, naming (never printing) any credential vars it found. **One gap it can't close:** a key stored via `claude`/`codex` login (`--with-api-key` → `auth.json`, or an `apiKeyHelper`) lives outside the env and is *not* scrubbable — the startup log flags this; verify your login state if you're unsure which account a run bills.
- **Memory persists what a run is told:** a run that a prompt-injected page steers could save a "preference" that every later run then reads, and anyone who can edit the target page can write a note there, as they can already write a mention. Runs are told to save only what the user said and to weigh memory as context, never above the request; the line the daemon adds to the reply shows every change made to the memory during the run, whatever the run says itself. Read those lines, and set `"memory": false` on a watcher whose runs read untrusted content routinely.
- No Claude `--dangerously-skip-permissions` or Codex `--dangerously-bypass-approvals-and-sandbox` anywhere. Claude print mode denies anything outside the allowlist; Codex authority is bounded by its configured sandbox and approval policy.

## Ambient mode via channels (EXPERIMENTAL)

Claude Code's channels primitive (research preview, v2.1.80+) can push watcher events into one *persistent* session instead of spawning a run per task. The dispatch MCP wrapper layers dispatch write policy and that listener on top of the generic km graph tools; the channel listener is off unless all three pieces are opted in:

1. Register km in the project's `.mcp.json` with the channel port:

   ```json
   {"mcpServers": {"km": {"command": "node", "args": ["<repo>/packages/agent-dispatch/dist/mcp.js"], "env": {"AGENT_RUNTIME_PROFILE": "agent-dispatch", "AGENT_RUNTIME_WORKSPACE": "<workspace-id>", "KM_AGENT_DISPATCH_CHANNEL_PORT": "8790", "KM_MCP_BLOCKED_WIKILINKS": "[\"claude\"]"}}}}
   ```

   `AGENT_RUNTIME_WORKSPACE` pins the ambient session to the daemon's workspace. The dispatch MCP server reads the contributor selection saved for that profile and workspace; create/select it first with `kmagent --profile agent-dispatch contributor use <id|none> --workspace <workspace-id>`. An explicit `AGENT_RUNTIME_CONTRIBUTOR_ID` in this MCP config overrides the saved choice (`none` opts out of attribution).

   (`KM_MCP_BLOCKED_WIKILINKS` is consumed by the dispatch wrapper — without it the ambient session's write tools would happily write `[[claude]]` and re-trigger the watcher.)

2. Run the ambient session (custom channels aren't on the preview allowlist, hence the dev flag):

   ```bash
   claude --dangerously-load-development-channels server:km
   ```

3. Mark watchers `"delivery": "channel"` in the daemon config.

The daemon then claims the task (`agent:status=running`) and POSTs the rendered event to `127.0.0.1:8790`; it arrives as a `<channel source="km">` event and the ambient session **finishes the lifecycle itself** — reply block + `agent:status=done` via the km tools (the event says exactly how). If the ambient session drops it, the stale-`running` sweep re-delivers after 65 min (3 attempts max, then parked as `error`). If the listener is down, mention tasks are marked `error`; query rows keep their cursor and re-fire when it's back.

**Listener auth:** loopback is not an auth boundary (any local process — or a browser page POSTing at `127.0.0.1` — could otherwise inject prompts into a write-capable session). Requests must carry `x-km-channel-secret` from `~/.config/knowledge-medium/agent-dispatch-channel.secret` (0600, auto-generated; the daemon sends it automatically) and be `application/json` with no `Origin` header.

Caveats, honestly: research preview (flag syntax/protocol may change — nothing load-bearing depends on it here); one shared context across all events vs per-thread isolation (no `--resume` threading in this mode); events only arrive while the session is open. Per-task spawn remains the default and the recommendation.

## Troubleshooting

- Waiting on `bridge/pairing` in the log → the daemon auto-starts the bridge and retries forever (reboot-safe); if it never pairs, run `kmagent --profile agent-dispatch connect` with the app tab open.
- Config errors exit **0** (clean) so launchd doesn't hot-loop a restart that can't help — fix the config, then `launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch`.
- `Another km-agent-dispatch is already running` → the pidfile guard; stop the launchd instance before running one by hand (`launchctl bootout gui/$(id -u)/org.knowledge-medium.agent-dispatch`, or the job of the config's `instance`).
- `Page "claude" does not exist` → create the page (type `[[claude]]`, click it).
- Daemon logs `no app tab connected` → watchers idle until a paired tab appears; they catch up on the next tick.
- Runs fail instantly with auth errors → check `claude login` state on this machine and that nothing exports `ANTHROPIC_API_KEY` into launchd's environment (the daemon scrubs its children, but `claude` itself must be logged in).
- Known limitation: if the daemon is SIGKILLed mid-run, the spawned `claude` child survives un-timed; its reply is lost and the task re-queues after the 65-min sweep (bounded by the 3-attempt cap).
