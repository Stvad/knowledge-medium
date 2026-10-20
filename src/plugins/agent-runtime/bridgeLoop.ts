/**
 * A runtime's connection to the agent bridge server: it registers as a
 * client, long-polls for commands, runs each one detached and posts its
 * result, and backs off while the bridge is unreachable. Where it runs is the
 * caller's business — the app tab (bridge.ts) supplies the stored pairing and
 * the tab's registration, the agent eval's node host its own — so nothing
 * here touches the DOM or storage.
 */
import { knownAgentCommandSchema, type KnownAgentCommand } from '@knowledge-medium/agent-cli/protocol'
import { serializeError, serializeValue } from './serialization.ts'

const longPollMs = 25_000
const retryBaseMs = 1_000
const retryMaxMs = 30_000
const maxFastAttemptsBeforeQuiet = 6
const quietRetryMs = 60_000
// A bounded number of commands run at once, so a flood cannot pile up; past
// it the loop parks on a free slot, not on the command it just delivered.
const maxConcurrentCommands = 4
// Must sit comfortably BELOW the bridge server's 60s client TTL: a
// fully-parked client neither registers nor polls, and parking right up to
// the TTL gets it dropped (tokens gone, commands failed ClientGone) at
// exactly the park boundary.
const saturatedParkMs = 45_000

// Keep diagnostic output bounded to safe fields, never request or error contents.
const classifyBridgeError = (error: unknown) => {
  const value = error as {name?: unknown, message?: unknown} | null
  const name = typeof value?.name === 'string'
    && ['Error', 'TypeError', 'DOMException', 'AbortError', 'SecurityError', 'SyntaxError'].includes(value.name)
    ? value.name : 'Error'
  const message = typeof value?.message === 'string' ? value.message : ''
  if (message.startsWith('Agent runtime bridge is not paired.')) {
    return {name, category: 'missing-browser-bridge-pairing'}
  }
  const status = message.match(/^Agent runtime bridge (?:request|poll) failed: ([0-9]{3})$/)
  if (status) return {name, category: 'http-error', httpStatus: Number(status[1])}
  if (name === 'AbortError') return {name, category: 'aborted'}
  if (name === 'TypeError') return {name, category: 'type-or-fetch-error'}
  if (name === 'SecurityError') return {name, category: 'browser-security-error'}
  return {name, category: 'other'}
}

/** A command's result as it goes back over the wire. */
export const commandResult = async (run: () => Promise<unknown>): Promise<{ok: true, value: unknown} | {ok: false, error: ReturnType<typeof serializeError>}> => {
  try {
    return {ok: true, value: serializeValue(await run())}
  } catch (error) {
    return {ok: false, error: serializeError(error)}
  }
}

export interface BridgeLoopOptions {
  clientId: string
  /** Read at every use, so a pairing approved while the loop runs is picked
   *  up at its next turn. */
  baseUrl: () => string
  /** The bridge-secret header; throws while there is no secret, which the
   *  loop treats as an unreachable bridge. */
  headers: () => Record<string, string>
  /** The registration body, built at each registration's own turn. */
  registration: () => unknown
  /** Runs a validated command and returns its value. */
  execute: (command: KnownAgentCommand) => Promise<unknown>
  fetch: typeof fetch
}

export interface BridgeLoop {
  /** Registers now rather than at the next turn. */
  register: () => Promise<unknown>
  /** Ends a backoff wait, so the next attempt is immediate. */
  wake: () => void
  /** POSTs to the bridge as this client. */
  post: (path: string, body: unknown) => Promise<Response>
  stop: () => void
}

type DiagnosticStageObserver = (stage: string) => void

