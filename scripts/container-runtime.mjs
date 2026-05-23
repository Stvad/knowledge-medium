#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const socktainerSocket = join(os.homedir(), '.socktainer', 'container.sock')
const socktainerDockerHost = `unix://${socktainerSocket}`

function commandExists(command, env = process.env) {
  const pathParts = (env.PATH ?? '').split(':').filter(Boolean)
  return pathParts.some((pathPart) => existsSync(join(pathPart, command)))
}

function unixSocketFromDockerHost(dockerHost) {
  return dockerHost?.startsWith('unix://') ? dockerHost.slice('unix://'.length) : null
}

function logCommand(command, commandArgs) {
  console.log(`[container-runtime] ${command} ${commandArgs.join(' ')}`)
}

function runCommand(command, commandArgs, options = {}) {
  if (options.log !== false) {
    logCommand(command, commandArgs)
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      const error = new Error(
        signal
          ? `${command} ${commandArgs.join(' ')} exited via ${signal}`
          : `${command} ${commandArgs.join(' ')} exited with code ${code ?? 1}`,
      )
      error.exitCode = code ?? 1
      reject(error)
    })
  })
}

function pingDockerSocket(socketPath) {
  return new Promise((resolve) => {
    if (!socketPath || !existsSync(socketPath)) {
      resolve(false)
      return
    }

    const request = http.request(
      {
        socketPath,
        path: '/_ping',
        method: 'GET',
        timeout: 1000,
      },
      (response) => {
        response.resume()
        resolve(response.statusCode >= 200 && response.statusCode < 300)
      },
    )

    request.on('error', () => resolve(false))
    request.on('timeout', () => {
      request.destroy()
      resolve(false)
    })
    request.end()
  })
}

async function waitFor(label, predicate, timeoutMs = 30000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for ${label}`)
}

async function ensureAppleContainerSystem(env) {
  try {
    await runCommand('container', ['system', 'status'], { env, stdio: 'ignore', log: false })
    return
  } catch {
    await runCommand('container', ['system', 'start'], { env })
  }
}

async function startSocktainer({ env, managed, logPath }) {
  mkdirSync(dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'a')
  console.log(`[container-runtime] Starting Socktainer; logs: ${logPath}`)
  const child = spawn('socktainer', ['--no-check-compatibility'], {
    cwd: repoRoot,
    detached: !managed,
    env,
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)

  if (!managed) {
    child.unref()
  }

  await waitFor('Socktainer Docker API socket', () => pingDockerSocket(socktainerSocket))
  return child
}

function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function useAppleRuntime({ env, managed, logPath }) {
  if (!commandExists('container', env) || !commandExists('socktainer', env)) {
    throw new Error('Apple Container runtime requested, but container and socktainer must both be installed')
  }

  await ensureAppleContainerSystem(env)

  let managedProcess = null
  if (!(await pingDockerSocket(socktainerSocket))) {
    managedProcess = await startSocktainer({ env, managed, logPath })
    if (managedProcess && managed) {
      managedProcess.on('exit', (code, signal) => {
        if (managedProcess) {
          console.error(
            `[container-runtime] Socktainer exited before cleanup (${signal ?? `code ${code ?? 1}`}); logs: ${logPath}`,
          )
        }
      })
    }
  }

  env.DOCKER_HOST = socktainerDockerHost
  console.log(`[container-runtime] DOCKER_HOST=${env.DOCKER_HOST}`)

  return {
    dockerHost: env.DOCKER_HOST,
    runtime: 'apple',
    stop: async () => {
      const child = managedProcess
      managedProcess = null
      await stopProcess(child)
    },
  }
}

export async function prepareContainerRuntime(options = {}) {
  const env = options.env ?? process.env
  const mode = options.mode ?? env.CHECK_DB_CONTAINER_RUNTIME ?? 'auto'
  const managed = options.managed ?? true
  const logPath = options.logPath ?? join(os.tmpdir(), `knowledge-medium-socktainer-${process.pid}.log`)

  if (mode === 'docker' || mode === 'none') {
    console.log('[container-runtime] Using caller-provided/default Docker runtime.')
    return { dockerHost: env.DOCKER_HOST ?? null, runtime: mode, stop: async () => {} }
  }

  const configuredSocket = unixSocketFromDockerHost(env.DOCKER_HOST)
  if (configuredSocket) {
    if (configuredSocket === socktainerSocket && !(await pingDockerSocket(configuredSocket))) {
      return useAppleRuntime({ env, managed, logPath })
    }

    console.log(`[container-runtime] Using configured DOCKER_HOST=${env.DOCKER_HOST}`)
    return { dockerHost: env.DOCKER_HOST, runtime: 'configured', stop: async () => {} }
  }

  if (mode === 'apple') {
    return useAppleRuntime({ env, managed, logPath })
  }

  if (mode !== 'auto') {
    throw new Error(`Unsupported CHECK_DB_CONTAINER_RUNTIME=${mode}`)
  }

  if (await pingDockerSocket(socktainerSocket)) {
    env.DOCKER_HOST = socktainerDockerHost
    console.log(`[container-runtime] DOCKER_HOST=${env.DOCKER_HOST}`)
    return { dockerHost: env.DOCKER_HOST, runtime: 'apple', stop: async () => {} }
  }

  if (commandExists('container', env) && commandExists('socktainer', env)) {
    return useAppleRuntime({ env, managed, logPath })
  }

  console.log('[container-runtime] DOCKER_HOST is unset; using the default Docker runtime if available.')
  return { dockerHost: null, runtime: 'default', stop: async () => {} }
}

async function main() {
  const mode = process.argv[2] ?? process.env.CHECK_DB_CONTAINER_RUNTIME ?? 'auto'
  const env = { ...process.env }
  const runtime = await prepareContainerRuntime({ env, mode, managed: false })
  console.log(`[container-runtime] Ready (${runtime.runtime}).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(`[container-runtime] ${error.message}`)
    process.exit(error.exitCode ?? 1)
  }
}
