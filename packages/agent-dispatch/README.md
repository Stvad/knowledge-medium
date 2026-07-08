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

Design notes: task state lives **in the graph** (`agent:*` block properties), so the daemon is restart-safe for mention watchers — it re-derives pending work from block properties, and a mention synced from your iPad triggers once the Mac client sees it. **Run exactly one daemon per fleet**, though: the claim is a plain property write with no cross-device compare-and-swap, so two daemons on two machines can both claim the same mention within sync latency (the claim-verify and pidfile only prevent *same-machine* double-claims). The bridge requires a live app tab; no tab → watchers idle.

## Billing invariant (subscription, not API)

Runs execute via `claude -p` on a machine authenticated with `claude login`. The daemon **scrubs `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and the `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` switches from every child environment** — any of them would silently redirect billing. One thing env-scrubbing can't reach: a user-level `settings.json` `apiKeyHelper` — check yours if runs bill unexpectedly. Nothing here touches the Agent SDK (API-key-only by policy).

**Spend circuit-breaker:** `runsPerHour` (default 10) caps launches across all watchers in a rolling hour. Any watcher-loop bug or misconfigured query becomes a bounded bill, not an unbounded one. Additionally each task is attempted at most 3 times (crashed/dropped runs re-queue via the 30-min stale sweep) before being parked as `error` with a visible reply.

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

## Setup

1. **Pair a dedicated bridge profile** (revocable independently of your interactive one) with a **read-write** token:

   ```bash
   yarn agent --profile agent-dispatch connect
   ```

2. **Create the config** at `~/.config/knowledge-medium/agent-dispatch.json`:

   ```jsonc
   {
     "profile": "agent-dispatch",
     "pollIntervalMs": 5000,
     "maxConcurrent": 2,
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

   **Always scope query watchers to a `workspace_id`** — the local `blocks` table holds *every* synced workspace, so an unscoped query fires runs (and their `update_block` writes) against workspaces you aren't working in. Get yours from `yarn agent runtime-summary`. Backlink watchers don't need this (a page alias resolves within the active workspace).

   Set `"disabled": true` on any watcher to keep it parked in the config without registering it, blocking its target wikilinks, affecting billing posture, or processing tasks. Disabled watchers still have to be valid watcher objects, so broken parked config is caught at startup instead of drifting silently. They also still reserve their `name`, because cursors and baselines are keyed by watcher name. If every configured watcher is disabled, the daemon clears its existing push registration and stops.

3. **Build + run once by hand:**

   ```bash
   yarn run compile
   node packages/agent-dispatch/dist/daemon.js --once   # or: yarn agent-dispatch
   ```

4. **Install under launchd** (keeps it running, restarts on crash):

   ```bash
   sed -e "s|__NODE__|$(command -v node)|g" -e "s|__REPO__|$(pwd)|g" -e "s|__HOME__|$HOME|g" \
     packages/agent-dispatch/launchd/org.knowledge-medium.agent-dispatch.plist \
     > ~/Library/LaunchAgents/org.knowledge-medium.agent-dispatch.plist
   launchctl load ~/Library/LaunchAgents/org.knowledge-medium.agent-dispatch.plist
   tail -f ~/Library/Logs/km-agent-dispatch.log
   ```

## How a mention task runs

0. A watcher's **first tick establishes a baseline without firing**: pre-existing backlinks to `target` are history, not a backlog — pointing a watcher at an established page (hundreds of old mentions) must not claim and bill them. Only blocks **edited after** the baseline become tasks; editing an old mention deliberately re-surfaces it. Baselines persist in the state file — delete the watcher's `backlinkBaselines` entry there to re-baseline.
1. Watcher sees a new backlink to `target` whose source block has no `agent:status` property (one batched SQL per tick — processed mentions stay cheap forever). Blocks edited in the last `quietMs` (default 15 s) wait — the daemon shouldn't claim (and bill) a half-typed request.
2. Claim: `agent:status=running` + `agent:watcher` + `agent:executor` + `agent:attempts` + `agent:updated-at` written to the block, then **claim-verified** (re-read; if a competing daemon overwrote it, this one backs off).
3. Prompt = mention content + full subtree outline + ancestor path (`prompt.ts` template, overridable per watcher), delivered over **stdin** (never argv — `ps`-visible and ARG_MAX-capped).
4. The configured runner starts with the km MCP graph tools. Claude uses fail-closed `--allowedTools` + `--strict-mcp-config`; `WebSearch`/`WebFetch` come from the top-level `defaultAllowedTools`, and `runner.allowedTools` opts into more. Codex uses its `runner.sandbox` / `runner.addDirs` / `runner.networkAccess` / `runner.approvalPolicy` / `runner.approvalsReviewer` settings. `runner.cwd` defaults to `$HOME`.
5. Reply text lands as a child block (marked `agent:reply` so it can never re-trigger), status flips to `done`, and the session id is stored as `agent:session`.
6. **Threads:** a later `[[claude]]` mention anywhere under that block — including directly under Claude's reply — finds the nearest ancestor `agent:session` and `--resume`s it (never two concurrent resumes of one session).

Failures reply visibly (`⚠️ …`) and set `agent:status=error` + `agent:error` — including infrastructure failures (bridge blip, spawn error), not just failed runs. A `running` block older than 30 min is treated as a crashed run and re-queued, at most 3 attempts total. To re-run a mention manually, delete its `agent:*` properties.

**One daemon per fleet.** A pidfile prevents two daemons on one machine (launchd + a manual run would double-claim and double-bill). Across machines there is no claim atomicity over LWW sync — install the LaunchAgent on exactly one device.

### Loop guards

- Replies carry `agent:reply` and are skipped. (User-typed follow-ups *under* a reply are legit and do fire.)
- The default prompt forbids writing `[[claude]]`, and the dispatch MCP wrapper's write guard **refuses** any reference to a watcher-target page — every alias of the page (`[[any-alias]]`) and its id in every block-ref form (`((id))`, `!((id))`, `[label](((id)))`). The daemon passes the target names (`KM_MCP_BLOCKED_WIKILINKS`); the dispatch wrapper resolves each page's full alias set + id at write time.
- `runsPerHour` bounds whatever slips past both.

## Live progress

Spawned executors stream progress where their CLI supports it, so the daemon sees progress as the run goes, not just the final result. While a run is in flight, the source block carries `agent:activity` — a short label for whatever the run is doing right now (a tool name, humanized: `km: search`, `Searching the web`, `Fetching a page`, …). The companion UI's status chip shows the persisted runner label next to elapsed time (`Claude · 12s · Searching the web`, `Codex · 12s · km: search`); the label is cleared the moment the run reaches a terminal state, so it never goes stale.

Set `"streamReply": true` on a backlinks watcher to also stream the in-progress reply text into the reply block as it's written, instead of only posting it once at the end. Each streamed update is a real synced graph mutation (throttled to roughly one write per 1.5s), so leave it off for watchers where that write churn matters — the default (`false`) still posts the full reply in one shot when the run finishes.

## Push detection (watch-events)

By default (`"push": true`) the daemon registers its watchers **inside the tab** via the bridge `watch-events` command: the tab re-runs each watcher's read-only query when its tables change, waits for the result set to be stable (`settleMs` = the watcher's `quietMs` for mentions), and pushes a `watcher-settled` event over the bridge events channel (`/runtime/events`). The daemon long-polls those events and ticks immediately — detection latency becomes "quiet period ends", instead of "next poll + quiet period".

