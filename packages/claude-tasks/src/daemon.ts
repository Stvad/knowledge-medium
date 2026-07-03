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
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridgeClient, errorMessage, startBridgeInBackground } from '@knowledge-medium/agent-cli/client'
import { agentRuntimeConfigDir, bridgeUrl as resolveBridgeUrl, isLocalBridgeUrl } from '@knowledge-medium/agent-cli/config'
import { defaultStatePath, loadConfig, type DaemonConfig } from './config.js'
import { createGraph } from './graph.js'
import { createStateStore } from './state.js'
import { acquirePidfile, releasePidfile } from './pidfile.js'
import { createEngine } from './engine.js'
import { startPushLoop } from './push.js'
import { runClaude } from './runner.js'
import { BLOCKED_WIKILINKS_ENV, CHANNEL_PORT_ENV, encodeBlockedWikilinks, MCP_SERVER_NAME } from './mcpShared.js'
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

// Single-instance lock — see pidfile.ts for the takeover semantics.
const pidfilePath = () => path.join(agentRuntimeConfigDir(), 'claude-tasks.pid')

/** Generated --mcp-config for spawned runs: the km server, bound to the
 *  daemon's own profile, with watcher targets blocked from write-back
 *  (the MCP server resolves each name to its page's full alias set +
 *  id itself). */
const writeMcpConfig = async (config: DaemonConfig): Promise<string> => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const mcpServerScript = path.join(here, 'mcp.js')
  const blockedTargets = config.watchers
    .filter(watcher => watcher.kind === 'backlinks')
    .map(watcher => watcher.target)

  const mcpConfig = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [mcpServerScript],
        env: {
          AGENT_RUNTIME_PROFILE: config.profile,
          ...(blockedTargets.length > 0 ? {[BLOCKED_WIKILINKS_ENV]: encodeBlockedWikilinks(blockedTargets)} : {}),
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

  await acquirePidfile({file: pidfilePath()})

  let stopping = false
  const wake = new AbortController()
  const stop = (signal: string) => {
    log(`${signal} received — draining in-flight runs`)
    stopping = true
    wake.abort() // cut any in-progress poll/preflight sleep short
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  // Interruptible sleep: resolves on timeout OR immediately when stop()
  // fires, so shutdown isn't stuck behind a full poll/retry interval.
  const nap = (ms: number) => new Promise<void>(resolve => {
    if (stopping) return resolve()
    const timer = setTimeout(() => {
      wake.signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => { clearTimeout(timer); resolve() }
    wake.signal.addEventListener('abort', onAbort, {once: true})
  })

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
        await releasePidfile({file: pidfilePath()})
        process.exit(1)
      }
      if (!bridgeStartAttempted && !process.env.AGENT_RUNTIME_URL && isLocalBridgeUrl(resolveBridgeUrl())) {
        bridgeStartAttempted = true
        log(`bridge not reachable (${errorMessage(error)}) — starting it`)
        // The daemon runs unattended (launchd, post-reboot), so it must
        // be able to start the bridge itself — otherwise a reboot leaves
        // it waiting until the user happens to run `yarn agent`. Only for
        // a LOCAL bridge — a configured AGENT_RUNTIME_URL is someone
        // else's process to manage.
        await startBridgeInBackground().catch(startError => log(`bridge start failed: ${errorMessage(startError)}`))
        await nap(1_000) // brief recheck right after starting it
        continue
      }
      log(`waiting for bridge/pairing (${errorMessage(error)}) — retrying in 30s; if never paired, run: yarn agent --profile ${config.profile} connect`)
      await nap(30_000)
    }
  }

  const mcpConfigPath = await writeMcpConfig(config)
  log(`mcp config: ${mcpConfigPath}`)

  const channelSecret = config.watchers.some(watcher => watcher.delivery === 'channel')
    ? await loadOrCreateChannelSecret()
    : null

  const graph = createGraph(client)

  const engine = createEngine({
    config,
    graph,
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

  // Push events request an immediate tick; requests are COALESCED into
  // the single main loop (never concurrent with the sweep tick) and a
  // request landing mid-tick re-ticks right after — the tick may have
  // snapshotted state from before that event's write.
  let tickRequested = false
  const tickWaiters = new Set<() => void>()
  const pendingExemptBlockIds = new Set<string>()
  const requestTick = (settledBlockIds?: readonly string[]) => {
    for (const id of settledBlockIds ?? []) pendingExemptBlockIds.add(id)
    tickRequested = true
    for (const waiter of [...tickWaiters]) waiter()
    tickWaiters.clear()
  }
  const napOrTick = (ms: number) => new Promise<void>(resolve => {
    if (stopping || tickRequested) return resolve()
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      wake.signal.removeEventListener('abort', finish)
      tickWaiters.delete(finish)
      resolve()
    }
    wake.signal.addEventListener('abort', finish, {once: true})
    tickWaiters.add(finish)
  })

  if (config.push && !args.once) {
    void startPushLoop({
      client,
      config,
      graph,
      requestTick,
      log,
      isStopping: () => stopping,
      nap,
      stopSignal: wake.signal,
    })
  }

  while (!stopping) {
    tickRequested = false
    // Drain the exemptions INTO this tick — ids arriving mid-tick stay
    // pending and re-tick immediately via tickRequested.
    const quietExemptBlockIds = new Set(pendingExemptBlockIds)
    pendingExemptBlockIds.clear()
    await engine.tick({quietExemptBlockIds})
    if (args.once) break
    await napOrTick(config.pollIntervalMs)
  }

  await engine.drain()
  await releasePidfile({file: pidfilePath()})
  log('stopped')
}

main().catch(async error => {
  process.stderr.write(`${errorMessage(error)}\n`)
  await releasePidfile({file: pidfilePath()})
  process.exit(1)
})
