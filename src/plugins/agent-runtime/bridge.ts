import type { AppEffectCleanup } from '@/extensions/core.js'
import { openDialog } from '@/utils/dialogs.js'
import { agentTokenStore, agentTokensChangedEvent } from './tokens.ts'
// Pairing via the hash URL surfaces the tokens dialog. We open it
// imperatively rather than over a CustomEvent (audit B3). This pulls a
// UI component into the transport module, but it's bundle-safe: nothing
// in the agent-cli/server package imports bridge.ts, so React never
// reaches the node bundle.
import { AgentTokensDialog, type AgentTokensDialogProps } from './AgentTokensDialog.tsx'
import { BridgePairingDialog, type BridgePairingDialogProps } from './BridgePairingDialog.tsx'
import { createAgentRuntimeContext, executeCommand } from './commands.ts'
import { watchEventsRegistry } from './watchEvents.ts'
import { blockEditSettled } from '@/editor/editSettleSignal.js'
import { serializeError, serializeValue } from './serialization.ts'
import type { AgentRuntimeBridgeOptions } from './protocol.ts'
import { knownAgentCommandSchema, type KnownAgentCommand } from '@knowledge-medium/agent-cli/protocol'

const defaultBridgeUrl = 'http://127.0.0.1:8787'
const bridgeUrlStorageKey = 'agent-runtime:bridge-url'
const bridgeSecretStorageKey = 'agent-runtime:bridge-secret'
const longPollMs = 25_000
const retryBaseMs = 1_000
const retryMaxMs = 30_000
const maxFastAttemptsBeforeQuiet = 6
const quietRetryMs = 60_000

export const agentRuntimeBridgeRestartEvent = 'agent-runtime-bridge:restart'

let bridgeClientId: string | null = null

const getBridgeClientId = () => {
  bridgeClientId ??= crypto.randomUUID()
  return bridgeClientId
}

// Mirror the bridge server's own loopback guard (server.ts
// `loopbackOriginPattern`; agent-cli `isLocalBridgeUrl`). A
// hash-supplied bridge URL is only ever honored when it targets the
// local loopback interface — anything else is a page trying to redirect
// the bridge at attacker-controlled infrastructure to steal the user's
// agent tokens and run commands as them. We can't import the agent-cli
// helper here (its module pulls in node:fs/os), so the check is inlined.
const loopbackHostnames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
export const isLoopbackBridgeUrl = (value: string): boolean => {
  try {
    const {protocol, hostname} = new URL(value)
    return (
      (protocol === 'http:' || protocol === 'https:')
      && loopbackHostnames.has(hostname)
    )
  } catch {
    return false
  }
}

const persistPairing = (url: string, secret: string | null) => {
  window.localStorage.setItem(bridgeUrlStorageKey, url)
  if (secret) window.localStorage.setItem(bridgeSecretStorageKey, secret)
  // Wake the (already running) bridge effect so it re-registers against
  // the freshly approved endpoint/secret. The loop reads the URL/secret
  // live, so the next iteration picks them up.
  // eslint-disable-next-line no-restricted-syntax -- genuine broadcast: wakes the running bridge poll loop after the user approves a pairing
  window.dispatchEvent(new CustomEvent(agentRuntimeBridgeRestartEvent))
}

const confirmAndStorePairing = async (
  url: string,
  secret: string | null,
  openTokensDialog: boolean,
) => {
  // HARD gate: a pairing that arrived over a link is never written to
  // localStorage (and so never used to POST tokens) until the user
  // explicitly approves it here.
  const confirmed = await openDialog<boolean, BridgePairingDialogProps>(
    BridgePairingDialog,
    {url, hasSecret: Boolean(secret)},
  )
  if (!confirmed) return

  persistPairing(url, secret)

  if (openTokensDialog) {
    void openDialog<void, AgentTokensDialogProps>(AgentTokensDialog, {mode: 'pair-cli'})
  }
}

