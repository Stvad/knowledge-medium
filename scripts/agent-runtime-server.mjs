#!/usr/bin/env node
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const port = Number(process.env.AGENT_RUNTIME_PORT ?? 8787)
const host = process.env.AGENT_RUNTIME_HOST ?? '127.0.0.1'
const commandTtlMs = 10 * 60 * 1000

const clients = new Map()
const commands = new Map()
const pendingCommandIds = []
const waiters = new Set()

const now = () => Date.now()

const jsonHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
  'content-type': 'application/json',
}

const sendJson = (response, status, body) => {
  response.writeHead(status, jsonHeaders)
  response.end(JSON.stringify(body))
}

const sendEmpty = (response, status = 204) => {
  response.writeHead(status, jsonHeaders)
  response.end()
}

const readBody = request =>
  new Promise((resolve, reject) => {
    const chunks = []

    request.on('data', chunk => {
      chunks.push(chunk)
    })

    request.on('end', () => {
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

const cleanup = () => {
  const expiresBefore = now() - commandTtlMs

  for (const [id, command] of commands) {
    if (command.createdAt < expiresBefore && command.status !== 'pending') {
      commands.delete(id)
    }
  }

  for (const [id, client] of clients) {
    if (client.lastSeen < now() - 60_000) {
      clients.delete(id)
    }
  }
}

const takePendingCommand = () => {
  while (pendingCommandIds.length) {
    const id = pendingCommandIds.shift()
    const command = commands.get(id)
    if (command?.status === 'pending') {
      return command
    }
  }

  return null
}

const notifyWaiters = () => {
  for (const waiter of Array.from(waiters)) {
    const command = takePendingCommand()
    if (!command) return

    waiters.delete(waiter)
    command.status = 'delivered'
    command.deliveredAt = now()
    command.clientId = waiter.clientId
    clearTimeout(waiter.timeout)
    sendJson(waiter.response, 200, command.payload)
  }
}

const registerClient = (clientId, metadata = {}) => {
  clients.set(clientId, {
    id: clientId,
    metadata,
    lastSeen: now(),
  })
}

const createCommand = payload => {
  const id = randomUUID()
  const commandPayload = {
    ...payload,
    commandId: id,
  }

  const command = {
    id,
    payload: commandPayload,
    status: 'pending',
    createdAt: now(),
    deliveredAt: null,
    completedAt: null,
    clientId: null,
    result: null,
  }

  commands.set(id, command)
  pendingCommandIds.push(id)
  notifyWaiters()
  return command
}

const waitForNextCommand = (request, requestUrl, response) => {
  const clientId = requestUrl.searchParams.get('clientId') || 'anonymous-client'
  const timeoutMs = Math.min(
    Number(requestUrl.searchParams.get('timeoutMs') ?? 25_000),
    60_000,
  )

  registerClient(clientId)

  const command = takePendingCommand()
  if (command) {
    command.status = 'delivered'
    command.deliveredAt = now()
    command.clientId = clientId
    sendJson(response, 200, command.payload)
    return
  }

  const waiter = {
    clientId,
    response,
    timeout: setTimeout(() => {
      waiters.delete(waiter)
      sendJson(response, 200, null)
    }, timeoutMs),
  }

  request.on('close', () => {
    waiters.delete(waiter)
    clearTimeout(waiter.timeout)
  })

  waiters.add(waiter)
}

const setCommandResult = async (id, request, response) => {
  const command = commands.get(id)
  if (!command) {
    sendJson(response, 404, {error: `Unknown command: ${id}`})
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
  })),
  commands: Array.from(commands.values()).map(command => ({
    id: command.id,
    type: command.payload.type,
    status: command.status,
    createdAt: command.createdAt,
    deliveredAt: command.deliveredAt,
    completedAt: command.completedAt,
    clientId: command.clientId,
  })),
})

const handleRequest = async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendEmpty(response)
    return
  }

  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host}`)
  cleanup()

  try {
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(response, 200, getStatus())
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/runtime/commands/next') {
      waitForNextCommand(request, requestUrl, response)
      return
    }

    if (request.method === 'POST' && requestUrl.pathname === '/runtime/commands') {
      const body = await readBody(request)
      if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
        sendJson(response, 400, {error: 'Command body must include a string type'})
        return
      }

      const command = createCommand(body)
      sendJson(response, 202, {id: command.id})
      return
    }

    const clientMatch = requestUrl.pathname.match(/^\/runtime\/clients\/([^/]+)$/)
    if (request.method === 'POST' && clientMatch) {
      registerClient(clientMatch[1], await readBody(request) ?? {})
      sendJson(response, 200, {ok: true})
      return
    }

    const resultMatch = requestUrl.pathname.match(/^\/runtime\/commands\/([^/]+)\/result$/)
    if (request.method === 'POST' && resultMatch) {
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

      sendJson(response, 200, {
        id: command.id,
        status: command.status,
        result: command.result,
        clientId: command.clientId,
        createdAt: command.createdAt,
        deliveredAt: command.deliveredAt,
        completedAt: command.completedAt,
      })
      return
    }

    sendJson(response, 404, {error: 'Not found'})
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const server = http.createServer(handleRequest)

server.listen(port, host, () => {
  console.log(`Agent runtime server listening at http://${host}:${port}`)
})
