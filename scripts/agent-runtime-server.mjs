#!/usr/bin/env node
import http from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

const port = Number(process.env.AGENT_RUNTIME_PORT ?? 8787)
const host = process.env.AGENT_RUNTIME_HOST ?? '127.0.0.1'
if ((host === '0.0.0.0' || host === '::') && process.env.AGENT_RUNTIME_ALLOW_NETWORK !== 'true') {
  throw new Error('Refusing to expose agent runtime bridge on the network without AGENT_RUNTIME_ALLOW_NETWORK=true')
}
const commandTtlMs = 10 * 60 * 1000
const clientTtlMs = 60_000
const configuredMaxBodyBytes = Number(process.env.AGENT_RUNTIME_MAX_BODY_BYTES ?? 10 * 1024 * 1024)
const maxBodyBytes = Number.isFinite(configuredMaxBodyBytes) && configuredMaxBodyBytes > 0
  ? configuredMaxBodyBytes
  : 10 * 1024 * 1024
const bridgeSecret = process.env.AGENT_RUNTIME_BRIDGE_SECRET?.trim() || randomBytes(32).toString('hex')
const bridgeSecretHeader = 'x-agent-runtime-secret'
const appUrl = process.env.AGENT_RUNTIME_APP_URL?.trim() || 'https://stvad.github.io/knowledge-medium/'
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
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// clientId -> {id, metadata, lastSeen, tokens: Set<token>, audience: {userId, workspaceId, label}|null}
const clients = new Map()
// commandId -> command
const commands = new Map()
// clientId -> [commandId, ...] — per-client FIFO of pending commands
const pendingByClient = new Map()
// clientId -> Set<{response, timeout}>
const waitersByClient = new Map()
// token -> {clientId, audience, scope}
const tokens = new Map()
const responseRequests = new WeakMap()

const now = () => Date.now()

const normalizeOrigin = origin => {
  try {
    return new URL(origin).origin
  } catch {
    return origin
  }
}

const isAllowedOrigin = origin => {
  if (!origin || typeof origin !== 'string') return true
  if (origin === 'null') return false
  const normalized = normalizeOrigin(origin)
  return loopbackOriginPattern.test(normalized) || allowedOrigins.has(normalized)
}

