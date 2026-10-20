#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareContainerRuntime } from './container-runtime.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDir = join(repoRoot, 'supabase', 'migrations')
const testsDir = join(repoRoot, 'supabase', 'tests')
// Matches the hosted project's database version (`npx supabase projects list`), not the CLI's default image.
const postgresImage = process.env.CHECK_DB_POSTGRES_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.11.0.003'
// The hosted project's auth and API servers, as a linked checkout records them (supabase/.temp/gotrue-version and
// rest-version).
const gotrueImage = process.env.CHECK_DB_GOTRUE_IMAGE ?? 'public.ecr.aws/supabase/gotrue:v2.189.0'
const postgrestImage = process.env.CHECK_DB_POSTGREST_IMAGE ?? 'public.ecr.aws/supabase/postgrest:v14.5'
// The hosted project's Storage API (`npx supabase services`).
const storageImage = process.env.CHECK_DB_STORAGE_IMAGE ?? 'public.ecr.aws/supabase/storage-api:v1.80.2'
const postgresPassword = 'postgres'
const jwtSecret = 'check-db-throwaway-jwt-secret-of-32-chars-or-more'
const containerName = `knowledge-medium-db-test-${process.pid}`
const gotrueContainerName = `knowledge-medium-auth-test-${process.pid}`
const postgrestContainerName = `knowledge-medium-rest-test-${process.pid}`
const storageContainerName = `knowledge-medium-storage-test-${process.pid}`
// GoTrue, PostgREST and Storage reach Postgres by its address on this network, not its name: socktainer's per-network DNS
// intermittently fails lookups (socktainer/socktainer#253), and GoTrue resolves the host on every connection.
const networkName = containerName
// The tests that need this stack; vitest.config.ts excludes them from `pnpm test`.
const stackTestsConfig = join(repoRoot, 'vitest.supabase.config.ts')
const vitestBin = join(repoRoot, 'node_modules', '.bin', 'vitest')
// Brings the stack up and keeps it until a signal, printing its addresses, so one stack test file can be run against
// it at a time; skips both test suites.
const hold = process.argv.slice(2).includes('--hold')

const env = { ...process.env }

