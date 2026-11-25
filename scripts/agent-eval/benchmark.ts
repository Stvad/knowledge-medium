/** Times the installed CLI entry point and a persistent MCP stdio session against the same graph. */
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import type {OutlineView} from '@/plugins/agent-runtime/agentViews/outline'
import type {SearchView} from '@/plugins/agent-runtime/agentViews/search'
import {PROJECT_PAGE, PRICING_FAQ_TODO, READING_LOG_ENTRIES, READING_LOG_PAGE, TEST_WORKSPACE_ID} from './fixture'
import {AGENT_CLI_DIST, childEnv, startBridge, startHost, type Bridge, type HostedGraph} from './hosting'

const operations = [
  {tool: 'search', ref: 'Kestrel'},
  {tool: 'subtree', ref: PROJECT_PAGE},
  {tool: 'subtree', ref: READING_LOG_PAGE},
] as const
type Operation = typeof operations[number]

const verify = ({tool, ref}: Operation, text: string) => {
  if (tool === 'search') {
    const {hits} = JSON.parse(text) as SearchView
    assert(hits.some(hit => hit.snippet.includes(ref)))
  } else {
    const {root, rows} = JSON.parse(text) as OutlineView
    assert.equal(root.content, ref)
    if (ref === READING_LOG_PAGE) {
      assert.equal(root.childCount, READING_LOG_ENTRIES)
      assert(rows.some(row => row.content.includes('recommended by')))
    } else {
      assert(rows.some(row => row.content.includes(PRICING_FAQ_TODO)))
    }
  }
}

const repetitions = 20
const measure = async (surface: string, read: (op: Operation) => Promise<string>) => {
  const rows = []
  for (const op of operations) {
    verify(op, await read(op))
    const samples = []
    let bytes = 0
    for (let n = 0; n < repetitions; n++) {
      const start = performance.now()
      const text = await read(op)
      samples.push(performance.now() - start)
      verify(op, text)
      bytes = Buffer.byteLength(text)
    }
    samples.sort((a, b) => a - b)
    const middle = Math.floor(samples.length / 2)
    const median = (samples[middle - 1] + samples[middle]) / 2
    rows.push({surface, tool: op.tool, target: op.ref, samples: repetitions,
      medianMs: +median.toFixed(1), p95Ms: +samples[Math.ceil(repetitions * 0.95) - 1].toFixed(1), bytes})
  }
  console.table(rows)
}

const dir = await mkdtemp(path.join(tmpdir(), 'km-agent-benchmark-'))
const client = new Client({name: 'agent-benchmark', version: '1'})
let bridge: Bridge | undefined
let host: HostedGraph | undefined
try {
  bridge = await startBridge(path.join(dir, 'bridge'))
  host = await startHost({bridge, tmpDir: dir, log: path.join(dir, 'host.log')})
  const env = childEnv({AGENT_RUNTIME_URL: bridge.url, AGENT_RUNTIME_TOKEN: host.token, AGENT_RUNTIME_CONFIG_DIR: dir})
  const run = promisify(execFile)
  await measure('CLI', async ({tool, ref}) => {
    const args = [path.join(AGENT_CLI_DIST, 'cli.js'), tool, ref, '--workspace', TEST_WORKSPACE_ID, '--json']
    return (await run(process.execPath, args, {env})).stdout
  })

  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(AGENT_CLI_DIST, 'mcp.js')], env: env as Record<string, string>,
  })
  const start = performance.now()
  await client.connect(transport)
  console.log(`MCP handshake ${(performance.now() - start).toFixed(1)} ms`)
  await measure('MCP', async ({tool, ref}) => {
    const args = {workspaceId: TEST_WORKSPACE_ID, format: 'json', [tool === 'search' ? 'query' : 'ref']: ref}
    const result = await client.callTool({name: tool, arguments: args})
    assert(!result.isError && Array.isArray(result.content), `Failed to read ${ref}`)
    return result.content.map(part => part.text).join('')
  })
} finally {
  await client.close()
  await host?.stop()
  bridge?.stop()
}
// Keep the relay and host logs available if startup or verification failed.
await rm(dir, {recursive: true, force: true})
