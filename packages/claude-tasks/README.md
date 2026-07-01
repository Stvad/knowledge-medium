# @knowledge-medium/claude-tasks

Trigger Claude Code from your notes. Write `[[claude]] summarize the meeting notes below` in any block and a full-harness `claude` run picks it up, works against the live graph through MCP tools, and threads its reply back as a child block. Watchers generalize the same loop to *any* page's new backlinks and to arbitrary SQL query changes.

```
┌─ app tab (live client, decrypted) ─┐        ┌─ km-claude-daemon (launchd) ─────────┐
│  you type: [[claude]] do X         │        │ poll: backlinks/sql via the bridge   │
│  reply appears as a child block ◀──┼─bridge─┼─▶ claim: claude:status=running       │
└────────────────────────────────────┘        │ spawn: claude -p (subscription,      │
                                              │   --mcp-config → km graph tools)     │
                                              │ write: reply block + status=done     │
                                              └──────────────────────────────────────┘
```

Design notes: task state lives **in the graph** (`claude:*` block properties), so the daemon is stateless for mention watchers — restart-safe, multi-device-safe (a mention synced from your iPad triggers once the Mac client sees it). The bridge requires a live app tab; no tab → watchers idle.

## Billing invariant (subscription, not API)

Runs execute via `claude -p` on a machine authenticated with `claude login`. The daemon **scrubs `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from every child environment** — either var would silently flip billing to the API. Nothing here touches the Agent SDK (API-key-only by policy).

## Setup

1. **Pair a dedicated bridge profile** (revocable independently of your interactive one) with a **read-write** token:

   ```bash
   yarn agent --profile claude-tasks connect
   ```

2. **Create the config** at `~/.config/knowledge-medium/claude-tasks.json`:

   ```jsonc
   {
     "profile": "claude-tasks",
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
         "sql": "SELECT id, content FROM blocks WHERE json_extract(properties_json, '$.\"action:status\"') = 'open'",
         "prompt": "New open action items appeared:\n{{newRows}}\nTriage them: add a priority property to each via update_block."
       }
     ]
   }
   ```

   The `claude` page must exist (type `[[claude]]` once and click it).

3. **Build + run once by hand:**

   ```bash
   yarn run compile
   node packages/claude-tasks/dist/daemon.js --once   # or: yarn claude-daemon
   ```

4. **Install under launchd** (keeps it running, restarts on crash):

   ```bash
   sed -e "s|__NODE__|$(command -v node)|g" -e "s|__REPO__|$(pwd)|g" -e "s|__HOME__|$HOME|g" \
     packages/claude-tasks/launchd/org.knowledge-medium.claude-tasks.plist \
     > ~/Library/LaunchAgents/org.knowledge-medium.claude-tasks.plist
   launchctl load ~/Library/LaunchAgents/org.knowledge-medium.claude-tasks.plist
   tail -f ~/Library/Logs/km-claude-daemon.log
   ```

## How a mention task runs

1. Watcher sees a new backlink to `target` whose source block has no `claude:status` property (one batched SQL per tick — processed mentions stay cheap forever).
2. Claim: `claude:status=running` + `claude:watcher` + `claude:updated-at` written to the block.
3. Prompt = mention content + full subtree outline + ancestor path (`prompt.ts` template, overridable per watcher).
4. `claude -p` runs with the **km MCP graph tools only** (fail-closed `--allowedTools`; add e.g. `"Bash(git:*)"` per watcher to opt into more). `cwd` defaults to `$HOME`.
5. Reply text lands as a child block (marked `claude:reply` so it can never re-trigger), status flips to `done`, and the session id is stored as `claude:session`.
6. **Threads:** a later `[[claude]]` mention anywhere under that block finds the nearest ancestor `claude:session` and `--resume`s it — one conversation per thread, Claude-Tag-style.

Failures reply visibly (`⚠️ claude-tasks run failed — …`) and set `claude:status=error` + `claude:error`. A `running` block older than 30 min is treated as a crashed run and re-queued. To re-run a mention manually, delete its `claude:*` properties.

### Loop guards

- Replies carry `claude:reply` and are skipped, as is anything nested under one.
- The default prompt forbids writing `[[claude]]`, and the MCP write tools **refuse** content containing any watcher-target wikilink (`KM_MCP_BLOCKED_WIKILINKS`, set automatically from your config).

## Query watchers

Rows must select a stable `id` column. First tick establishes a baseline without firing (no backlog replay); afterwards, new ids fire one batched run. Cursors live in `~/.config/knowledge-medium/claude-tasks-state.json`; the cursor advances **before** the run so a failing prompt can't re-bill every tick (failures are logged, not retried).

## km MCP server standalone

The same graph tools work from any MCP client — e.g. Claude Desktop / interactive Claude Code:

```json
{
  "mcpServers": {
    "km": {
      "command": "node",
      "args": ["<repo>/packages/claude-tasks/dist/mcp.js"],
      "env": {"AGENT_RUNTIME_PROFILE": "claude-tasks"}
    }
  }
}
```

Tools: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query` (read-only, enforced), `create_block`, `update_block`. Deliberately excluded: `eval`, `sql execute`, extension lifecycle.

## Security posture

- The daemon's bridge token is scoped to its own profile — revoke it in the app's token dialog to kill all graph access at once.
- Spawned runs get **no Bash and no filesystem tools by default**; graph MCP tools only. Watchers that operate on code repos must opt in via `allowedTools` + `cwd`, which is a deliberate, per-watcher decision.
- No `--dangerously-skip-permissions` anywhere; print mode denies anything outside the allowlist.

## Ambient mode via channels (EXPERIMENTAL)

Claude Code's channels primitive (research preview, v2.1.80+) can push watcher events into one *persistent* session instead of spawning a run per task — the Claude-Tag "always listening" feel. The km MCP server implements the emitter; it's off unless all three pieces are opted in:

1. Register km in the project's `.mcp.json` with the channel port:

   ```json
   {"mcpServers": {"km": {"command": "node", "args": ["<repo>/packages/claude-tasks/dist/mcp.js"], "env": {"AGENT_RUNTIME_PROFILE": "claude-tasks", "KM_MCP_CHANNEL_PORT": "8790"}}}}
   ```

2. Run the ambient session (custom channels aren't on the preview allowlist, hence the dev flag):

   ```bash
   claude --dangerously-load-development-channels server:km
   ```

3. Mark watchers `"delivery": "channel"` in the daemon config.

The daemon then claims the task (`claude:status=running`) and POSTs the rendered event to `127.0.0.1:8790`; it arrives as a `<channel source="km">` event and the ambient session **finishes the lifecycle itself** — reply block + `claude:status=done` via the km tools (the event says exactly how). If the ambient session drops it, the stale-`running` sweep re-delivers after 30 min. If the listener is down, the task is marked `error`.

Caveats, honestly: research preview (flag syntax/protocol may change — nothing load-bearing depends on it here); one shared context across all events vs per-thread isolation (no `--resume` threading in this mode); events only arrive while the session is open. Per-task spawn remains the default and the recommendation.

## Troubleshooting

- `Bridge not reachable or profile not paired` → open the app tab, `yarn agent --profile claude-tasks connect`.
- `Watcher target page "claude" does not exist` → create the page (type `[[claude]]`, click it).
- Daemon logs `no app tab connected` → watchers idle until a paired tab appears; they catch up on the next tick.
- Runs fail instantly with auth errors → check `claude login` state on this machine and that nothing exports `ANTHROPIC_API_KEY` into launchd's environment (the daemon scrubs its children, but `claude` itself must be logged in).
