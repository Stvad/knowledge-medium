#!/usr/bin/env node
/**
 * km-claude-daemon — polls the live client through the kmagent bridge,
 * turns new [[claude]]-style backlinks and query changes into Claude
 * Code runs, and threads replies back into the graph.
 *
 * Requires: an open app tab paired with the bridge (kmagent connect,
 * dedicated profile) and a `claude login`-authenticated machine.
 * Usage: km-claude-daemon [--config <path>] [--once]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridgeClient, sleep } from '@knowledge-medium/agent-cli/client'
import { agentRuntimeConfigDir } from '@knowledge-medium/agent-cli/config'
import { defaultStatePath, loadConfig, type DaemonConfig } from './config.js'
import { createGraph } from './graph.js'
import { createStateStore } from './state.js'
import { createEngine } from './engine.js'
import { runClaude } from './runner.js'
import { BLOCKED_WIKILINKS_ENV, MCP_SERVER_NAME } from './mcpShared.js'

const log = (message: string) =>
  process.stdout.write(`${new Date().toISOString()} ${message}\n`)

const parseArgs = (argv: string[]) => {
  const args: {config?: string, once: boolean} = {once: false}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') args.config = argv[++i]
    else if (argv[i] === '--once') args.once = true
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  return args
}

/** Generated --mcp-config for spawned runs: the km server, bound to the
 *  daemon's own profile, with watcher targets blocked from write-back. */
const writeMcpConfig = async (config: DaemonConfig): Promise<string> => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const mcpServerScript = path.join(here, 'mcp.js')
  const blockedWikilinks = config.watchers
    .filter(watcher => watcher.kind === 'backlinks')
    .map(watcher => watcher.target)
    .join(',')

  const mcpConfig = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [mcpServerScript],
        env: {
          AGENT_RUNTIME_PROFILE: config.profile,
          ...(blockedWikilinks ? {[BLOCKED_WIKILINKS_ENV]: blockedWikilinks} : {}),
        },
      },
    },
  }

  const configPath = path.join(agentRuntimeConfigDir(), 'claude-tasks-mcp.json')
  await fs.mkdir(path.dirname(configPath), {recursive: true})
  await fs.writeFile(configPath, `${JSON.stringify(mcpConfig, null, 2)}\n`)
  return configPath
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const config = await loadConfig(args.config)
  if (config.watchers.length === 0) {
    throw new Error('No watchers configured — nothing to do. Add watchers to the config file.')
  }

  const client = createBridgeClient({profile: config.profile, timeoutMs: 60_000})
  const whoami = await client.whoami().catch(error => {
    throw new Error(
      `Bridge not reachable or profile "${config.profile}" not paired (${error instanceof Error ? error.message : error}). `
      + `Start the app tab and run: yarn agent --profile ${config.profile} connect`,
    )
  })
  log(`paired as user=${whoami.audience?.userId ?? '?'} workspace=${whoami.audience?.workspaceId ?? '?'} tab-connected=${whoami.connected}`)
  if (!whoami.connected) {
    log('WARNING: no app tab connected — watchers idle until one appears')
  }

  const mcpConfigPath = await writeMcpConfig(config)
  log(`mcp config: ${mcpConfigPath}`)

  const engine = createEngine({
    config,
    graph: createGraph(client),
    state: createStateStore(config.statePath ?? defaultStatePath()),
    runTask: options => runClaude(options),
    mcpConfigPath,
    log,
  })

  let stopping = false
  const stop = (signal: string) => {
    log(`${signal} received — draining in-flight runs`)
    stopping = true
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  log(`watching: ${config.watchers.map(watcher => `${watcher.name}(${watcher.kind})`).join(', ')} every ${config.pollIntervalMs}ms`)

  do {
    await engine.tick()
    if (args.once) break
    await sleep(config.pollIntervalMs)
  } while (!stopping)

  await engine.drain()
  log('stopped')
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