/** An API key for `role`: the HS256 token the gateway hands out, signed with the stack's secret. */
function apiKey(role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const iat = Math.floor(Date.now() / 1000)
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'check-db', role, iat, exp: iat + 24 * 3600 })}`
  return `${unsigned}.${createHmac('sha256', jwtSecret).update(unsigned).digest('base64url')}`
}
const anonKey = apiKey('anon')
const serviceKey = apiKey('service_role')

function runCommand(command, commandArgs, options = {}) {
  const displayArgs = options.displayArgs ?? commandArgs
  if (options.log !== false) {
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
    // 'close', not 'exit': captured output is only complete once the stdio streams close.
    child.on('close', (code, signal) => {
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
          ? `${command} ${displayArgs.join(' ')} exited via ${signal}`
          : `${command} ${displayArgs.join(' ')} exited with code ${code ?? 1}`,
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

function redactedArgs(args) {
  return args.map((arg) =>
    arg === `POSTGRES_PASSWORD=${postgresPassword}` ? 'POSTGRES_PASSWORD=***' : arg.replace(`:${postgresPassword}@`, ':***@'),
  )
}

async function runContainer(name, args) {
  // `docker run` can create the container and then fail to start it, so cleanup is owed from here on;
  // `docker rm -f` exits 0 when the container was never created.
  containersToRemove.push(name)
  const runArgs = ['run', '--name', name, '-d', '--network', networkName, ...args]
  await runCommand('docker', runArgs, { displayArgs: redactedArgs(runArgs) })
}

async function createNetwork() {
  networkMayExist = true
  await runCommand('docker', ['network', 'create', networkName])
}

async function startPostgresContainer(port) {
  await runContainer(containerName, [
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
  ])
  await waitForPostgres(port)
}

async function containerAddress(name) {
  const { stdout } = await runCommand(
    'docker',
    ['inspect', '-f', `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`, name],
    { capture: true },
  )
  const address = stdout.trim()
  if (!address) {
    throw new Error(`${name} has no address on ${networkName}`)
  }
  return address
}

/** Each `-e` pair of a container's environment. */
const envArgs = (vars) => Object.entries(vars).flatMap(([name, value]) => ['-e', `${name}=${value}`])

async function waitForHttp(label, url) {
  await waitFor(label, async () => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok
    } catch {
      return false
    }
  })
}

// The image doesn't give the roles GoTrue, PostgREST and Storage log in as the container's password.
async function setServerRolePasswords(port) {
  const sql = ['authenticator', 'supabase_auth_admin', 'supabase_storage_admin']
    .map((role) => `alter role ${role} with password '${postgresPassword}';`)
    .join(' ')
  await runCommand('psql', [postgresUrl(port), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: psqlEnv(),
    displayArgs: [redactedPostgresUrl(port), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', '<alter role … with password>'],
  })
}

// GoTrue migrates the auth schema as it starts, which is also what makes auth.uid() read the claims PostgREST sets.
async function startGotrue(port, postgresHost) {
  await runContainer(gotrueContainerName, [
    '-p',
    `127.0.0.1:${port}:9999`,
    ...envArgs({
      GOTRUE_API_HOST: '0.0.0.0',
      GOTRUE_API_PORT: '9999',
      API_EXTERNAL_URL: `http://127.0.0.1:${port}`,
      GOTRUE_SITE_URL: `http://127.0.0.1:${port}`,
      GOTRUE_DB_DRIVER: 'postgres',
      GOTRUE_DB_DATABASE_URL: `postgresql://supabase_auth_admin:${postgresPassword}@${postgresHost}:5432/postgres`,
      GOTRUE_JWT_SECRET: jwtSecret,
      // The token's `aud` and `role` claims; PostgREST switches to the role the token names.
      GOTRUE_JWT_AUD: 'authenticated',
      GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
      GOTRUE_MAILER_AUTOCONFIRM: 'true',
    }),
    gotrueImage,
  ])
  await waitForHttp('GoTrue to serve', `http://127.0.0.1:${port}/health`)
}

// Started after the migrations, so its schema cache already holds them.
async function startPostgrest(port, postgresHost) {
  await runContainer(postgrestContainerName, [
    '-p',
    `127.0.0.1:${port}:3000`,
    // The supabase CLI's settings for its PostgREST, which supabase/config.toml doesn't override, except max_rows:
    // capped below the conversion adapter's page sizes, so its reads must page past short responses.
    ...envArgs({
      PGRST_DB_URI: `postgresql://authenticator:${postgresPassword}@${postgresHost}:5432/postgres`,
      PGRST_DB_SCHEMAS: 'public,graphql_public',
      PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
      PGRST_DB_MAX_ROWS: '150',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: jwtSecret,
    }),
    postgrestImage,
  ])
  await waitForHttp('PostgREST to serve', `http://127.0.0.1:${port}/`)
}

