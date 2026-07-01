#!/usr/bin/env node
/**
 * km-claude-daemon — polls the live client through the kmagent bridge,
 * turns new [[claude]]-style backlinks and query changes into Claude
 * Code runs, and threads replies back into the graph.
 *
 * Requires: an open app tab paired with the bridge (kmagent connect,
 * dedicated profile) and a `claude login`-authenticated machine.
 * Usage: km-claude-daemon [--config <path>] [--once]
 *
 * Exit discipline (launchd KeepAlive.SuccessfulExit=false restarts on
 * NON-zero exit only): config errors exit 0 — restarting won't fix a
 * bad config, so don't hot-loop; fix it and `launchctl kickstart`.
 * A missing bridge/tab does NOT exit at all — the daemon waits and
 * retries, so it survives reboots and app restarts.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridgeClient, errorMessage, sleep } from '@knowledge-medium/agent-cli/client'
import { agentRuntimeConfigDir, bridgeLogPath, isErrnoException } from '@knowledge-medium/agent-cli/config'
import { defaultStatePath, loadConfig, type DaemonConfig } from './config.js'
import { createGraph } from './graph.js'
import { createStateStore } from './state.js'
import { createEngine } from './engine.js'
import { runClaude } from './runner.js'
import { BLOCKED_WIKILINKS_ENV, CHANNEL_PORT_ENV, MCP_SERVER_NAME } from './mcpShared.js'
import { CHANNEL_SECRET_HEADER, loadOrCreateChannelSecret } from './channelSecret.js'

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

// ----- single-instance lock -------------------------------------------
// The claim protocol has no cross-process atomicity (plain update-block
// writes), so two daemons on one machine (launchd + a manual run) would
// double-claim and double-bill. A pidfile makes that impossible here;
// one-daemon-per-FLEET is a documented constraint (see README).

const pidfilePath = () => path.join(agentRuntimeConfigDir(), 'claude-tasks.pid')

const acquirePidfile = async (): Promise<void> => {
  const file = pidfilePath()
  try {
    const existing = Number((await fs.readFile(file, 'utf8')).trim())
    if (existing > 0) {
      try {
        process.kill(existing, 0)
        throw new Error(`Another km-claude-daemon is already running (pid ${existing}). Stop it first — two daemons double-claim tasks.`)
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ESRCH') {
          // Stale pidfile from a dead process — take over.
        } else {
          throw error
        }
      }
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
  }
  await fs.mkdir(path.dirname(file), {recursive: true})
  await fs.writeFile(file, `${process.pid}\n`)
}

const releasePidfile = async (): Promise<void> => {
  try {
    const existing = Number((await fs.readFile(pidfilePath(), 'utf8')).trim())
    if (existing === process.pid) await fs.unlink(pidfilePath())
  } catch {
    // best-effort
  }
}

// ----- bridge availability ---------------------------------------------
// Unlike the CLI, the daemon runs unattended (launchd, post-reboot), so
// it must be able to start the bridge itself — otherwise a reboot
// leaves it crash-looping until the user happens to run `yarn agent`.

const startBridge = async (): Promise<void> => {
  const serverScript = fileURLToPath(import.meta.resolve('@knowledge-medium/agent-cli/server'))
  const logPath = bridgeLogPath()
  await fs.mkdir(path.dirname(logPath), {recursive: true})
  const logFile = await fs.open(logPath, 'a')
  try {
    const child = spawn(process.execPath, [serverScript], {
      detached: true,
      env: process.env,
      stdio: ['ignore', logFile.fd, logFile.fd],
    })
    child.unref()
  } finally {
    await logFile.close()
  }
}

/** Generated --mcp-config for spawned runs: the km server, bound to the
 *  daemon's own profile, with watcher targets blocked from write-back
 *  (the MCP server resolves each name to its page's full alias set +
 *  id itself). */
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

  // Config problems exit CLEAN (0) — see exit discipline above.
  let config: DaemonConfig
  try {
    config = await loadConfig(args.config)
    if (config.watchers.length === 0) {
      throw new Error('No watchers configured — nothing to do. Add watchers to the config file.')
    }
  } catch (error) {
    process.stderr.write(`config error: ${errorMessage(error)}\nFix the config, then launchctl kickstart (or rerun) the daemon.\n`)
    process.exit(0)
  }

  await acquirePidfile()

  let stopping = false
  const stop = (signal: string) => {
    log(`${signal} received — draining in-flight runs`)
    stopping = true
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  const client = createBridgeClient({profile: config.profile, timeoutMs: 60_000})

  // Preflight: make the bridge exist, then wait for a paired tab. Never
  // exits — a reboot or closed tab is a wait, not a crash.
  let bridgeStartAttempted = false
  while (!stopping) {
    try {
      const whoami = await client.whoami()
      log(`paired as user=${whoami.audience?.userId ?? '?'} workspace=${whoami.audience?.workspaceId ?? '?'} tab-connected=${whoami.connected}`)
      if (!whoami.connected) log('WARNING: no app tab connected — watchers idle until one appears')
      break
    } catch (error) {
      if (args.once) {
        process.stderr.write(`bridge/pairing not ready: ${errorMessage(error)}\n`)
        await releasePidfile()
        process.exit(1)
      }
      if (!bridgeStartAttempted) {
        bridgeStartAttempted = true
        log(`bridge not reachable (${errorMessage(error)}) — starting it`)
        await startBridge().catch(startError => log(`bridge start failed: ${errorMessage(startError)}`))
      } else {
        log(`waiting for bridge/pairing (${errorMessage(error)}) — retrying in 30s; if never paired, run: yarn agent --profile ${config.profile} connect`)
      }
      await sleep(bridgeStartAttempted ? 30_000 : 1_000)
    }
  }

  const mcpConfigPath = await writeMcpConfig(config)
  log(`mcp config: ${mcpConfigPath}`)

  const channelSecret = config.watchers.some(watcher => watcher.delivery === 'channel')
    ? await loadOrCreateChannelSecret()
    : null

  const engine = createEngine({
    config,
    graph: createGraph(client),
    state: createStateStore(config.statePath ?? defaultStatePath()),
    runTask: options => runClaude(options),
    deliverToChannel: async event => {
      const response = await fetch(`http://127.0.0.1:${config.channelPort}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(channelSecret ? {[CHANNEL_SECRET_HEADER]: channelSecret} : {}),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        throw new Error(`channel listener replied ${response.status} — is the ambient session running? (claude --dangerously-load-development-channels server:km, ${CHANNEL_PORT_ENV}=${config.channelPort})`)
      }
    },
    mcpConfigPath,
    log,
  })

  log(`watching: ${config.watchers.map(watcher => `${watcher.name}(${watcher.kind})`).join(', ')} every ${config.pollIntervalMs}ms (max ${config.runsPerHour} runs/hour)`)

  while (!stopping) {
    await engine.tick()
    if (args.once) break
    await sleep(config.pollIntervalMs)
  }

  await engine.drain()
  await releasePidfile()
  log('stopped')
}

main().catch(async error => {
  process.stderr.write(`${errorMessage(error)}\n`)
  await releasePidfile()
  process.exit(1)
})
