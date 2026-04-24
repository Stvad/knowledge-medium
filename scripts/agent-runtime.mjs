#!/usr/bin/env node
import fs from 'node:fs/promises'

const bridgeUrl = (process.env.AGENT_RUNTIME_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const pollIntervalMs = 100
const defaultTimeoutMs = 30_000

const usage = () => `
Usage:
  yarn agent ping
  yarn agent status
  yarn agent sql <all|get|optional|execute> <sql> [paramsJson]
  yarn agent get-block <id>
  yarn agent subtree [rootId] [--include-root]
  yarn agent create-block <json>
  yarn agent update-block <json>
  yarn agent eval <code>
  yarn agent eval --file <path>
  yarn agent raw <json>
`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const parseJson = (value, label) => {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} must be valid JSON`)
  }
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

const submitCommand = async command => {
  const response = await requestJson(`${bridgeUrl}/runtime/commands`, {
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

    case 'status':
      return null

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

  if (args[0] === 'status') {
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
