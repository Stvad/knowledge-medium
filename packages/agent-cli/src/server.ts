#!/usr/bin/env node
import http from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  bridgeHost,
  bridgePort,
  bridgeServerUrl,
  bridgeSecret as resolveBridgeSecret,
  pairingUrl,
} from './config.js'
import {
  type Audience,
  type CommandPayload,
  commandPayloadSchema,
  knownCommandRegistry,
  type KnownCommandMeta,
  registerClientMetadataSchema,
  registerTokenSpecSchema,
  type TokenAudience,
  type TokenScope,
  type RegisterClientMetadata,
} from './protocol.js'

const port = bridgePort()
const host = bridgeHost()
if ((host === '0.0.0.0' || host === '::') && process.env.AGENT_RUNTIME_ALLOW_NETWORK !== 'true') {
  throw new Error('Refusing to expose agent runtime bridge on the network without AGENT_RUNTIME_ALLOW_NETWORK=true')
}
const commandTtlMs = 10 * 60 * 1000
const clientTtlMs = 60_000
const unknownTokenMessage = [
  'Agent token is not registered with the local bridge.',
  'Open or focus the app tab for the same workspace, then retry; if needed, run `yarn agent connect` to pair a fresh token.',
  'Common causes: the bridge restarted, the app tab disconnected or idled out, the token was revoked, or the CLI is using a token/profile from another workspace or browser profile.',
].join(' ')
const configuredMaxBodyBytes = Number(process.env.AGENT_RUNTIME_MAX_BODY_BYTES ?? 10 * 1024 * 1024)
const maxBodyBytes = Number.isFinite(configuredMaxBodyBytes) && configuredMaxBodyBytes > 0
  ? configuredMaxBodyBytes
  : 10 * 1024 * 1024
const bridgeSecret = await resolveBridgeSecret()
const bridgeSecretHeader = 'x-agent-runtime-secret'
// Opt-in, off in production. When set, exposes POST /runtime/test/reset
// (still gated behind the bridge secret) so a test suite can share one
// server process and wipe state between cases instead of respawning per
// test. Inert unless this env var is exactly 'true'.
const testResetEnabled = process.env.AGENT_RUNTIME_TEST_RESET === 'true'
const defaultAllowedOrigins = new Set(['https://stvad.github.io'])
const configuredAllowedOrigins = (process.env.AGENT_RUNTIME_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)
  .map(origin => {
    try {
      return new URL(origin).origin
    } catch {
      return origin
    }
  })
const allowedOrigins = new Set([...defaultAllowedOrigins, ...configuredAllowedOrigins])
const loopbackOriginPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Wire shapes come from ./protocol.ts (zod schemas + inferred types).
// What stays here are server-only / internal shapes — records that
// never cross the network.

type ClientId = string
type Token = string
type CommandId = string

interface ClientRecord {
  id: ClientId
  metadata: Record<string, unknown>
  audience: Audience | null
  lastSeen: number
  tokens: Set<Token>
}

interface TokenRecord {
  clientId: ClientId
  audience: TokenAudience
  scope: TokenScope
}

type CommandStatus = 'pending' | 'delivered' | 'completed' | 'failed'

interface CommandRecord {
  id: CommandId
  targetClientId: ClientId
  payload: CommandPayload & {commandId: CommandId}
  status: CommandStatus
  createdAt: number
  deliveredAt: number | null
  completedAt: number | null
  clientId: ClientId | null
  submitterTokenHash: string
  result: unknown
}

interface Waiter {
  response: http.ServerResponse
  timeout: NodeJS.Timeout
}

// clientId -> client record
const clients = new Map<ClientId, ClientRecord>()
// commandId -> command record
const commands = new Map<CommandId, CommandRecord>()
// clientId -> [commandId, ...] — per-client FIFO of pending commands
const pendingByClient = new Map<ClientId, CommandId[]>()
// clientId -> Set<Waiter>
const waitersByClient = new Map<ClientId, Set<Waiter>>()
// token -> token record
const tokens = new Map<Token, TokenRecord>()
const responseRequests = new WeakMap<http.ServerResponse, http.IncomingMessage>()

const now = () => Date.now()

