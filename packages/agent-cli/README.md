# @knowledge-medium/agent-cli

`kmagent` — CLI + local HTTP bridge for driving the [Knowledge Medium](https://github.com/stvad/knowledge-medium) app from an agent (Claude, your own scripts, anything that can spawn a child process).

Pairs once with a browser tab over a localhost relay, then forwards JSON commands to a long-poll loop inside the app. The CLI is the agent-facing surface; the bridge is the loopback HTTP server that brokers the connection.

## Install

```bash
# Global — `kmagent` ends up on your PATH:
npm install -g @knowledge-medium/agent-cli

# Or per-project, then invoke via npx:
npm install --save-dev @knowledge-medium/agent-cli
npx kmagent ping
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
| `kmagent describe-runtime` | Full or targeted runtime diagnostics (`--guide <id>`, `--storage`, …). |
| `kmagent sql <mode> <sql> [paramsJson]` | Run SQL (mode: `all\|get\|optional\|execute`). |
| `kmagent get-block <id>` | Fetch a block. |
| `kmagent subtree <rootId> [--include-root]` | Fetch a subtree. |
| `kmagent create-block <json>` | Create a block from a JSON body. |
| `kmagent update-block <json>` | Update a block from a JSON body. |
| `kmagent install-extension <file> [label]` | Install a JS extension; `--verify` reports what it contributed. |
| `kmagent enable-extension <handle>` | Enable / `disable-extension`, `uninstall-extension`. |
| `kmagent run-action <id> [depsJson]` | Run a registered action by id. |
| `kmagent eval [--raw] [--file <path>] <code>` | Run JS in the app (use `return …` to print a value). |
| `kmagent reload` | Hard-reload the app tab and wait for it to reconnect. |
| `kmagent navigate <hash>` | Set `window.location.hash`. |
| `kmagent types [outDir]` | Write compiled declarations for Knowledge Medium `@/` modules (see *Type-vending* below). |
| `kmagent raw <json>` | Send an arbitrary JSON command envelope to the bridge. |

Run `kmagent <command> --help` for per-command details or `kmagent --help` for the full menu.

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

When you're authoring an extension that imports from Knowledge Medium modules (`@/extensions/api.js`, `@/data/api`, `@/components/ui/button.js`, etc.), `kmagent types` writes the app's compiled TypeScript declaration tree so type-aware editors resolve those imports with real signatures:

```bash
kmagent types agent-extensions/kernel-types
```

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

For quick inspection, print one compiled declaration to stdout:

```bash
kmagent types --module '@/extensions/api.js'
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
