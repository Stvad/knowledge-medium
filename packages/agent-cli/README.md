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

## When the app cannot reach the bridge

The app tab's console prints an unavailable reason after six failed attempts,
when the loop starts retrying quietly every 60 seconds. The reason names the
request (`registration`, `poll`, or `result`) and error kind; unchanged reasons
are logged once until reconnection.

From that tab's DevTools console, run `fetch('<bridge url>/health')` with the
bridge URL the CLI uses (`AGENT_RUNTIME_URL`, default `http://127.0.0.1:8787`).
If `kmagent status` can reach the same bridge but this fetch rejects from the
hosted HTTPS origin,
check Chrome's site permissions for
[local network access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access).

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
| `kmagent health` | Sync-health snapshot: block vs blocks_synced counts, upload queue, materialization backlog, and per-workspace `syncDivergence` — downloaded rows `blocks` does not hold with nothing in flight, including stranded ones no flag reports (remedy: `rematerialize-workspace --scope all`, unless the entry is already `rematerializing` or its `materializability` is `defer`). |
| `kmagent describe-runtime` | Full or targeted runtime diagnostics (`--guide <id>`, `--storage`, …). |
| `kmagent sql <mode> <sql> [paramsJson] [--allow-synced-write]` | Run SQL (mode: `all\|get\|optional\|execute`). Refuses a raw write to a synced table (`blocks`, `workspaces`, `workspace_members`) unless `--allow-synced-write` is passed — see note below. |
| `kmagent get-block <ref>` | Read one block: content, breadcrumb, types, decoded properties, child/backlink counts. |
| `kmagent subtree <ref> [--depth <n>] [--limit <n>] [--offset <n>] [--properties brief\|none\|full] [--expand-collapsed]` | Read a block and its descendants as a bounded markdown outline. |
| `kmagent backlinks <ref> [--limit <n>] [--offset <n>] [--filter …]` | Blocks that reference a block or page, a page at a time. |
| `kmagent grouped-backlinks <ref> [--limit <n>] [--members-per-group <n>] [--filter …] [--grouping …]` | The grouped-references view of a block. |
| `kmagent search <query> [--limit <n>] [--offset <n>] [--types <t>]… [--under <ref>] [--include-extensions]` | Full-text search with snippet, breadcrumb and types per hit. Repeat `--types` for several (a value is taken whole, commas included). |
| `kmagent page <name>` / `kmagent daily-note <date>` | Resolve a page by name/alias, or a date to its daily note. |
| `kmagent data-model [<topic id>\|all]` (alias `guide`) | The agent-facing data-model guide: a short index of its topics by default, one section with a topic id (`data-model pages`, or `--topic pages`), all of it with `all`. |
| `kmagent comments (--scope <ref> \| --block <ref> \| --thread <id>) [--include-closed]` | Comment threads as JSON: each thread's status, anchor, quote, target and its comments nested as replied, with their authors. Open threads only unless `--include-closed`. See `data-model comments`. |
| `kmagent create-block <json>` | Create one block: `{parentId, content, properties?, position?}`. `parentId` is a write target (see Writing); absent or `null` makes a top-level block, which is not a page — use `create-page`. |
| `kmagent update-block <json>` | Update a block from a JSON body. |
| `kmagent move-block <json>` | Move a block to a parent/position from a JSON body. |
| `kmagent delete-block <id>` | Soft-delete a block and its descendants. |
| `kmagent restore-block <id>` | Restore one soft-deleted block; descendants stay deleted unless restored separately. |
| `kmagent append-markdown <target> -- '<markdown>'` (or markdown on stdin) | Split markdown into blocks the way "paste as markdown" does and insert them under a target in one transaction (`--first`, `--after <id>`, `--before <id>`, `--one-block`). See [Writing](#writing). |
| `kmagent edit-block <id> <old> <new>` | Replace the one occurrence of `<old>` in a block, against its content at write time. |
| `kmagent add-comment '<json>'` | Start a comment thread from `{target, quote?, occurrence?, content?}`: on quoted text of the block, or on the whole block; no `content` makes a highlight. Prints the thread root's id. Reply with `append-markdown` under the comment being answered. |
| `kmagent create-page <name> \| --date <expr>` | Get-or-create a page (as `[[name]]` would) or a daily note. |
| `kmagent recent-changes [--since <t>] [--all]` | Recent agent-bridge transactions and the blocks each changed (`--all` adds your own edits). |
| `kmagent block-history <id>` | One block's recorded changes with prior content (cut past 2,000 chars) — local and synced. |
| `kmagent new-extension <name> [dir]` | Scaffold a standalone extension project (deps, gate, `@/` declarations included) in the shape the `record-grain` guide describes. |
| `kmagent install-extension <file> [label]` | Install a JS extension; reports its run state — `running` is approved AND enabled on this device, not proof the source loaded. An install that makes the source live also runs it and reports load errors; one onto a block that is not live runs nothing, and `--verify` checks it anyway, reporting what it contributed plus data-model lint warnings. |
| `kmagent enable-extension <handle>` | Enable / `disable-extension`, `uninstall-extension`. |
| `kmagent audit-extension <handle>` | Audit the data an extension wrote: block ids in non-ref properties, records buried in JSON cells, properties with no registered schema, declared types nothing carries. |
| `kmagent audit-properties [--workspace <id>]` | Every property key in the workspace's data the registry does not resolve — the keys property migration skips silently. Per key: exact cell count, why it doesn't resolve, the fix — plus sampled blocks and the types they carry. Past the flip, also `coverage`: registered cells with no property blocks, and what re-running the migration would write. Active workspace only; refuses rather than mis-reporting. |
| `kmagent rematerialize-workspace [--scope unapplied\|all]` | Re-run the sync drain over rows this device downloaded but never applied — the remedy when a one-way pass refuses with "N synced row(s) … have not reached `blocks` on this device". That gap is durable — the rows were downloaded and their queue entries consumed — so waiting never clears it. Local-only and idempotent: uploads nothing, clears no undo history, safe to re-run. `--scope all` covers every staged row, when the unapplied flag itself is suspect. Rows it leaves unapplied are explained by its `deferred` / `quarantined` counts; re-running alone fixes neither, except a deferral from a transient key-store failure. |
| `kmagent run-action <id> [depsJson]` | Run a registered action by id. |
| `kmagent eval [--raw] [--file <path>] [--data <path> \| --data-json <json>] <code>` | Run JS in the app (use `return …` to print a value). See [Eval execution scope](#eval-execution-scope) for the bindings available inside the code. |
| `kmagent reload` | Hard-reload the app tab and wait for it to reconnect. |
| `kmagent navigate <hash>` | Set `window.location.hash`. |
| `kmagent types [outDir]` | Write compiled declarations for Knowledge Medium `@/` modules; `--module <spec>` prints one declaration. |
| `kmagent raw <json>` | Send an arbitrary JSON command envelope to the bridge. |

`get-block`, `subtree`, `backlinks`, `grouped-backlinks` (and `search --under`) take a block `<ref>`: a full id, a unique id prefix as printed (`^3f2a9c1d`), a page name, or a date (`today`, `yesterday`, `2026-06-18`) for that day's daily note. The read verbs' output is bounded text by default (truncation is marked, and a cut-off list says where to continue). `--json` prints the same bounded view as structured JSON; `--raw` sends the stored, unbounded command instead (`get-block`, `subtree`, `backlinks`, `grouped-backlinks`) and prints its JSON; the stored `search` (whole rows) is `kmagent raw '{"type":"search",…}'`. Each takes `--workspace <id>` (see [Workspaces](#workspaces)).

Run `kmagent <command> --help` for per-command details or `kmagent --help` for the full menu.

**`kmagent sql` and synced tables:** a raw `INSERT`/`UPDATE`/`DELETE` against `blocks`, `workspaces`, or `workspace_members` bypasses `repo.tx` — it leaves `tx_context.source = NULL` (the row never uploads to the server or other clients), skips contributor selection and attribution, and skips the kernel's post-commit derivations (block_types, reference normalization, property projection), so derived state goes stale. `kmagent sql` refuses such writes by default and names the offending table in the error. Prefer `create-block` / `update-block` (which go through `repo.tx`) for a normal write. If you genuinely need a raw statement against one of these tables, pass `--allow-synced-write` (or `{allowSyncedWrite: true}` on a `kmagent raw` body) to opt in for that one call.

## Writing

Writes are markdown-native and conflict-safe, so an agent can treat the graph like files:

- **Targets.** Write verbs take a block id or unique id prefix (`^3f2a9c1b`), a `[[Page name]]` — created when missing, exactly as typing that wikilink would (a date-literal name is that daily note) — or a date expression (`today`, `2026-10-15`, `next monday`) for that day's daily note, created when missing. Bare text is tried as an id prefix, an existing page, then a date expression, so a page name belongs in `[[…]]` — and a typo never mints a page. Id fields (`update-block`, `move-block`, …) take an id or prefix only, never a name.
- **Append.** `append-markdown` parses with the app's paste parser and inserts the whole outline in one transaction, printing the created blocks with their short ids.
- **Edit.** `edit-block` replaces one exact occurrence inside the writing transaction; `update-block` takes `expectedContent` — the block's exact content, read whole with `get-block` — and refuses the overwrite when the content is no longer that.
- **Todos.** A todo is a block with properties `{"types": ["todo"], "status": "open"}`; set `status` to `"done"` to complete it.
- **Review.** Direct graph verbs record transactions described `agent runtime <verb>`; `recent-changes` and `block-history` read them back from the local change log. Transactions opened by `eval` and explicit raw SQL writes may not carry that description.

## MCP Server

`km-mcp` exposes the graph-safe subset of bridge operations as MCP tools. Read tools: `get_block`, `subtree`, `backlinks`, `grouped_backlinks`, `search`, `page`, `daily_note`, `guide` (the data-model guide's index, or one `topic`), `comments` (comment threads of a scope, a block or one thread, as JSON) and `sql_query` (read-only, rows capped by `maxRows`). They are generated from the same table as the CLI verbs above, so their arguments match the flags and accept the same block refs. The views return bounded text (`format: "json"` for the structured view); `page` and `daily_note` are lookups that return the matched block whole. The server also sends usage instructions to the client. Write tools: `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block`, `append_markdown`, `edit_block`, `add_comment` (starts a comment thread; a reply is `append_markdown` under the comment it answers, and resolving is `update_block` on the thread root) and `create_page`, plus `recent_changes` (defaults to what changed since that MCP session started) and `block_history` to review them; their id fields take a full id or a printed `^shortid`, and a write target also a `[[Page name]]` or a date (see [Writing](#writing)). It deliberately excludes eval, SQL execute, and extension lifecycle commands.

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

## Workspaces

A token acts as the user who minted it, in any of their workspaces, not only the one open when it was minted. Every open tab of the app in the browser profile and at the app address that minted it registers it, whichever workspace the tab has open, so switching workspace does not disconnect the agent.

- **Reads take the workspace per call:** `--workspace <id>` on `get-block`, `subtree`, `backlinks`, `grouped-backlinks`, `search`, `page` and `daily-note`, and `workspaceId` on the same `km-mcp` tools. Without it they use the workspace open in the app tab. The views (`get-block`, `subtree`, `backlinks`, `grouped-backlinks`, `search`) decode values through the open workspace's registries, so they read only the workspace open in the tab serving the call: naming another one sends the call to a tab that has it open, and is refused when none does. `page`, `daily-note` and the `--raw` forms read any workspace, and `sql` sees every workspace in the tab's local database.
- **A workspace the device cannot read is refused**, not answered with empty results: one this device has no row for, or one that is end-to-end encrypted without its key entered here, or that was never opened here.
- **Writes go to the workspace open in the app tab only.** They resolve properties and aliases through that workspace's registries, so a write to a block in another workspace is refused; switch the tab to it and re-run. This is a correctness limit, not a permission boundary.
- **Several tabs of the same user:** a call that names a workspace (its `workspaceId`, or a root `create-block`'s `data.workspaceId`) goes to a tab that has it open; otherwise it goes to the tab focused most recently.
- **Pinning a workspace:** with `AGENT_RUNTIME_WORKSPACE=<id>` set, every call that names no workspace names that one, instead of acting on whichever workspace you last looked at. The `agent-dispatch` daemon pins this way from its required `workspaceId` config field.

## Profiles

A token lives in the browser profile (and app origin) that minted it. If you connect to more than one, name each pairing:

```bash
kmagent --profile chrome-dev connect
kmagent --profile firefox-main connect

# Use one explicitly:
kmagent --profile chrome-dev ping

# Or set the default profile for a shell:
export AGENT_RUNTIME_PROFILE=chrome-dev
```

A local dev server is its own origin, so it needs its own pairing and its own profile — point `AGENT_RUNTIME_APP_URL` at it when connecting:

```bash
AGENT_RUNTIME_APP_URL=http://localhost:<port>/ kmagent --profile localdev-<port> connect
```

Only `connect` / `pair-url` read `AGENT_RUNTIME_APP_URL` (it decides which URL is printed); later commands use the saved token. Loopback origins are always accepted by the bridge, so no `AGENT_RUNTIME_ALLOWED_ORIGINS` is needed.

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

## React in extensions

`react` and `react-dom` are **host-provided peer dependencies**: an extension renders into the app's React tree, so it must run on the app's copy of React. A second copy fails with "Invalid hook call" and a context the host's components never see.

- **Imports.** Write `import {useState} from 'react'` and `import {createRoot} from 'react-dom/client'`. The page import map resolves `react`, `react-dom` and every subpath they export for a browser (`react/jsx-runtime`, `react-dom/client`, `react-dom/server`, `react-dom/static`, …) to same-origin modules that re-export the app's own copy, so the extension gets the same instances the app uses. Not mapped: the `.node` and `.bun` server builds, which need Node built-ins, and `react-dom/profiling`.
- **JSX.** The app's in-browser compiler uses the automatic JSX runtime: JSX becomes an import from `react/jsx-runtime`, which the import map resolves to the host's. No `import React` is needed, and the app sets no `React` / `ReactDOM` global, so import whatever you use. JSX no longer calls a local `React` binding, and a `/** @jsx */` or `/** @jsxFrag */` pragma fails to compile unless the file also says `/** @jsxRuntime classic */`.
- **Bundled extensions** (`kmagent new-extension`) keep `react`, `react/*`, `react-dom`, `react-dom/*` and every `@/…` module external, and compile JSX with the automatic runtime (`@vitejs/plugin-react` does by default) so the bundle imports `react/jsx-runtime` instead of carrying a factory of its own. The `react` / `react-dom` entries in the scaffold's `devDependencies` supply types and the test environment only; they are never bundled.

## Preset-change refusals on install

`kmagent install-extension` REFUSES when it changes which codec a value preset id resolves to on that device. That happens in two ways:

- a core the extension registers builds a different codec than the one live under that id (its own previous version, another plugin's core, or a kernel one);
- the update DROPS an id it currently registers, which falls the id back to whatever was underneath, or to nothing.

Either way every value stored under the preset is re-typed with no definition row edited, so nothing migrates it. The refusal names what moved and the definitions and cell counts at stake.

- **Fix:** give the new codec a NEW preset id and repoint the definitions (an edit per definition row, which `core.migratePropertyDefinition` fans out), or pass `--allow-preset-change` if the values are disposable.
- **Only while live:** the check sees the change only while the core it replaces is LIVE on this device.
- **Only when the install makes source live:** it looks only when the block passes BOTH loader gates here, approved AND enabled. Looking means EXECUTING the source, which an install deliberately does not do for source nothing will run (#67).
  - Pass `--verify` to check a block that does not pass both gates.
  - The enable that later makes it run is not covered (#1046).
- **Unreadable gates refuse:** both gates are stores that can fail to READ, and a failed read is not a "no". When the block IS approved here (or under `--verify`), an install that cannot read the approval record or the override map REFUSES rather than skipping the check, because skipping it would also re-pin the source it skipped. Retry, or pass the flag.
- **Re-pinning:** an install re-pins this device's approval ONLY on the path that ran the check. An install onto a block that is disabled here, or one made in SAFE MODE (where no extension contributes anything and there is no live core to compare), stores the source without pinning it and reports `running: false`.
- **`enable-extension` is the uncovered path:** it re-approves unconditionally, so install-then-enable still ships an update. That enable is now the only way unchecked source goes live.
- **Type-string changes:** a codec that changes what it PARSES under an unchanged `type` string is invisible to this check, exactly as it is to the seed ledger. Bump the type string when the encoding moves.

## Upgrading

The bridge is a background process that keeps running after the CLI that started it is upgraded, and it reports no version, so the CLI cannot tell it is old ([#1247](https://github.com/Stvad/knowledge-medium/issues/1247)). When a release changes the bridge, stop it once; the next `kmagent` command, or the `agent-dispatch` daemon, starts the new one:

```bash
kill $(lsof -t -iTCP:8787 -sTCP:LISTEN)
```

Use the port from `AGENT_RUNTIME_URL` if you set one. Restart MCP clients that launch `km-mcp` too; an `npx` launch can reuse a cached copy, so name the version to be sure (`npx -y -p @knowledge-medium/agent-cli@0.9.0 km-mcp`).

### Upgrade to 0.9.0

0.9.0 adds comment threads: the `comments` read tool and verb, and the `add_comment` write tool with its `kmagent add-comment` verb. Upgrade `agent-cli`, restart the bridge using the steps above, and restart every MCP client that launches `km-mcp`. Restart the bridge even if you only read: it classifies verbs by its own copy of the command list, so a bridge older than 0.9.0 treats `comments` as a write and refuses it to a read-only token (read-write tokens are unaffected). Both tools need an app build that has the `comments` and `add-comment` verbs; an older app tab fails them with `Invalid command body`.

### Upgrade to 0.8.0

External document edits through graph commands or normal Repo transactions now require a page-backed contributor choice for each CLI profile and workspace. Upgrade `agent-cli`, restart the bridge using the steps above, and restart every MCP client that launches `km-mcp`. Select an agent or automation profile with `kmagent contributor use <id>` (or create one with `contributor create`); run `contributor use none` to explicitly opt out and send null attribution. Until a choice is saved, meaningful document edits fail with setup instructions. MCP clients can instead set `AGENT_RUNTIME_CONTRIBUTOR_ID=<id|none>` or launch `km-mcp --contributor <id|none>`; restart the MCP client after changing the setting.

## Contributors

Contributor support attributes document edits to page-backed profiles. Choose a profile before writing; creation selects it for the current CLI profile and workspace:

```bash
kmagent contributor create "Research assistant" --kind agent --role "Research"
kmagent contributor list
kmagent contributor use <id>   # or: kmagent contributor use none
```

Contributor choices are stored separately in one file per token profile and workspace under `agent-contributors/`. For CLI writes, `--contributor <id|none>` overrides `AGENT_RUNTIME_CONTRIBUTOR_ID`, which overrides the saved choice; an empty environment value leaves the saved choice in effect. An unconfigured selection is sent as no field; meaningful external document edits then fail with setup instructions, while reads, watcher setup and derived maintenance remain available. `none` sends explicit null and records an intentionally unattributed write. External writers can select agent or automation profiles; human profiles are reserved for human edits.

Attribution covers normal `BlockDefault` document transactions. Undo/redo restores the recorded contributor lists exactly; UI state, preferences, automation records and reference maintenance stay quiet without requiring selection. Trusted `eval` retains explicit `repo.withTxContext(...)` rebinding for imports and direct `db` / `repo.db` access; raw database writes, including SQL with `--allow-synced-write`, bypass Repo attribution.

`run-action` (and its raw `action` alias) refuses dispatch while Contributors is enabled: UI action handlers and middleware can retain repositories outside the command context. Use graph commands or `eval` with its supplied `repo` for attributed work.

`contributor create --kind human` creates a profile for a person without selecting it; the current agent selection stays in place.

Older CLI/MCP versions without contributor support must be upgraded before making attributed writes. Use this checkout's `pnpm agent` when the needed CLI version has not been published yet.

For MCP, `list_contributors` and `create_contributor` work before attribution is configured. They do not change the MCP server's selection. Set `AGENT_RUNTIME_CONTRIBUTOR_ID=<id|none>` or launch `km-mcp --contributor <id|none>` to attribute writes. Programmatic clients can pass `contributorId` to `createBridgeClient` or `GraphMcpServerOptions`; `null` opts out explicitly, while `undefined` leaves the choice unconfigured.

### 0.7.0

- **Restart the bridge.** Tokens now belong to the user rather than the workspace they were minted in, and the bridge routes each call to a tab that has its workspace open. An old bridge keeps one tab per token, so with several tabs open in different workspaces, calls bounce between them; writes fail closed. Existing pairings keep working; no re-pairing is needed.
- **Read output changed.** `get-block`, `subtree`, `backlinks`, `grouped-backlinks` and `search`, and the `km-mcp` tools of the same names, return a bounded text view. `--json` (MCP `format: "json"`) is that view as structured data; `--raw` is the old output for all but `search`. `subtree --props` is gone; use `--properties full`.
- **MCP inputs and outputs changed.** `get_block` and `backlinks` take `ref` instead of `id`, and `subtree` takes `ref` instead of `rootId`. `sql_query` returns `{rows, truncated, truncatedCells}` instead of a bare row array, capped at 200 rows unless `maxRows` says otherwise.
- **New write tools.** `append_markdown`, `edit_block` and `create_page` (`append-markdown`, `edit-block`, `create-page` on the CLI), `expectedContent` on `update_block`, and `recent_changes` / `block_history` to review writes. An embedding that passes `km-mcp` a custom `writeGuard` should handle the three new operations.

## Environment

| Variable | Purpose |
| --- | --- |
| `AGENT_RUNTIME_APP_URL` | App URL to pair with. Defaults to the canonical deploy. |
| `AGENT_RUNTIME_URL` | Bridge URL the CLI talks to. Defaults to `http://127.0.0.1:8787`. |
| `AGENT_RUNTIME_TOKEN` | One-shot token, skips the persisted profile lookup. |
| `AGENT_RUNTIME_WORKSPACE` | Workspace id to name on every call that names none (see [Workspaces](#workspaces)). |
| `AGENT_RUNTIME_PROFILE` | Default profile selection for `kmagent <command>`. |
| `AGENT_RUNTIME_CONTRIBUTOR_ID` | Contributor id for CLI and MCP writes; `none` explicitly leaves them unattributed. |
| `AGENT_RUNTIME_CONTRIBUTOR_DIR` | Override the directory holding per-profile/workspace CLI contributor selections. |
| `AGENT_RUNTIME_CONFIG_DIR` | Override the config directory (default: `$XDG_CONFIG_HOME/knowledge-medium`). |
| `AGENT_RUNTIME_BRIDGE_SECRET` | Override the bridge secret (otherwise auto-generated per machine). |
| `AGENT_RUNTIME_ALLOWED_ORIGINS` | Comma-separated extra origins the bridge will accept connections from. |

## License

MIT
