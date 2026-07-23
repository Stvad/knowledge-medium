# @knowledge-medium/agent-cli

`kmagent` — CLI + local HTTP bridge for driving the [Knowledge Medium](https://github.com/stvad/knowledge-medium) app from an agent (Claude, Codex, your own scripts, anything that can spawn a child process).

Pairs once with a browser tab over a localhost relay, then forwards JSON commands to a long-poll loop inside the app. The CLI is the agent-facing surface; the bridge is the loopback HTTP server that brokers the connection. The package also ships `km-mcp`, a generic graph MCP server backed by the same bridge.

## Install

```bash
# Global — `kmagent` ends up on your PATH:
npm install -g @knowledge-medium/agent-cli

# Or per-project, then invoke via npx:
npm install --save-dev @knowledge-medium/agent-cli
npx kmagent ping

# Or run the package directly:
npx @knowledge-medium/agent-cli ping
```

Requires Node ≥ 24.

## Quick start

```bash
# 1. Open the app (https://stvad.github.io/knowledge-medium/ by default;
#    set AGENT_RUNTIME_APP_URL to point at your own deploy).
# 2. Pair the CLI with the app. The first command prints a URL; open it,
#    generate a token in the in-app dialog, paste the token back.
kmagent connect

# 3. Test the connection.
kmagent ping
```

After step 2, the token is saved at `~/.config/knowledge-medium/agent-token.json` and reused for every subsequent invocation.

## What you can do

The CLI exposes both *local* commands (pairing, profile management) and *bridge* commands (forwarded to the running app):

| Command | Purpose |
| --- | --- |
| `kmagent connect [token]` | Pair the CLI with the app (or save a token directly). |
| `kmagent disconnect` | Remove the current profile's token. |
| `kmagent profiles` | List saved CLI token profiles. |
| `kmagent ping` | Ping the bridge + runtime; print a status summary. |
| `kmagent status` | Show bridge status (clients, commands). |
| `kmagent runtime-summary` | Compact agent-oriented runtime context. |
| `kmagent health` | Sync-health snapshot: block vs blocks_synced counts, upload queue, materialization backlog. |
| `kmagent describe-runtime` | Full or targeted runtime diagnostics (`--guide <id>`, `--storage`, …). |
| `kmagent sql <mode> <sql> [paramsJson] [--allow-synced-write]` | Run SQL (mode: `all\|get\|optional\|execute`). Refuses a raw write to a synced table (`blocks`, `workspaces`, `workspace_members`) unless `--allow-synced-write` is passed — see note below. |
| `kmagent get-block <id>` | Fetch a block. |
| `kmagent subtree <rootId> [--json]` | Fetch a subtree as a depth-indented outline (`--json` for the raw flat array). |
| `kmagent create-block <json>` | Create a block from a JSON body. |
| `kmagent update-block <json>` | Update a block from a JSON body. |
| `kmagent move-block <json>` | Move a block to a parent/position from a JSON body. |
| `kmagent delete-block <id>` | Soft-delete a block and its descendants. |
| `kmagent restore-block <id>` | Restore one soft-deleted block; descendants stay deleted unless restored separately. |
| `kmagent install-extension <file> [label]` | Install a JS extension; `--verify` reports what it contributed. |
| `kmagent enable-extension <handle>` | Enable / `disable-extension`, `uninstall-extension`. |
| `kmagent run-action <id> [depsJson]` | Run a registered action by id. |
| `kmagent eval [--raw] [--file <path>] [--data <path> \| --data-json <json>] <code>` | Run JS in the app (use `return …` to print a value). See [Eval execution scope](#eval-execution-scope) for the bindings available inside the code. |
| `kmagent reload` | Hard-reload the app tab and wait for it to reconnect. |
| `kmagent navigate <hash>` | Set `window.location.hash`. |
| `kmagent types [outDir]` | Write compiled declarations for Knowledge Medium `@/` modules; `--module <spec>` prints one declaration. |
| `kmagent raw <json>` | Send an arbitrary JSON command envelope to the bridge. |

Run `kmagent <command> --help` for per-command details or `kmagent --help` for the full menu.

**`kmagent sql` and synced tables:** a raw `INSERT`/`UPDATE`/`DELETE` against `blocks`, `workspaces`, or `workspace_members` bypasses `repo.tx` — it leaves `tx_context.source = NULL` (the row never uploads to the server or other clients) and skips the kernel's post-commit derivations (block_types, reference normalization, property projection), so derived state goes stale. `kmagent sql` refuses such writes by default and names the offending table in the error. Prefer `create-block` / `update-block` / `run-action` (all go through `repo.tx`) for a normal write. If you genuinely need a raw statement against one of these tables, pass `--allow-synced-write` (or `{allowSyncedWrite: true}` on a `kmagent raw` body) to opt in for that one call.

## MCP Server

`km-mcp` exposes the graph-safe subset of bridge operations as MCP tools: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query`, `create_block`, `update_block`, `move_block`, `delete_block`, and `restore_block`. It deliberately excludes eval, SQL execute, and extension lifecycle commands.

```json
{
  "mcpServers": {
    "km": {
      "command": "km-mcp",
      "env": {"AGENT_RUNTIME_PROFILE": "agent-dispatch"}
    }
  }
}
```

When running from a repo checkout instead of an installed package, point at
the built entrypoint directly:

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

`km-mcp` is generic graph access. Dispatch-specific loop-prevention policy, including blocked watcher-target wikilinks, lives in the `agent-dispatch` MCP wrapper.

## Eval execution scope

`kmagent eval` runs your code inside the app tab, with the runtime context already destructured into the local scope. You do **not** need to dig values out of `window.__omniliner` — the following names are bound for you:

| Name | What it is |
| --- | --- |
| `repo` | The live `Repo` (workspace, user, mutate, query, tx, …). |
| `db` | `repo.db` — the underlying database handle. |
| `runtime` | The `FacetRuntime`. Prefer `describe-runtime` over reading internal caches. |
| `safeMode` | `true` when the runtime is paused for safe-mode boot. |
| `sql(sql, params?, mode?, allowSyncedWrite?)` | Thin SQL helper, matches `kmagent sql` — including its refusal of raw writes to synced tables (see the note above `kmagent sql`) unless `allowSyncedWrite` is `true`. |
| `block(id)` / `getBlock(id)` / `getSubtree(rootId)` | Block accessors. |
| `createBlock(input)` / `updateBlock(input)` / `moveBlock(input)` / `deleteBlock(input)` / `restoreBlock(input)` | Block mutators (same shape as the wire commands; restore is one block only). |
| `installExtension(input)` / `setExtensionEnabled(input)` / `uninstallExtension(input)` | Extension lifecycle. |
| `actions`, `renderers` | Registered actions and block renderers. |
| `refreshAppRuntime` | Re-run runtime registration (rarely needed). |
| `React`, `ReactDOM`, `window`, `document` | The app's React + DOM. |
| `data` | Parsed value from `--data <path>` / `--data-json <json>`, or `undefined` when neither flag was passed. |

Use `return …` to print a value back to the CLI (anything else is silently discarded).

### Passing structured input

For one-off scripts that need a chunk of structured input, the `--data` flag is cleaner than template-embedding JSON in the code string:

```bash
# Apply logic in one file, input in a sibling JSON file:
kmagent eval --file apply.js --data plans.json

# Or inline for small payloads:
kmagent eval --data-json '{"x":1}' 'return data.x'
```

`--data` reads JSON from a file and parses it; `--data-json` parses the inline argument directly. The parsed value is bound as `data` in the eval scope. The two flags are mutually exclusive.

## Profiles

If you connect to multiple browser profiles or workspaces, name each pairing:

```bash
kmagent --profile chrome-dev connect
kmagent --profile firefox-main connect

# Use one explicitly:
kmagent --profile chrome-dev ping

# Or set the default profile for a shell:
export AGENT_RUNTIME_PROFILE=chrome-dev
```

## Type-vending for extension authors

When you're authoring an extension that imports from Knowledge Medium modules (`@/extensions/core.js`, `@/data/api/index.js`, `@/components/ui/button.js`, etc.), `kmagent types` writes the app's compiled TypeScript declaration tree so type-aware editors resolve those imports with real signatures:

```bash
kmagent types agent-extensions/kernel-types
```

This directory form is the setup path for editors and typecheckers. It copies the published CLI's `dist/kernel-types` snapshot, so it reflects the app source at the time that CLI package was built.

The command prints the `compilerOptions.paths` mapping to add to your extension-authoring `tsconfig.json`, usually:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["agent-extensions/kernel-types/src/*"]
    }
  }
}
```

Re-run with `--force` after updating the app or CLI.

For quick inspection, print one compiled module declaration to stdout:

```bash
kmagent types --module '@/data/api/index.js'
kmagent types --module '@/data/api'
```

Single-module output is not bundled with its transitive dependencies; use the directory form above for editor/typechecker setup.

## Environment

| Variable | Purpose |
| --- | --- |
| `AGENT_RUNTIME_APP_URL` | App URL to pair with. Defaults to the canonical deploy. |
| `AGENT_RUNTIME_URL` | Bridge URL the CLI talks to. Defaults to `http://127.0.0.1:8787`. |
| `AGENT_RUNTIME_TOKEN` | One-shot token, skips the persisted profile lookup. |
| `AGENT_RUNTIME_PROFILE` | Default profile selection for `kmagent <command>`. |
| `AGENT_RUNTIME_CONFIG_DIR` | Override the config directory (default: `$XDG_CONFIG_HOME/knowledge-medium`). |
| `AGENT_RUNTIME_BRIDGE_SECRET` | Override the bridge secret (otherwise auto-generated per machine). |
| `AGENT_RUNTIME_ALLOWED_ORIGINS` | Comma-separated extra origins the bridge will accept connections from. |

## License

MIT