const normalizeOrigin = (origin: string): string => {
  try {
    return new URL(origin).origin
  } catch {
    return origin
  }
}

const isAllowedOrigin = (origin: string | string[] | undefined): boolean => {
  if (!origin || typeof origin !== 'string') return true
  if (origin === 'null') return false
  const normalized = normalizeOrigin(origin)
  return loopbackOriginPattern.test(normalized) || allowedOrigins.has(normalized)
}

const jsonHeadersFor = (response: http.ServerResponse): Record<string, string> => {
  const request = responseRequests.get(response)
  const headers: Record<string, string> = {'content-type': 'application/json'}
  const origin = request?.headers.origin

  if (typeof origin === 'string' && isAllowedOrigin(origin)) {
    headers['access-control-allow-origin'] = normalizeOrigin(origin)
    headers['access-control-allow-methods'] = 'GET,POST,OPTIONS'
    headers['access-control-allow-headers'] = `authorization,content-type,${bridgeSecretHeader},x-agent-runtime-client-id`
    headers['access-control-max-age'] = '86400'
    headers.vary = 'Origin'
  }

  return headers
}

const sendJson = (response: http.ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, jsonHeadersFor(response))
  response.end(JSON.stringify(body))
}

const sendEmpty = (response: http.ServerResponse, status = 204): void => {
  response.writeHead(status, jsonHeadersFor(response))
  response.end()
}

const readBody = (request: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let tooLarge = false

    request.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBodyBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, `Request body exceeds ${maxBodyBytes} bytes`))
        return
      }
      if (!chunks.length) {
        resolve(null)
        return
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })

    request.on('error', reject)
  })

const extractBearer = (request: http.IncomingMessage): Token | null => {
  const header = request.headers.authorization
  if (!header || typeof header !== 'string') return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1]!.trim() : null
}

const hashToken = (token: Token): string => createHash('sha256').update(token).digest('hex')

const safeEqual = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer)
}

const hasBridgeSecret = (request: http.IncomingMessage): boolean => {
  const header = request.headers[bridgeSecretHeader]
  return typeof header === 'string' && safeEqual(header, bridgeSecret)
}

const requireBridgeSecret = (request: http.IncomingMessage, response: http.ServerResponse): boolean => {
  if (hasBridgeSecret(request)) return true
  sendJson(response, 401, {error: 'Missing or invalid bridge secret'})
  return false
}

const tokenScope = (value: unknown): TokenScope =>
  value === 'read-only' ? 'read-only' : 'read-write'

const deleteTokenForClient = (token: Token, clientId: ClientId): void => {
  const entry = tokens.get(token)
  if (entry?.clientId === clientId) tokens.delete(token)
}

const isReadOnlySql = (sql: unknown): boolean =>
  typeof sql === 'string' && /^(select|explain)\b/i.test(sql.trimStart())

const isReadOnlyCommand = (command: CommandPayload): boolean => {
  // `sql` is the one verb whose read-only-ness depends on the call, not
  // just the verb: a non-execute SELECT/EXPLAIN is a read, but
  // `mode: 'execute'` (or a mutating statement) is not. Refine it here
  // before falling back to the schema-derived registry.
  if (command.type === 'sql') {
    return command.mode !== 'execute' && isReadOnlySql(command.sql)
  }
  // Every other verb's read-only-ness is a static, per-verb fact declared
  // once in `knownCommandRegistry` — TypeScript-exhaustiveness-checked, so
  // a verb can't be added to the wire protocol without classifying it, and
  // this allowlist can't drift. Unknown types (legacy aliases `action` /
  // `set-extension-enabled`, or arbitrary `kmagent raw` bodies) have no
  // entry and default to write (deny).
  const meta: KnownCommandMeta | undefined =
    (knownCommandRegistry as Record<string, KnownCommandMeta>)[command.type]
  return meta?.readOnly === true
}

