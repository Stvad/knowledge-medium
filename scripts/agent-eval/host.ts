/**
 * Serves one fixture graph to the agent bridge as a node runtime, through the
 * same bridge loop a tab runs: the real `kmagent` and km MCP server reach it
 * with the token it registers, and no browser or pairing is involved. The
 * runner starts one per task on a fresh copy of the run's template, so no
 * task's writes reach another (hostProcess.ts).
 *
 *   --seed          imports the fixture into a fresh database: the template
 *   --from <dir>    opens a copy of the template at <dir>
 *
 * The bridge and the token come from AGENT_EVAL_BRIDGE_URL,
 * AGENT_EVAL_BRIDGE_SECRET and AGENT_EVAL_TOKEN. Once registered it prints
 * one `READY_PREFIX {dir}` line. On SIGTERM it closes the database, and a
 * --from host deletes its copy; a --seed host's directory is the template.
 */
import './nodeShims'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createTestDb } from '@/data/test/createTestDb'
import { startBridgeLoop } from '@/plugins/agent-runtime/bridgeLoop'
import { executeCommand } from '@/plugins/agent-runtime/commands'
import { READY_PREFIX } from './hosting'
import { openFixtureRuntime, TEST_USER, TEST_WORKSPACE_ID } from './testGraph'

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const main = async () => {
  const {values} = parseArgs({options: {seed: {type: 'boolean', default: false}, from: {type: 'string'}}})
  if (values.seed === Boolean(values.from)) throw new Error('pass exactly one of --seed and --from <dir>')
  const bridgeUrl = requireEnv('AGENT_EVAL_BRIDGE_URL')
  const secret = requireEnv('AGENT_EVAL_BRIDGE_SECRET')
  const token = requireEnv('AGENT_EVAL_TOKEN')

  const testDb = await createTestDb(values.from ? {from: values.from} : {})
  const runtime = await openFixtureRuntime(testDb.db, {seed: values.seed})
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
    execute: command => executeCommand(command, runtime.context),
    fetch: globalThis.fetch,
  })

  process.once('SIGTERM', () => {
    loop.stop()
    runtime.close()
    void testDb.db.close().finally(() => {
      if (values.from) rmSync(testDb.dir, {recursive: true, force: true})
      process.exit(0)
    })
  })

  await loop.register()
  process.stdout.write(`${READY_PREFIX} ${JSON.stringify({dir: testDb.dir})}\n`)
}

await main()