export const startBridgeLoop = (options: BridgeLoopOptions): BridgeLoop => {
  const {clientId} = options
  const abortController = new AbortController()
  let retryMs = retryBaseMs
  let attempts = 0
  let wakeResolve: (() => void) | null = null
  let bridgeUnavailableLogged = false
  let lastDiagnosticKey: string | null = null

  const waitForWakeOrTimeout = (ms: number) => new Promise<void>(resolve => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      if (wakeResolve === finish) wakeResolve = null
      resolve()
    }

    timeout = setTimeout(finish, ms)
    wakeResolve = finish
  })

  const wake = () => {
    attempts = 0
    retryMs = retryBaseMs
    if (wakeResolve) {
      wakeResolve()
      wakeResolve = null
    }
  }

  const postJson = async (
    url: string,
    body: unknown,
    withClientId: boolean,
    stages: {headers: string, serialize: string, fetch: string},
    observeStage?: DiagnosticStageObserver,
  ) => {
    observeStage?.(stages.headers)
    const headers = {
      'content-type': 'application/json',
      ...options.headers(),
      ...(withClientId ? {'x-agent-runtime-client-id': clientId} : {}),
    }
    observeStage?.(stages.serialize)
    const serialized = JSON.stringify(body)
    observeStage?.(stages.fetch)
    const response = await options.fetch(url, {
      method: 'POST',
      headers,
      body: serialized,
      signal: abortController.signal,
    })

    if (!response.ok) {
      throw new Error(`Agent runtime bridge request failed: ${response.status}`)
    }

    return response
  }

  // One registration at a time, each reading the registration at its own
  // turn: the server replaces a client's grants with every registration it
  // receives, so two in flight could land stale-last and re-list a revoked
  // token.
  let registrationTail: Promise<unknown> | null = null
  const register = (baseUrl = options.baseUrl(), observeStage?: DiagnosticStageObserver) => {
    const send = () => {
      observeStage?.('build-registration')
      const registration = options.registration()
      return postJson(
        `${baseUrl}/runtime/clients/${clientId}`,
        registration,
        false,
        {headers: 'headers', serialize: 'serialize-registration', fetch: 'registration-fetch'},
        observeStage,
      )
    }
    const turn = registrationTail ? registrationTail.then(send, send) : send()
    registrationTail = turn
    const release = () => { if (registrationTail === turn) registrationTail = null }
    turn.then(release, release)
    return turn
  }

  const reportResult = (
    commandId: string,
    payload: unknown,
    baseUrl: string,
    observeStage?: DiagnosticStageObserver,
  ) => postJson(
    `${baseUrl}/runtime/commands/${commandId}/result`,
    payload,
    true,
    {headers: 'result-headers', serialize: 'serialize-result', fetch: 'result-fetch'},
    observeStage,
  )

  const inFlightCommands = new Set<Promise<void>>()

  const runCommand = async (command: KnownAgentCommand, baseUrl: string) => {
    const payload = await commandResult(() => options.execute(command))
    try {
      await reportResult(command.commandId!, payload, baseUrl)
    } catch (reportError) {
      // No result channel left (bridge restarted / runtime going away). The
      // submitter's own request times out; the poll loop's fetches carry
      // the reconnect/backoff, so just surface it for debugging.
      if (!abortController.signal.aborted) {
        console.warn('Agent runtime: failed to report a command result.', reportError)
      }
    }
  }

  const poll = async () => {
    while (!abortController.signal.aborted) {
      const baseUrl = options.baseUrl()
      let diagnosticStage = 'registration'
      const observeStage = (stage: string) => { diagnosticStage = stage }
      try {
        await register(baseUrl, observeStage)

        if (bridgeUnavailableLogged) {
          console.info(`Agent runtime bridge reconnected at ${baseUrl}.`)
          bridgeUnavailableLogged = false
        }

        const nextUrl = new URL(`${baseUrl}/runtime/commands/next`)
        nextUrl.searchParams.set('clientId', clientId)
        nextUrl.searchParams.set('timeoutMs', String(longPollMs))

        observeStage('poll-headers')
        const headers = options.headers()
        observeStage('poll-fetch')
        const response = await options.fetch(nextUrl, {
          headers,
          signal: abortController.signal,
        })
        if (!response.ok) {
          throw new Error(`Agent runtime bridge poll failed: ${response.status}`)
        }

        observeStage('poll-decode')
        const rawCommand = await response.json() as unknown
        retryMs = retryBaseMs
        attempts = 0
        lastDiagnosticKey = null

        if (!rawCommand) continue

        // Validated at the bridge boundary, so an unknown command type gets a
        // clean, structured error before the kernel switch ever runs, and the
        // executor gets a strict discriminated union.
        const parsed = knownAgentCommandSchema.safeParse(rawCommand)
        const commandIdForResult = (rawCommand as {commandId?: string})?.commandId

        if (!parsed.success) {
          if (commandIdForResult) {
            await reportResult(commandIdForResult, {
              ok: false,
              error: serializeError(
                new Error(`Invalid command body: ${parsed.error.issues.map(i => i.message).join('; ')}`),
              ),
            }, baseUrl, observeStage)
          }
          continue
        }

        // Detached, so a slow command (a hung eval, a long SQL) does not stall
        // delivery of everything queued behind it.
        const execution = runCommand(parsed.data, baseUrl).finally(() => {
          inFlightCommands.delete(execution)
        })
        inFlightCommands.add(execution)
        if (inFlightCommands.size >= maxConcurrentCommands) {
          // Saturated: wait for A slot, not for THIS command. The park also
          // resolves on stop (which fires the wake) and after a generous cap —
          // commands have no runtime-side timeout, so a fleet of hung evals
          // must degrade to a SOFT bound rather than stall delivery for good.
          // Re-register FIRST: the long-poll that delivered this command may
          // have been held up to 25s server-side, and lastSeen + 25s + the
          // park would breach the server's 60s client TTL.
          await register(baseUrl, observeStage)
          await Promise.race([...inFlightCommands, waitForWakeOrTimeout(saturatedParkMs)])
          if (inFlightCommands.size >= maxConcurrentCommands) {
            console.warn(`Agent runtime: ${inFlightCommands.size} commands in flight past the saturation park — delivering anyway.`)
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) return
        const diagnostic = {
          stage: diagnosticStage,
          ...classifyBridgeError(error),
        }
        const diagnosticKey = JSON.stringify(diagnostic)
        if (diagnosticKey !== lastDiagnosticKey) {
          console.warn('Agent runtime diagnostic', diagnosticKey)
          lastDiagnosticKey = diagnosticKey
        }

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

  return {
    register: () => register(),
    wake,
    post: (path, body) => postJson(
      `${options.baseUrl()}${path}`,
      body,
      true,
      {headers: 'post-headers', serialize: 'serialize-post', fetch: 'post-fetch'},
    ),
    stop: () => {
      abortController.abort()
      wake()
    },
  }
}