Events are accelerators, not truth: every tick still re-derives everything from graph state, so missed/duplicate/spurious events cost at most one cheap tick. The poll loop stays on as the correctness backstop — with push active, raise `pollIntervalMs` to a slow sweep (30 000 is plenty); without push (old tab bundle, `"push": false`), keep it low because it IS the detection latency.

Registrations are ephemeral tab state: they die with the tab and expire after 10 min without a refresh (the daemon re-registers every 5 min and after any error). All of it is bounded — a dead daemon can't leave watchers running, and a dead tab just means the daemon falls back to sweep cadence until it's back.

## Query watchers

Rows must select a stable `id` column. First tick establishes a baseline without firing (no backlog replay); afterwards, new ids fire one batched run. Cursors live in `~/.config/knowledge-medium/agent-dispatch-state.json` (alongside the backlink-watcher baselines); the cursor advances **before** the run so a failing prompt can't re-bill every tick (failures are logged, not retried).

## km MCP server standalone

The same generic graph tools work from any MCP client — e.g. Claude Desktop / interactive Claude Code:

```json
{
  "mcpServers": {
    "km": {
      "command": "node",
      "args": ["<repo>/packages/agent-cli/dist/mcp.js"],
      "env": {"AGENT_RUNTIME_PROFILE": "agent-dispatch"}
    }
  }
}
```