const jsonHeadersFor = response => {
  const request = responseRequests.get(response)
  const headers = {'content-type': 'application/json'}
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

const sendJson = (response, status, body) => {
  response.writeHead(status, jsonHeadersFor(response))
  response.end(JSON.stringify(body))
}

const sendEmpty = (response, status = 204) => {
  response.writeHead(status, jsonHeadersFor(response))
  response.end()
}

const readBody = request =>
  new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0
    let tooLarge = false

    request.on('data', chunk => {
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

const extractBearer = request => {
  const header = request.headers.authorization
  if (!header || typeof header !== 'string') return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

const hashToken = token => createHash('sha256').update(token).digest('hex')

const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer)
}

const hasBridgeSecret = request => {
  const header = request.headers[bridgeSecretHeader]
  return typeof header === 'string' && safeEqual(header, bridgeSecret)
}

const requireBridgeSecret = (request, response) => {
  if (hasBridgeSecret(request)) return true
  sendJson(response, 401, {error: 'Missing or invalid bridge secret'})
  return false
}

const tokenScope = value =>
  value === 'read-only' ? 'read-only' : 'read-write'

const isReadOnlySql = sql =>
  typeof sql === 'string' && /^(select|explain)\b/i.test(sql.trimStart())

const isReadOnlyCommand = command => {
  switch (command.type) {
    case 'ping':
    case 'describe-runtime':
    case 'get-block':
    case 'get-subtree':
      return true
    case 'sql':
      return command.mode !== 'execute' && isReadOnlySql(command.sql)
    default:
      return false
  }
}

const dropClient = clientId => {
  const client = clients.get(clientId)
  if (client) {
    for (const token of client.tokens) tokens.delete(token)
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

const takePendingForClient = clientId => {
  const queue = pendingByClient.get(clientId)
  if (!queue) return null
  while (queue.length) {
    const id = queue.shift()
    const command = commands.get(id)
    if (command?.status === 'pending') return command
  }
  if (queue.length === 0) pendingByClient.delete(clientId)
  return null
}

const tryDeliverToClient = clientId => {
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

const registerClient = (clientId, metadata = {}) => {
  const existing = clients.get(clientId)
  const tokenList = Array.isArray(metadata.tokens) ? metadata.tokens : []
  const audience = metadata.audience && typeof metadata.audience === 'object'
    ? {
        userId: typeof metadata.audience.userId === 'string' ? metadata.audience.userId : null,
        workspaceId: typeof metadata.audience.workspaceId === 'string' ? metadata.audience.workspaceId : null,
      }
    : null

  // Drop tokens the client no longer authorizes
  if (existing) {
    for (const oldToken of existing.tokens) {
      if (!tokenList.some(t => t?.token === oldToken)) {
        tokens.delete(oldToken)
      }
    }
  }

  const tokenSet = new Set()
  for (const entry of tokenList) {
    if (!entry || typeof entry.token !== 'string' || !entry.token) continue
    tokenSet.add(entry.token)
    tokens.set(entry.token, {
      clientId,
      audience: {
        userId: typeof entry.userId === 'string' ? entry.userId : audience?.userId ?? null,
        workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : audience?.workspaceId ?? null,
        label: typeof entry.label === 'string' ? entry.label : null,
      },
      scope: tokenScope(entry.scope),
    })
  }

  // Strip token list from stored metadata so /health doesn't echo
  // secrets back to anyone who can reach the local server.
  const { tokens: _omit, ...publicMetadata } = metadata

  clients.set(clientId, {
    id: clientId,
    metadata: publicMetadata,
    audience,
    lastSeen: now(),
    tokens: tokenSet,
  })
}

const enqueueCommand = (clientId, payload, submitterTokenHash) => {
  const id = randomUUID()
  const commandPayload = {
    ...payload,
    commandId: id,
  }

  const command = {
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

const waitForNextCommand = (request, requestUrl, response) => {
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

  const waiter = {
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

const setCommandResult = async (id, request, response) => {
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

const pairingUrl = () => {
  const url = new URL(appUrl)
  const rawHash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  const separator = rawHash
    ? rawHash.includes('?') ? '&' : '?'
    : '?'
  url.hash = `${rawHash}${separator}agent-runtime-url=${encodeURIComponent(`http://${host}:${port}`)}&agent-runtime-secret=${encodeURIComponent(bridgeSecret)}`
  return url.toString()
}

const handleRequest = async (request, response) => {
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
        sendJson(response, 401, {error: 'Unknown or expired token'})
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
        sendJson(response, 401, {error: 'Unknown or expired token. The client may have disconnected, or the token was revoked.'})
        return
      }
      const targetClient = clients.get(entry.clientId)
      if (!targetClient) {
        sendJson(response, 503, {error: 'Target client is not currently connected.'})
        return
      }

      const body = await readBody(request)
      if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
        sendJson(response, 400, {error: 'Command body must include a string type'})
        return
      }
      if (entry.scope === 'read-only' && !isReadOnlyCommand(body)) {
        sendJson(response, 403, {error: `Token scope read-only does not allow command type: ${body.type}`})
        return
      }

      const command = enqueueCommand(entry.clientId, body, hashToken(token))
      sendJson(response, 202, {id: command.id, audience: entry.audience})
      return
    }

    const clientMatch = requestUrl.pathname.match(/^\/runtime\/clients\/([^/]+)$/)
    if (request.method === 'POST' && clientMatch) {
      if (!requireBridgeSecret(request, response)) return
      registerClient(clientMatch[1], await readBody(request) ?? {})
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
        const entry = token ? tokens.get(token) : null
        if (!entry || entry.clientId !== command.targetClientId || hashToken(token) !== command.submitterTokenHash) {
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
  console.log(`Pair app with: ${pairingUrl()}`)
})