// Reads (and clears) any pairing params smuggled in the page hash.
// Loopback-validates and then gates them behind an explicit user
// confirmation before anything is persisted; non-loopback URLs are
// refused outright. Runs only from inside the bridge effect (startup +
// hashchange), never from the read paths below. Exported for tests.
export const processBridgePairingFromHash = () => {
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (!rawHash) return

  const queryIndex = rawHash.indexOf('?')
  const paramSource = queryIndex >= 0 ? rawHash.slice(queryIndex + 1) : rawHash
  const params = new URLSearchParams(paramSource)
  const secret = params.get('agent-runtime-secret')?.trim() || null
  const rawUrl = params.get('agent-runtime-url')?.trim() || null
  const openTokensDialog = params.get('agent-runtime-open-tokens') === '1'
  if (!secret && !rawUrl && !openTokensDialog) return

  // Strip the credential-bearing params from the URL immediately —
  // before any async confirmation — so the secret can't linger in the
  // address bar, history, or referrer even if the pairing is declined
  // or refused.
  params.delete('agent-runtime-secret')
  params.delete('agent-runtime-url')
  params.delete('agent-runtime-open-tokens')

  const remainingParams = params.toString()
  const routeHash = queryIndex >= 0 ? rawHash.slice(0, queryIndex) : ''
  const nextHash = routeHash || remainingParams
    ? `#${routeHash}${remainingParams ? `?${remainingParams}` : ''}`
    : ''

  window.history.replaceState(
    null,
    document.title,
    `${window.location.pathname}${window.location.search}${nextHash}`,
  )

  const candidateUrl = rawUrl ? rawUrl.replace(/\/+$/, '') : null
  if (candidateUrl && !isLoopbackBridgeUrl(candidateUrl)) {
    // Attempted redirection to a non-loopback endpoint. Refuse the whole
    // pairing — never store it, never prompt the user to approve an
    // attacker-controlled URL, and drop any secret that rode along.
    console.warn(
      'Agent runtime: ignoring pairing link with a non-loopback bridge URL.',
    )
    return
  }

  if (candidateUrl) {
    // A loopback pairing. Gate it behind explicit confirmation; the
    // secret (if any) travels with the URL. Defer so we never open a
    // dialog synchronously during effect setup or a hashchange handler.
    window.setTimeout(() => {
      void confirmAndStorePairing(candidateUrl, secret, openTokensDialog)
    }, 0)
    return
  }

  if (secret) {
    // A secret with no bridge URL has no legitimate source — the CLI
    // always emits the URL alongside it (config.ts `pairingUrl`).
    // Honoring a lone secret would only let a link overwrite the user's
    // existing bridge secret (a reversible local DoS), so drop it. Fall
    // through so a co-supplied open-tokens request still works.
    console.warn(
      'Agent runtime: ignoring pairing secret supplied without a bridge URL.',
    )
  }

  if (openTokensDialog) {
    window.setTimeout(() => {
      void openDialog<void, AgentTokensDialogProps>(AgentTokensDialog, {mode: 'pair-cli'})
    }, 0)
  }
}

// No hash side effects — hash-supplied pairings are handled exclusively
// by `processBridgePairingFromHash` (gated by confirmation). The stored
// URL is still validated/self-healed on read, because a browser poisoned
// by the OLD pre-fix code can already hold a non-loopback attacker URL in
// localStorage; trusting it on upgrade would keep POSTing the user's
// tokens to the attacker. Returns the stored URL only if it's loopback;
// otherwise purges the poisoned URL (and the secret paired with it) and
// falls back to the build-time env override or the loopback default.
// Build-time env overrides are trusted and left untouched.
const readTrustedStoredBridgeUrl = (): string | null => {
  const stored = window.localStorage.getItem(bridgeUrlStorageKey)?.trim()
  if (!stored) return null
  if (isLoopbackBridgeUrl(stored)) return stored
  window.localStorage.removeItem(bridgeUrlStorageKey)
  window.localStorage.removeItem(bridgeSecretStorageKey)
  console.warn('Agent runtime: purged a stored non-loopback bridge URL.')
  return null
}

const getStoredBridgeSecret = () =>
  window.localStorage.getItem(bridgeSecretStorageKey)?.trim()
  || import.meta.env.VITE_AGENT_RUNTIME_BRIDGE_SECRET?.trim()
  || ''

export const bridgeUrl = () =>
  (
    readTrustedStoredBridgeUrl()
    || import.meta.env.VITE_AGENT_RUNTIME_URL?.trim()
    || defaultBridgeUrl
  ).replace(/\/+$/, '')

const bridgeHeaders = () => {
  const secret = getStoredBridgeSecret()
  if (!secret) {
    throw new Error('Agent runtime bridge is not paired. Start the bridge server and open its pairing URL.')
  }
  return {'x-agent-runtime-secret': secret}
}

