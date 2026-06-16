import type { AppEffectCleanup } from '@/extensions/core.js'
import { openDialog } from '@/utils/dialogs.js'
import { agentTokenStore, agentTokensChangedEvent } from './tokens.ts'
// Pairing via the hash URL surfaces the tokens dialog. We open it
// imperatively rather than over a CustomEvent (audit B3). This pulls a
// UI component into the transport module, but it's bundle-safe: nothing
// in the agent-cli/server package imports bridge.ts, so React never
// reaches the node bundle.
import { AgentTokensDialog, type AgentTokensDialogProps } from './AgentTokensDialog.tsx'
import { createAgentRuntimeContext, executeCommand } from './commands.ts'
import { serializeError, serializeValue } from './serialization.ts'
import type { AgentRuntimeBridgeOptions } from './protocol.ts'
import { knownAgentCommandSchema } from '@knowledge-medium/agent-cli/protocol'

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

const storeBridgePairingFromHash = () => {
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (!rawHash) return

  const queryIndex = rawHash.indexOf('?')
  const paramSource = queryIndex >= 0 ? rawHash.slice(queryIndex + 1) : rawHash
  const params = new URLSearchParams(paramSource)
  const secret = params.get('agent-runtime-secret')?.trim()
  const url = params.get('agent-runtime-url')?.trim()
  const openTokensDialog = params.get('agent-runtime-open-tokens') === '1'
  if (!secret && !url && !openTokensDialog) return

  if (secret) window.localStorage.setItem(bridgeSecretStorageKey, secret)
  if (url) window.localStorage.setItem(bridgeUrlStorageKey, url.replace(/\/+$/, ''))

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

  if (openTokensDialog) {
    window.setTimeout(() => {
      void openDialog<void, AgentTokensDialogProps>(AgentTokensDialog, {mode: 'pair-cli'})
    }, 0)
  }
}

const getStoredBridgeSecret = () => {
  storeBridgePairingFromHash()
  return window.localStorage.getItem(bridgeSecretStorageKey)?.trim()
    || import.meta.env.VITE_AGENT_RUNTIME_BRIDGE_SECRET?.trim()
    || ''
}

const bridgeUrl = () => {
  storeBridgePairingFromHash()
  return (
    window.localStorage.getItem(bridgeUrlStorageKey)?.trim()
    || import.meta.env.VITE_AGENT_RUNTIME_URL?.trim()
    || defaultBridgeUrl
  ).replace(/\/+$/, '')
}

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
  const baseUrl = bridgeUrl()
  const clientId = getBridgeClientId()
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

  const register = () => {
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

  const reportResult = async (commandId: string, payload: unknown) => {
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
    storeBridgePairingFromHash()
    wakeBridgeLoop(true)
  }

  window.addEventListener(agentRuntimeBridgeRestartEvent, handleRestart)
  window.addEventListener(agentTokensChangedEvent, handleTokensChanged)
  window.addEventListener('focus', handleWakeEvent)
  window.addEventListener('hashchange', handleHashChanged)
  window.addEventListener('online', handleWakeEvent)
  document.addEventListener('visibilitychange', handleVisibilityChanged)

  const poll = async () => {
    while (!abortController.signal.aborted) {
      try {
        if (tokensDirty) tokensDirty = false
        await register()

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
            })
          }
          continue
        }

        const command = parsed.data
        try {
          const value = await executeCommand(command, createAgentRuntimeContext(options))
          await reportResult(command.commandId!, {
            ok: true,
            value: serializeValue(value),
          })
        } catch (error) {
          await reportResult(command.commandId!, {
            ok: false,
            error: serializeError(error),
          })
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