// Started before the migrations, as the hosted project's Storage predates every `db push`: Storage creates its own
// tables as it starts, so the migrations' guarded Storage blocks (the attachments bucket, its policies and limit)
// run here instead of skipping.
async function startStorage(port, postgresHost) {
  await runContainer(storageContainerName, [
    '-p',
    `127.0.0.1:${port}:5000`,
    // The supabase CLI's settings for its Storage, with supabase/config.toml's project-wide upload limit.
    ...envArgs({
      DATABASE_URL: `postgresql://supabase_storage_admin:${postgresPassword}@${postgresHost}:5432/postgres`,
      AUTH_JWT_SECRET: jwtSecret,
      ANON_KEY: anonKey,
      SERVICE_KEY: serviceKey,
      FILE_SIZE_LIMIT: String(51 * 1024 * 1024),
      STORAGE_BACKEND: 'file',
      FILE_STORAGE_BACKEND_PATH: '/mnt',
      TENANT_ID: 'stub',
      STORAGE_S3_REGION: 'stub',
      GLOBAL_S3_BUCKET: 'stub',
    }),
    storageImage,
  ])
  await waitForHttp('Storage to serve', `http://127.0.0.1:${port}/status`)
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

/** What a stack test reads to reach the stack. */
const stackTestEnv = ({ port, gotruePort, postgrestPort, storagePort }) => ({
  CHECK_DB_DATABASE_URL: postgresUrl(port),
  CHECK_DB_AUTH_URL: `http://127.0.0.1:${gotruePort}`,
  CHECK_DB_REST_URL: `http://127.0.0.1:${postgrestPort}`,
  CHECK_DB_STORAGE_URL: `http://127.0.0.1:${storagePort}`,
  CHECK_DB_ANON_KEY: anonKey,
  CHECK_DB_SERVICE_KEY: serviceKey,
})

async function runStackTests(stackEnv) {
  await runCommand(vitestBin, ['run', '--config', stackTestsConfig], { env: { ...env, ...stackEnv } })
}

/** Until a signal, whose handler removes the stack. */
async function holdStack(stackEnv) {
  console.log(Object.entries(stackEnv).map(([name, value]) => `export ${name}='${value}'`).join('\n'))
  console.log(`[check:db] holding the stack; run a stack test with those exports and \`vitest run --config ${stackTestsConfig} <file>\`, stop with Ctrl-C`)
  // A pending promise alone lets Node exit; the interval keeps it running.
  await new Promise(() => setInterval(() => {}, 60_000))
}

async function cleanUp(command, args) {
  try {
    await runCommand(command, args)
  } catch (error) {
    console.error(`[check:db] cleanup failed: ${error.message}`)
    if (exitCode === 0) {
      exitCode = error.exitCode ?? 1
    }
  }
}

// Each started container's state and the end of its log, which `docker rm` takes with it: a readiness timeout
// otherwise reads the same whether the machine was slow or the server never came up.
async function reportContainers() {
  for (const name of containersToRemove) {
    await runCommand('docker', ['inspect', '-f', `${name}: {{.State.Status}} (exit {{.State.ExitCode}})`, name], {
      allowFailure: true,
    })
    await runCommand('docker', ['logs', '--tail', '40', name], { allowFailure: true })
  }
}

let cleaningUp = null
/** Runs once, whether the run ends or a signal stops it. */
function cleanUpOnce() {
  cleaningUp ??= (async () => {
    if (containersToRemove.length > 0) {
      await cleanUp('docker', ['rm', '-f', ...containersToRemove])
    }
    if (networkMayExist) {
      await cleanUp('docker', ['network', 'rm', networkName])
    }
    await runtime?.stop()
  })()
  return cleaningUp
}

let exitCode = 0
let runtime = null
let networkMayExist = false
let stopping = false
const containersToRemove = []

for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, async () => {
    stopping = true
    console.error(`[check:db] ${signal}: removing the test containers`)
    await cleanUpOnce()
    process.exit(code)
  })
}

try {
  runtime = await prepareContainerRuntime({ env })
  await createNetwork()
  const port = await getFreePort()
  await startPostgresContainer(port)
  await setServerRolePasswords(port)
  const postgresHost = await containerAddress(containerName)
  const storagePort = await getFreePort()
  await startStorage(storagePort, postgresHost)
  await applyMigrations(port)
  if (!hold) {
    await runSqlTests(port)
  }

  const gotruePort = await getFreePort()
  await startGotrue(gotruePort, postgresHost)
  const postgrestPort = await getFreePort()
  await startPostgrest(postgrestPort, postgresHost)
  const stackEnv = stackTestEnv({ port, gotruePort, postgrestPort, storagePort })
  await (hold ? holdStack(stackEnv) : runStackTests(stackEnv))
} catch (error) {
  exitCode = error.exitCode ?? 1
  if (!stopping) {
    await reportContainers()
  }
  console.error(`[check:db] ${error.message}`)
} finally {
  await cleanUpOnce()
}

process.exit(exitCode)