const dropClient = (clientId: ClientId): void => {
  const client = clients.get(clientId)
  if (client) {
    for (const token of client.tokens) deleteTokenForClient(token, clientId)
  }
  clients.delete(clientId)

  // Drop pending queue and fail any waiters; commands targeting this
  // client are marked failed so the agent CLI sees a clean error
  // rather than a hang.
  const pending = pendingByClient.get(clientId)
  if (pending) {
    for (const id of pending) {
      const command = commands.get(id)
      if (command && command.status === 'pending') {
        command.status = 'failed'
        command.completedAt = now()
        command.result = {ok: false, error: {name: 'ClientGone', message: 'Target client disconnected'}}
      }
    }
    pendingByClient.delete(clientId)
  }

  const waiters = waitersByClient.get(clientId)
  if (waiters) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout)
      try { sendJson(waiter.response, 200, null) } catch { /* socket closed */ }
    }
    waitersByClient.delete(clientId)
  }
}

const cleanup = () => {
  const commandExpiry = now() - commandTtlMs
  for (const [id, command] of commands) {
    if (command.createdAt < commandExpiry && command.status !== 'pending') {
      commands.delete(id)
    }
  }

  const clientExpiry = now() - clientTtlMs
  for (const [id, client] of clients) {
    if (client.lastSeen < clientExpiry) {
      dropClient(id)
    }
  }
}

const takePendingForClient = (clientId: ClientId): CommandRecord | null => {
  const queue = pendingByClient.get(clientId)
  if (!queue) return null
  while (queue.length) {
    const id = queue.shift()!
    const command = commands.get(id)
    if (command?.status === 'pending') return command
  }
  if (queue.length === 0) pendingByClient.delete(clientId)
  return null
}

const tryDeliverToClient = (clientId: ClientId): void => {
  const waiters = waitersByClient.get(clientId)
  if (!waiters || waiters.size === 0) return
  for (const waiter of Array.from(waiters)) {
    const command = takePendingForClient(clientId)
    if (!command) return
    waiters.delete(waiter)
    if (waiters.size === 0) waitersByClient.delete(clientId)
    command.status = 'delivered'
    command.deliveredAt = now()
    command.clientId = clientId
    clearTimeout(waiter.timeout)
    sendJson(waiter.response, 200, command.payload)
  }
}

const registerClient = (clientId: ClientId, metadata: RegisterClientMetadata = {}): void => {
  const existing = clients.get(clientId)
  // The outer metadata shape was validated by handleRequest; per-entry
  // token specs are validated individually so a single malformed entry
  // doesn't reject the whole registration.
  const validatedTokens = (metadata.tokens ?? [])
    .map(entry => registerTokenSpecSchema.safeParse(entry))
    .flatMap(result => (result.success ? [result.data] : []))

  const audience: Audience | null = metadata.audience
    ? {
        userId: typeof metadata.audience.userId === 'string' ? metadata.audience.userId : null,
        workspaceId: typeof metadata.audience.workspaceId === 'string' ? metadata.audience.workspaceId : null,
      }
    : null

  // Drop tokens the client no longer authorizes
  if (existing) {
    for (const oldToken of existing.tokens) {
      if (!validatedTokens.some(t => t.token === oldToken)) {
        deleteTokenForClient(oldToken, clientId)
      }
    }
  }

  const tokenSet = new Set<Token>()
  for (const entry of validatedTokens) {
    tokenSet.add(entry.token)
    tokens.set(entry.token, {
      clientId,
      audience: {
        userId: entry.userId ?? audience?.userId ?? null,
        workspaceId: entry.workspaceId ?? audience?.workspaceId ?? null,
        label: entry.label ?? null,
      },
      scope: tokenScope(entry.scope),
    })
  }

  // Strip token list from stored metadata so /health doesn't echo
  // secrets back to anyone who can reach the local server.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tokens: _omit, ...publicMetadata } = metadata

  clients.set(clientId, {
    id: clientId,
    metadata: publicMetadata,
    audience,
    lastSeen: now(),
    tokens: tokenSet,
  })
}

const enqueueCommand = (
  clientId: ClientId,
  payload: CommandPayload,
  submitterTokenHash: string,
): CommandRecord => {
  const id = randomUUID()
  const commandPayload = {
    ...payload,
    commandId: id,
  }

  const command: CommandRecord = {
    id,
    targetClientId: clientId,
    payload: commandPayload,
    status: 'pending',
    createdAt: now(),
    deliveredAt: null,
    completedAt: null,
    clientId: null,
    submitterTokenHash,
    result: null,
  }

  commands.set(id, command)
  let queue = pendingByClient.get(clientId)
  if (!queue) {
    queue = []
    pendingByClient.set(clientId, queue)
  }
  queue.push(id)
  tryDeliverToClient(clientId)
  return command
}