const postJson = async (
  url: string,
  body: unknown,
  signal?: AbortSignal,
  clientId?: string,
) => {
  const response = await window.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...bridgeHeaders(),
      ...(clientId ? {'x-agent-runtime-client-id': clientId} : {}),
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Agent runtime bridge request failed: ${response.status}`)
  }

  return response
}

export const startAgentRuntimeBridge = (
  options: AgentRuntimeBridgeOptions,
): AppEffectCleanup => {
  const abortController = new AbortController()
  const clientId = getBridgeClientId()
  // NB: the bridge URL is read live each iteration (see the `poll` loop)
  // rather than captured once. A link-supplied pairing only takes effect
  // after the user confirms it, which can land after the loop has already
  // started — so the loop must re-read the approved endpoint, not a stale
  // snapshot.

  // Process any pairing params already present in the hash at startup.
  // Gated by user confirmation + a loopback check; nothing is persisted
  // or used here directly.
  processBridgePairingFromHash()
  let retryMs = retryBaseMs
  let attempts = 0
  let wakeResolve: (() => void) | null = null
  let bridgeUnavailableLogged = false
  let tokensDirty = false

  const waitForWakeOrTimeout = (ms: number) => new Promise<void>(resolve => {
    let settled = false
    let timeout: number | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timeout !== null) window.clearTimeout(timeout)
      if (wakeResolve === finish) wakeResolve = null
      resolve()
    }

    timeout = window.setTimeout(finish, ms)
    wakeResolve = finish
  })

  const wakeBridgeLoop = (markTokensDirty = false) => {
    attempts = 0
    retryMs = retryBaseMs
    if (markTokensDirty) tokensDirty = true
    if (wakeResolve) {
      wakeResolve()
      wakeResolve = null
    }
  }

  const register = (baseUrl = bridgeUrl()) => {
    const {repo, safeMode} = options
    const userId = repo.user.id
    const workspaceId = repo.activeWorkspaceId
    const tokens = userId && workspaceId
      ? agentTokenStore.list(userId, workspaceId).map(t => ({
          token: t.token,
          label: t.label,
          scope: t.scope ?? 'read-write',
          userId,
          workspaceId,
        }))
      : []

    tokensDirty = false

    return postJson(`${baseUrl}/runtime/clients/${clientId}`, {
      activeWorkspaceId: workspaceId,
      currentUser: repo.user,
      safeMode,
      href: window.location.href,
      userAgent: window.navigator.userAgent,
      audience: { userId, workspaceId },
      tokens,
    }, abortController.signal)
  }

  const reportResult = async (
    commandId: string,
    payload: unknown,
    baseUrl = bridgeUrl(),
  ) => {
    await postJson(
      `${baseUrl}/runtime/commands/${commandId}/result`,
      payload,
      abortController.signal,
      clientId,
    )
  }

  const handleRestart = () => {
    wakeBridgeLoop(true)
  }

  const handleTokensChanged = () => {
    tokensDirty = true
    wakeBridgeLoop()
    register().catch(() => { /* loop will retry */ })
  }

  const handleVisibilityChanged = () => {
    if (document.visibilityState === 'visible') wakeBridgeLoop()
  }

  const handleWakeEvent = () => {
    wakeBridgeLoop()
  }

  const handleHashChanged = () => {
    processBridgePairingFromHash()
    wakeBridgeLoop(true)
  }

  // watch-events emissions ride this bridge connection (same secret +
  // clientId as result posts). The live-read of bridgeUrl() matters for
  // the same reason as in the poll loop: pairings can change mid-flight.
  watchEventsRegistry.setTransport(async event => {
    await postJson(`${bridgeUrl()}/runtime/events`, event, abortController.signal, clientId)
  })
  // Editor blur short-circuits the settle window for that block —
  // typed mentions fire the moment the user leaves them.
  const offEditSettled = blockEditSettled.add(blockId =>
    watchEventsRegistry.notifyBlockSettled(blockId))

  window.addEventListener(agentRuntimeBridgeRestartEvent, handleRestart)
  window.addEventListener(agentTokensChangedEvent, handleTokensChanged)
  window.addEventListener('focus', handleWakeEvent)
  window.addEventListener('hashchange', handleHashChanged)
  window.addEventListener('online', handleWakeEvent)
  document.addEventListener('visibilitychange', handleVisibilityChanged)

  // Commands run DETACHED from the poll loop: a slow command (a hung
  // eval, a long SQL) must not stall delivery of everything queued
  // behind it — the daemon's polls, other CLI calls. Bounded so a
  // command flood can't pile up unboundedly; the loop parks on a free
  // slot instead of on completion of the command it just delivered.
  const maxConcurrentCommands = 4
  const saturatedParkMs = 60_000
  const inFlightCommands = new Set<Promise<void>>()

  const runCommand = async (command: KnownAgentCommand, baseUrl: string) => {
    let payload: unknown
    try {
      const value = await executeCommand(command, createAgentRuntimeContext(options))
      payload = {ok: true, value: serializeValue(value)}
    } catch (error) {
      payload = {ok: false, error: serializeError(error)}
    }
    try {
      await reportResult(command.commandId!, payload, baseUrl)
    } catch (reportError) {
      // No result channel left (bridge restarted / page going away). The
      // submitter's own request times out; the poll loop's fetches carry
      // the reconnect/backoff, so just surface it for debugging.
      if (!abortController.signal.aborted) {
        console.warn('Agent runtime: failed to report a command result.', reportError)
      }
    }
  }

  const poll = async () => {
    while (!abortController.signal.aborted) {
      // Read the endpoint live each iteration so a pairing the user
      // approves mid-flight (which wakes this loop) is picked up.
      const baseUrl = bridgeUrl()
      try {
        if (tokensDirty) tokensDirty = false
        await register(baseUrl)

        if (bridgeUnavailableLogged) {
          console.info(`Agent runtime bridge reconnected at ${baseUrl}.`)
          bridgeUnavailableLogged = false
        }

        const nextUrl = new URL(`${baseUrl}/runtime/commands/next`)
        nextUrl.searchParams.set('clientId', clientId)
        nextUrl.searchParams.set('timeoutMs', String(longPollMs))

        const response = await window.fetch(nextUrl, {
          headers: bridgeHeaders(),
          signal: abortController.signal,
        })
        if (!response.ok) {
          throw new Error(`Agent runtime bridge poll failed: ${response.status}`)
        }

        const rawCommand = await response.json() as unknown
        retryMs = retryBaseMs
        attempts = 0

        if (!rawCommand) continue

        // Validate at the bridge boundary so an unknown command type
        // gets a clean, structured error before the kernel switch ever
        // runs. The schema also gives `executeCommand` a strict
        // discriminated-union argument — its switch then narrows on
        // each case.
        const parsed = knownAgentCommandSchema.safeParse(rawCommand)
        const commandIdForResult = (rawCommand as {commandId?: string})?.commandId

        if (!parsed.success) {
          if (commandIdForResult) {
            await reportResult(commandIdForResult, {
              ok: false,
              error: serializeError(
                new Error(`Invalid command body: ${parsed.error.issues.map(i => i.message).join('; ')}`),
              ),
            }, baseUrl)
          }
          continue
        }

        const command = parsed.data
        const execution = runCommand(command, baseUrl).finally(() => {
          inFlightCommands.delete(execution)
        })
        inFlightCommands.add(execution)
        if (inFlightCommands.size >= maxConcurrentCommands) {
          // Saturated: wait for A slot, not for THIS command. The park
          // also resolves on teardown (cleanup fires the wake) and after
          // a generous cap — commands have no tab-side execution timeout,
          // so a fleet of hung evals must degrade to a SOFT concurrency
          // bound rather than stalling command delivery until reload.
          await Promise.race([...inFlightCommands, waitForWakeOrTimeout(saturatedParkMs)])
          if (inFlightCommands.size >= maxConcurrentCommands) {
            console.warn(`Agent runtime: ${inFlightCommands.size} commands in flight past the saturation park — delivering anyway.`)
          }
        }
      } catch {
        if (abortController.signal.aborted) return

        attempts += 1
        if (attempts >= maxFastAttemptsBeforeQuiet) {
          if (!bridgeUnavailableLogged) {
            console.info(
              `Agent runtime bridge unavailable at ${baseUrl}; ` +
              `retrying quietly every ${quietRetryMs / 1000} seconds.`,
            )
            bridgeUnavailableLogged = true
          }
          await waitForWakeOrTimeout(quietRetryMs)
          if (abortController.signal.aborted) return
          continue
        }

        await waitForWakeOrTimeout(retryMs)
        if (abortController.signal.aborted) return
        retryMs = Math.min(retryMs * 2, retryMaxMs)
      }
    }
  }

  void poll()

  return () => {
    abortController.abort()
    // Registrations are useless without a transport — drop them so dead
    // watchers don't keep re-running queries against a stopped bridge.
    watchEventsRegistry.setTransport(null)
    watchEventsRegistry.disposeAll()
    offEditSettled()
    window.removeEventListener(agentRuntimeBridgeRestartEvent, handleRestart)
    window.removeEventListener(agentTokensChangedEvent, handleTokensChanged)
    window.removeEventListener('focus', handleWakeEvent)
    window.removeEventListener('hashchange', handleHashChanged)
    window.removeEventListener('online', handleWakeEvent)
    document.removeEventListener('visibilitychange', handleVisibilityChanged)
    if (wakeResolve) {
      wakeResolve()
      wakeResolve = null
    }
  }
}
