#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareContainerRuntime } from './container-runtime.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDir = join(repoRoot, 'supabase', 'migrations')
const testsDir = join(repoRoot, 'supabase', 'tests')
const postgresImage = process.env.CHECK_DB_POSTGRES_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.6.1.121'
const postgresPassword = 'postgres'
const containerName = `knowledge-medium-db-test-${process.pid}`

const env = { ...process.env }

function runCommand(command, commandArgs, options = {}) {
  if (options.log !== false) {
    const displayArgs = options.displayArgs ?? commandArgs
    console.log(`[check:db] ${command} ${displayArgs.join(' ')}`)
  }

  return new Promise((resolve, reject) => {
    const capture = options.capture ?? false
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: options.env ?? env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : (options.stdio ?? 'inherit'),
    })
    let stdout = ''
    let stderr = ''

    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
    }

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve({ code: 0, stdout, stderr })
        return
      }

      if (options.allowFailure) {
        resolve({ code: code ?? 1, stdout, stderr })
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

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('Failed to allocate a local Postgres port'))
        }
      })
    })
  })
}

async function listSqlFiles(dir, predicate = (name) => name.endsWith('.sql')) {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

function postgresUrl(port) {
  return `postgresql://supabase_admin:${postgresPassword}@127.0.0.1:${port}/postgres`
}

function redactedPostgresUrl(port) {
  return `postgresql://supabase_admin:***@127.0.0.1:${port}/postgres`
}

function psqlEnv() {
  return { ...env, PGPASSWORD: postgresPassword }
}

async function waitFor(label, predicate, timeoutMs = 60000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForPostgres(port) {
  const url = postgresUrl(port)
  await waitFor('Postgres to accept connections', async () => {
    const result = await runCommand(
      'psql',
      [url, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', 'select 1'],
      { env: psqlEnv(), capture: true, allowFailure: true, log: false },
    )
    return result.code === 0 && result.stdout.trim() === '1'
  })
}

async function startPostgresContainer(port) {
  const args = [
    'run',
    '--name',
    containerName,
    '-d',
    '-p',
    `127.0.0.1:${port}:5432`,
    '-e',
    `POSTGRES_PASSWORD=${postgresPassword}`,
    postgresImage,
    'postgres',
    '-c',
    'listen_addresses=*',
    '-c',
    'shared_preload_libraries=pg_stat_statements',
    '-c',
    'wal_level=logical',
  ]
  const displayArgs = args.map((arg) => (arg === `POSTGRES_PASSWORD=${postgresPassword}` ? 'POSTGRES_PASSWORD=***' : arg))
  await runCommand('docker', args, { displayArgs })
  startedContainer = true
  await waitForPostgres(port)
}

async function applyMigrations(port) {
  const files = await listSqlFiles(migrationsDir)
  if (files.length === 0) {
    throw new Error('No migration files found in supabase/migrations')
  }

  const url = postgresUrl(port)
  for (const file of files) {
    console.log(`[check:db] Applying ${file}`)
    await runCommand('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-f', file], {
      env: psqlEnv(),
      displayArgs: [redactedPostgresUrl(port), '-X', '-v', 'ON_ERROR_STOP=1', '-f', file],
    })
  }
}

function hasTapFailure(output) {
  return output
    .split(/\r?\n/)
    .some((line) => line.startsWith('not ok') || line.startsWith('Bail out!') || line.startsWith('# Looks like'))
}

async function runSqlTests(port) {
  const files = await listSqlFiles(testsDir, (name) => name.endsWith('.test.sql'))
  if (files.length === 0) {
    throw new Error('No SQL test files found in supabase/tests')
  }

  const url = postgresUrl(port)
  const failures = []
  for (const file of files) {
    console.log(`[check:db] Testing ${file}`)
    const result = await runCommand('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', '-At', '-f', file], {
      env: psqlEnv(),
      capture: true,
      allowFailure: true,
      log: false,
    })

    if (result.stdout) {
      process.stdout.write(result.stdout)
    }
    if (result.stderr) {
      process.stderr.write(result.stderr)
    }

    if (result.code !== 0 || hasTapFailure(result.stdout)) {
      failures.push(file)
    }
  }

  if (failures.length > 0) {
    throw new Error(`SQL test failures: ${failures.join(', ')}`)
  }
}

let exitCode = 0
let runtime = null
let startedContainer = false

try {
  runtime = await prepareContainerRuntime({ env })
  const port = await getFreePort()
  await startPostgresContainer(port)
  await applyMigrations(port)
  await runSqlTests(port)
} catch (error) {
  exitCode = error.exitCode ?? 1
  console.error(`[check:db] ${error.message}`)
} finally {
  if (startedContainer) {
    try {
      await runCommand('docker', ['rm', '-f', containerName])
    } catch (error) {
      console.error(`[check:db] cleanup failed: ${error.message}`)
      if (exitCode === 0) {
        exitCode = error.exitCode ?? 1
      }
    }
  }
  await runtime?.stop()
}

process.exit(exitCode)