const waitForNextCommand = (
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
): void => {
  const clientId = requestUrl.searchParams.get('clientId') || 'anonymous-client'
  const timeoutMs = Math.min(
    Number(requestUrl.searchParams.get('timeoutMs') ?? 25_000),
    60_000,
  )

  // Touch lastSeen so an active long-poll keeps the client alive even
  // between explicit /clients re-registrations.
  const client = clients.get(clientId)
  if (client) client.lastSeen = now()

  const command = takePendingForClient(clientId)
  if (command) {
    command.status = 'delivered'
    command.deliveredAt = now()
    command.clientId = clientId
    sendJson(response, 200, command.payload)
    return
  }

  const waiter: Waiter = {
    response,
    timeout: setTimeout(() => {
      const set = waitersByClient.get(clientId)
      if (set) {
        set.delete(waiter)
        if (set.size === 0) waitersByClient.delete(clientId)
      }
      sendJson(response, 200, null)
    }, timeoutMs),
  }

  request.on('close', () => {
    const set = waitersByClient.get(clientId)
    if (set) {
      set.delete(waiter)
      if (set.size === 0) waitersByClient.delete(clientId)
    }
    clearTimeout(waiter.timeout)
  })

  let set = waitersByClient.get(clientId)
  if (!set) {
    set = new Set()
    waitersByClient.set(clientId, set)
  }
  set.add(waiter)
}

