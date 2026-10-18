/**
 * Serves one fixture graph to the agent bridge as a node runtime, through the
 * same bridge loop a tab runs: the real `kmagent` and km MCP server reach it
 * with the token it registers, and no browser or pairing is involved. The
 * runner starts one per task on a fresh copy of the run's template, so no
 * task's writes reach another (hosting.ts).
 *
 *   --seed          imports the fixture into a fresh database: the template
 *   --from <dir>    opens a copy of the template at <dir>
 *
 * The bridge and the token come from AGENT_EVAL_BRIDGE_URL,
 * AGENT_EVAL_BRIDGE_SECRET and AGENT_EVAL_TOKEN. It prints `READY_PREFIX
 * {dir}` once registered, answers each `counts` line on stdin with
 * `COUNTS_PREFIX {type: n}` (the wire commands it has run), and shuts down
 * when stdin closes: it closes the database, and a --from host deletes its
 * copy; a --seed host's directory is the template.
 */
import './nodeShims'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { createTestDb } from '@/data/test/createTestDb'
import { startBridgeLoop } from '@/plugins/agent-runtime/bridgeLoop'
import { executeCommand } from '@/plugins/agent-runtime/commands'
import { TEST_USER, TEST_WORKSPACE_ID } from './fixture'
import { CHILD_ENV, COUNTS_PREFIX, READY_PREFIX } from './hosting'
import { openFixtureRuntime } from './testGraph'

// vite-node loads the checkout's .env files into the environment as it
// starts; `eval` code the agent sends must see only what the runner passed.
const kept = new Set([...CHILD_ENV, 'NODE_OPTIONS', 'AGENT_EVAL_BRIDGE_URL', 'AGENT_EVAL_BRIDGE_SECRET', 'AGENT_EVAL_TOKEN'])
for (const key of Object.keys(process.env)) {
  if (!kept.has(key)) delete process.env[key]
}

/** Read once and removed, so `eval` code cannot read the run's bridge secret. */
const takeEnv = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  delete process.env[name]
  return value
}

const main = async () => {
  const {values} = parseArgs({options: {seed: {type: 'boolean', default: false}, from: {type: 'string'}}})
  if (values.seed === Boolean(values.from)) throw new Error('pass exactly one of --seed and --from <dir>')
  const bridgeUrl = takeEnv('AGENT_EVAL_BRIDGE_URL')
  const secret = takeEnv('AGENT_EVAL_BRIDGE_SECRET')
  const token = takeEnv('AGENT_EVAL_TOKEN')

  const testDb = await createTestDb(values.from ? {from: values.from} : {})
  const runtime = await openFixtureRuntime(testDb.db, {seed: values.seed})
  const commands: Record<string, number> = {}
  const loop = startBridgeLoop({
    clientId: randomUUID(),
    baseUrl: () => bridgeUrl,
    headers: () => ({'x-agent-runtime-secret': secret}),
    registration: () => ({
      activeWorkspaceId: TEST_WORKSPACE_ID,
      currentUser: TEST_USER,
      safeMode: false,
      href: 'node:agent-eval',
      userAgent: `node ${process.version}`,
      audience: {userId: TEST_USER.id, workspaceId: TEST_WORKSPACE_ID},
      focusedAt: null,
      tokens: [{token, label: 'agent-eval', scope: 'read-write', userId: TEST_USER.id}],
    }),
    execute: command => {
      commands[command.type] = (commands[command.type] ?? 0) + 1
      return executeCommand(command, runtime.context)
    },
    fetch: globalThis.fetch,
  })

  createInterface({input: process.stdin})
    .on('line', line => {
      if (line === 'counts') process.stdout.write(`${COUNTS_PREFIX} ${JSON.stringify(commands)}\n`)
    })
    .on('close', () => {
      loop.stop()
      void runtime.close()
        .finally(() => values.from ? testDb.cleanup() : testDb.db.close())
        .then(() => process.exit(0), error => {
          console.error(error)
          process.exit(1)
        })
    })

  await loop.register()
  process.stdout.write(`${READY_PREFIX} ${JSON.stringify({dir: testDb.dir})}\n`)
}

await main()