Tools: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query` (single read-only statement — SELECT, or WITH without mutating keywords; multi-statement, `WITH … UPDATE` forms, and side-effecting `powersync_*()` function calls are rejected), `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block` (single block only; descendants remain deleted unless restored separately). Deliberately excluded: `eval`, `sql execute`, extension lifecycle. The standalone `agent-cli` `km-mcp` server does not apply dispatch watcher-target guards; use `packages/agent-dispatch/dist/mcp.js` when the session is acting as part of an agent-dispatch watcher loop.

## Security posture

- The daemon's bridge token is scoped to its own profile — revoke it in the app's token dialog to kill all graph access at once.
- **Claude executor:** spawned runs get **no Bash and no filesystem tools by default**; graph MCP tools plus `WebSearch`/`WebFetch` (the top-level `defaultAllowedTools`). Watchers that operate on code repos must opt in via `runner.allowedTools` + `runner.cwd`, which is a deliberate, per-watcher decision. **This fail-closed posture is claude-only** — a `"runner": {"executor": "codex"}` watcher runs shell commands under Codex's configured sandbox and ignores `allowedTools` entirely (see the codex Sandboxing bullet above).
- **Web-tools trade-off:** `WebFetch` ingests arbitrary page text, so a prompt-injected page can steer a run that also holds graph *write* tools — including exfiltrating note content through crafted fetch URLs. Neither web tool touches the local machine, and `runsPerHour` bounds the blast radius, but if your notes are sensitive set `"defaultAllowedTools": []` to keep runs graph-only.
- **Billing — safe by default, opt in on purpose:** `"billing": "subscription"` (default) scrubs every API-key/token/provider-reroute env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, bedrock/vertex/base-url switches, …) from the child, so a key you exported for something else can't silently put an unattended daemon on usage-based billing — the CLI's plan login (OAuth) wins. To *intentionally* run on API credits, set `"billing": "api"`, which skips the scrub. The daemon logs the effective mode at startup, naming (never printing) any credential vars it found. **One gap it can't close:** a key stored via `claude`/`codex` login (`--with-api-key` → `auth.json`, or an `apiKeyHelper`) lives outside the env and is *not* scrubbable — the startup log flags this; verify your login state if you're unsure which account a run bills.
- No Claude `--dangerously-skip-permissions` or Codex `--dangerously-bypass-approvals-and-sandbox` anywhere. Claude print mode denies anything outside the allowlist; Codex authority is bounded by its configured sandbox and approval policy.

## Ambient mode via channels (EXPERIMENTAL)

Claude Code's channels primitive (research preview, v2.1.80+) can push watcher events into one *persistent* session instead of spawning a run per task. The dispatch MCP wrapper layers dispatch write policy and that listener on top of the generic km graph tools; the channel listener is off unless all three pieces are opted in:

1. Register km in the project's `.mcp.json` with the channel port:

   ```json
   {"mcpServers": {"km": {"command": "node", "args": ["<repo>/packages/agent-dispatch/dist/mcp.js"], "env": {"AGENT_RUNTIME_PROFILE": "agent-dispatch", "KM_AGENT_DISPATCH_CHANNEL_PORT": "8790", "KM_MCP_BLOCKED_WIKILINKS": "[\"claude\"]"}}}}
   ```

   (`KM_MCP_BLOCKED_WIKILINKS` is consumed by the dispatch wrapper — without it the ambient session's write tools would happily write `[[claude]]` and re-trigger the watcher.)

2. Run the ambient session (custom channels aren't on the preview allowlist, hence the dev flag):

   ```bash
   claude --dangerously-load-development-channels server:km
   ```

3. Mark watchers `"delivery": "channel"` in the daemon config.

The daemon then claims the task (`agent:status=running`) and POSTs the rendered event to `127.0.0.1:8790`; it arrives as a `<channel source="km">` event and the ambient session **finishes the lifecycle itself** — reply block + `agent:status=done` via the km tools (the event says exactly how). If the ambient session drops it, the stale-`running` sweep re-delivers after 30 min (3 attempts max, then parked as `error`). If the listener is down, mention tasks are marked `error`; query rows keep their cursor and re-fire when it's back.

**Listener auth:** loopback is not an auth boundary (any local process — or a browser page POSTing at `127.0.0.1` — could otherwise inject prompts into a write-capable session). Requests must carry `x-km-channel-secret` from `~/.config/knowledge-medium/agent-dispatch-channel.secret` (0600, auto-generated; the daemon sends it automatically) and be `application/json` with no `Origin` header.

Caveats, honestly: research preview (flag syntax/protocol may change — nothing load-bearing depends on it here); one shared context across all events vs per-thread isolation (no `--resume` threading in this mode); events only arrive while the session is open. Per-task spawn remains the default and the recommendation.

## Troubleshooting

- Waiting on `bridge/pairing` in the log → the daemon auto-starts the bridge and retries forever (reboot-safe); if it never pairs, run `yarn agent --profile agent-dispatch connect` with the app tab open.
- Config errors exit **0** (clean) so launchd doesn't hot-loop a restart that can't help — fix the config, then `launchctl kickstart -k gui/$(id -u)/org.knowledge-medium.agent-dispatch`.
- `Another km-agent-dispatch is already running` → the pidfile guard; stop the launchd instance before running one by hand (`launchctl bootout gui/$(id -u)/org.knowledge-medium.agent-dispatch`).
- `Page "claude" does not exist` → create the page (type `[[claude]]`, click it).
- Daemon logs `no app tab connected` → watchers idle until a paired tab appears; they catch up on the next tick.
- Runs fail instantly with auth errors → check `claude login` state on this machine and that nothing exports `ANTHROPIC_API_KEY` into launchd's environment (the daemon scrubs its children, but `claude` itself must be logged in).
- Known limitation: if the daemon is SIGKILLed mid-run, the spawned `claude` child survives un-timed; its reply is lost and the task re-queues after the 30-min sweep (bounded by the 3-attempt cap).