const setCommandResult = async (
  id: CommandId,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> => {
  const command = commands.get(id)
  if (!command) {
    sendJson(response, 404, {error: `Unknown command: ${id}`})
    return
  }
  const reportingClientId = request.headers['x-agent-runtime-client-id']
  if (command.clientId && reportingClientId !== command.clientId) {
    sendJson(response, 403, {error: 'Command result client mismatch'})
    return
  }

  command.status = 'completed'
  command.completedAt = now()
  command.result = await readBody(request)
  sendJson(response, 200, {ok: true})
}

const getStatus = () => ({
  ok: true,
  clients: Array.from(clients.values()).map(client => ({
    id: client.id,
    lastSeen: client.lastSeen,
    metadata: client.metadata,
    audience: client.audience,
    tokenCount: client.tokens.size,
  })),
  commands: Array.from(commands.values()).map(command => ({
    id: command.id,
    type: command.payload.type,
    status: command.status,
    createdAt: command.createdAt,
    deliveredAt: command.deliveredAt,
    completedAt: command.completedAt,
    targetClientId: command.targetClientId,
    clientId: command.clientId,
  })),
})

// Wipe all in-memory state. Only reachable via the test-only reset route
// (see `testResetEnabled`). Pending long-poll waiters carry a timeout and
// an open response, so cancel + close those before dropping the maps.
const resetState = (): void => {
  for (const set of waitersByClient.values()) {
    for (const waiter of set) {
      clearTimeout(waiter.timeout)
      try {
        waiter.response.end()
      } catch {
        /* response already closed */
      }
    }
  }
  clients.clear()
  commands.clear()
  pendingByClient.clear()
  waitersByClient.clear()
  tokens.clear()
}

const handleRequest = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> => {
  responseRequests.set(response, request)

  if (!isAllowedOrigin(request.headers.origin)) {
    sendJson(response, 403, {error: 'Origin not allowed'})
    return
  }

  if (request.method === 'OPTIONS') {
    sendEmpty(response)
    return
  }

  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host}`)
  cleanup()

  try {
    if (testResetEnabled && request.method === 'POST' && requestUrl.pathname === '/runtime/test/reset') {
      if (!requireBridgeSecret(request, response)) return
      resetState()
      sendJson(response, 200, {ok: true})
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      if (requestUrl.searchParams.get('detail') === '1') {
        if (!requireBridgeSecret(request, response)) return
        sendJson(response, 200, getStatus())
        return
      }
      sendJson(response, 200, {ok: true})
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/runtime/whoami') {
      const token = extractBearer(request)
      if (!token) {
        sendJson(response, 401, {error: 'Missing bearer token'})
        return
      }
      const entry = tokens.get(token)
      if (!entry) {
        sendJson(response, 401, {error: unknownTokenMessage})
        return
      }
      const client = clients.get(entry.clientId)
      sendJson(response, 200, {
        clientId: entry.clientId,
        audience: entry.audience,
        scope: entry.scope,
        connected: Boolean(client),
        clientLastSeen: client?.lastSeen ?? null,
      })
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/runtime/commands/next') {
      if (!requireBridgeSecret(request, response)) return
      waitForNextCommand(request, requestUrl, response)
      return
    }

    if (request.method === 'POST' && requestUrl.pathname === '/runtime/commands') {
      const token = extractBearer(request)
      if (!token) {
        sendJson(response, 401, {error: 'Missing bearer token. Run `yarn agent connect <token>` first.'})
        return
      }
      const entry = tokens.get(token)
      if (!entry) {
        sendJson(response, 401, {error: unknownTokenMessage})
        return
      }
      const targetClient = clients.get(entry.clientId)
      if (!targetClient) {
        sendJson(response, 503, {error: 'Target client is not currently connected.'})
        return
      }

      const parsed = commandPayloadSchema.safeParse(await readBody(request))
      if (!parsed.success) {
        sendJson(response, 400, {
          error: 'Command body must include a string type',
          issues: parsed.error.issues,
        })
        return
      }
      const payload = parsed.data
      if (entry.scope === 'read-only' && !isReadOnlyCommand(payload)) {
        sendJson(response, 403, {error: `Token scope read-only does not allow command type: ${payload.type}`})
        return
      }

      const command = enqueueCommand(entry.clientId, payload, hashToken(token))
      sendJson(response, 202, {id: command.id, audience: entry.audience})
      return
    }

    const clientMatch = requestUrl.pathname.match(/^\/runtime\/clients\/([^/]+)$/)
    if (request.method === 'POST' && clientMatch) {
      if (!requireBridgeSecret(request, response)) return
      const parsed = registerClientMetadataSchema.safeParse(await readBody(request) ?? {})
      if (!parsed.success) {
        sendJson(response, 400, {
          error: 'Invalid client metadata',
          issues: parsed.error.issues,
        })
        return
      }
      registerClient(clientMatch[1]!, parsed.data)
      sendJson(response, 200, {ok: true})
      return
    }

    const resultMatch = requestUrl.pathname.match(/^\/runtime\/commands\/([^/]+)\/result$/)
    if (request.method === 'POST' && resultMatch) {
      if (!requireBridgeSecret(request, response)) return
      await setCommandResult(resultMatch[1], request, response)
      return
    }

    const commandMatch = requestUrl.pathname.match(/^\/runtime\/commands\/([^/]+)$/)
    if (request.method === 'GET' && commandMatch) {
      const command = commands.get(commandMatch[1])
      if (!command) {
        sendJson(response, 404, {error: `Unknown command: ${commandMatch[1]}`})
        return
      }
      if (!hasBridgeSecret(request)) {
        const token = extractBearer(request)
        if (!token || hashToken(token) !== command.submitterTokenHash) {
          sendJson(response, 401, {error: 'Missing or invalid command status credentials'})
          return
        }
      }

      sendJson(response, 200, {
        id: command.id,
        status: command.status,
        result: command.result,
        clientId: command.clientId,
        targetClientId: command.targetClientId,
        createdAt: command.createdAt,
        deliveredAt: command.deliveredAt,
        completedAt: command.completedAt,
      })
      return
    }

    sendJson(response, 404, {error: 'Not found'})
  } catch (error) {
    sendJson(response, error instanceof HttpError ? error.status : 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const server = http.createServer(handleRequest)

server.listen(port, host, () => {
  console.log(`Agent runtime server listening at http://${host}:${port}`)
  void pairingUrl(bridgeServerUrl()).then(url => {
    console.log(`Pair app with: ${url}`)
  })
})
