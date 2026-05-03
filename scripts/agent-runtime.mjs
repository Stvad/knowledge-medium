#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const bridgeUrl = (process.env.AGENT_RUNTIME_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const pollIntervalMs = 100
const defaultTimeoutMs = 30_000
const tokenStorePath = process.env.AGENT_RUNTIME_TOKEN_FILE
  ?? path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'knowledge-medium',
    'agent-token.json',
  )

const usage = () => `
Usage:
  yarn agent connect <token>      persist token (or use AGENT_RUNTIME_TOKEN env)
  yarn agent disconnect           remove the persisted token
  yarn agent whoami               show audience the persisted token resolves to
  yarn agent ping
  yarn agent status
  yarn agent sql <all|get|optional|execute> <sql> [paramsJson]
  yarn agent get-block <id>
  yarn agent subtree [rootId] [--include-root]
  yarn agent create-block <json>
  yarn agent update-block <json>
  yarn agent install-extension <file> [label]
  yarn agent eval <code>
  yarn agent eval --file <path>
  yarn agent raw <json>
`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const parseJson = (value, label) => {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

const loadStoredToken = async () => {
  try {
    const raw = await fs.readFile(tokenStorePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.token === 'string') return parsed.token
    return null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

const writeStoredToken = async token => {
  await fs.mkdir(path.dirname(tokenStorePath), {recursive: true})
  await fs.writeFile(
    tokenStorePath,
    JSON.stringify({token, savedAt: Date.now()}, null, 2),
    {mode: 0o600},
  )
}

const removeStoredToken = async () => {
  try {
    await fs.unlink(tokenStorePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

const resolveToken = async () => {
  const fromEnv = process.env.AGENT_RUNTIME_TOKEN?.trim()
  if (fromEnv) return fromEnv
  return loadStoredToken()
}

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? {'content-type': 'application/json'} : {}),
      ...(options.headers ?? {}),
    },
  })

  const text = await response.text()
  const body = text ? JSON.parse(text) : null

  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with status ${response.status}`)
  }

  return body
}

const authedRequest = async (url, options = {}) => {
  const token = await resolveToken()
  if (!token) {
    throw new Error(
      'No agent token configured. Generate one from the app (palette → "Manage agent runtime tokens"), then run `yarn agent connect <token>`.',
    )
  }

  return requestJson(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  })
}

const submitCommand = async command => {
  const response = await authedRequest(`${bridgeUrl}/runtime/commands`, {
    method: 'POST',
    body: JSON.stringify(command),
  })

  return response.id
}

const waitForCommand = async (id, timeoutMs = defaultTimeoutMs) => {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const command = await requestJson(`${bridgeUrl}/runtime/commands/${id}`)
    if (command.status === 'completed') {
      return command.result
    }
    if (command.status === 'failed') {
      const error = command.result?.error
      throw new Error(error?.message ?? `Runtime command ${id} failed`)
    }

    await sleep(pollIntervalMs)
  }

  throw new Error(`Timed out waiting for runtime command ${id}`)
}

const runCommand = async command => {
  const id = await submitCommand(command)
  const result = await waitForCommand(id)

  if (!result?.ok) {
    const error = result?.error
    throw new Error(error?.message ?? 'Runtime command failed')
  }

  return result.value
}

const commandFromArgs = async args => {
  const [name, ...rest] = args

  switch (name) {
    case 'ping':
      return {type: 'ping'}

    case 'sql': {
      const [mode, sql, paramsJson] = rest
      if (!mode || !sql) {
        throw new Error('sql requires <mode> and <sql>')
      }

      return {
        type: 'sql',
        mode,
        sql,
        params: paramsJson ? parseJson(paramsJson, 'paramsJson') : [],
      }
    }

    case 'get-block': {
      const [id] = rest
      if (!id) throw new Error('get-block requires <id>')
      return {type: 'get-block', id}
    }

    case 'subtree': {
      const includeRoot = rest.includes('--include-root')
      const rootId = rest.find(arg => arg !== '--include-root')
      return {
        type: 'get-subtree',
        rootId,
        includeRoot,
      }
    }

    case 'create-block':
      return {
        type: 'create-block',
        ...parseJson(rest.join(' '), 'create-block json'),
      }

    case 'update-block':
      return {
        type: 'update-block',
        ...parseJson(rest.join(' '), 'update-block json'),
      }

    case 'install-extension': {
      const [file, ...labelParts] = rest
      if (!file) throw new Error('install-extension requires <file>')
      const source = await fs.readFile(file, 'utf8')
      const basename = path.basename(file).replace(/\.[^.]+$/, '')
      return {
        type: 'install-extension',
        source,
        label: labelParts.join(' ').trim() || basename,
      }
    }

    case 'eval': {
      if (rest[0] === '--file') {
        if (!rest[1]) throw new Error('eval --file requires <path>')
        return {
          type: 'eval',
          code: await fs.readFile(rest[1], 'utf8'),
        }
      }

      return {
        type: 'eval',
        code: rest.join(' '),
      }
    }

    case 'raw':
      return parseJson(rest.join(' '), 'raw json')

    default:
      throw new Error(`Unknown command: ${name ?? ''}`)
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage())
    return
  }

  const verb = args[0]

  if (verb === 'connect') {
    const token = args[1]
    if (!token) throw new Error('connect requires a token. Generate one in the app first.')
    await writeStoredToken(token)
    // Resolve audience as a confirmation. Treat connection failures as
    // soft — the token is saved either way; the user will see the
    // problem the next time they actually run a command.
    try {
      const info = await requestJson(`${bridgeUrl}/runtime/whoami`, {
        headers: {authorization: `Bearer ${token}`},
      })
      const audience = info.audience ?? {}
      process.stdout.write(
        `Connected. Token saved at ${tokenStorePath}\n` +
        `User: ${audience.userId ?? '?'}\n` +
        `Workspace: ${audience.workspaceId ?? '?'}\n` +
        `Connected client: ${info.connected ? 'yes' : 'no (will auto-connect when the app reaches the bridge)'}\n`,
      )
    } catch (error) {
      process.stdout.write(
        `Token saved at ${tokenStorePath}, but bridge contact failed: ${error.message}\n` +
        `Make sure the app tab is open. Run \`yarn agent whoami\` to verify.\n`,
      )
    }
    return
  }

  if (verb === 'disconnect') {
    await removeStoredToken()
    process.stdout.write(`Removed ${tokenStorePath}\n`)
    return
  }

  if (verb === 'whoami') {
    const token = await resolveToken()
    if (!token) {
      throw new Error('No agent token configured. Run `yarn agent connect <token>` first.')
    }
    const info = await requestJson(`${bridgeUrl}/runtime/whoami`, {
      headers: {authorization: `Bearer ${token}`},
    })
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`)
    return
  }

  if (verb === 'status') {
    const status = await requestJson(`${bridgeUrl}/health`)
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    return
  }

  const command = await commandFromArgs(args)
  const value = await runCommand(command)
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
