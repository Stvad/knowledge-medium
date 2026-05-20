// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { EXTENSION_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { staticDataExtensions } from '@/extensions/staticDataExtensions'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { createAgentRuntimeContext, executeCommand } from '../commands'
import type { AgentRuntimeContext, InstallExtensionResult } from '../protocol'

const WS = 'ws-1'
const USER = {id: 'user-1', name: 'Alice'}
const AGENT_EXTENSIONS_PARENT_ALIAS = 'Agent-installed extensions'

interface Harness {
  h: TestDb
  repo: Repo
  context: AgentRuntimeContext
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  const runtime = resolveFacetRuntimeSync(staticDataExtensions, {
    repo,
    workspaceId: WS,
    safeMode: false,
  })
  repo.setFacetRuntime(runtime)
  const context = createAgentRuntimeContext({repo, runtime, safeMode: false})
  return {h, repo, context}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('agent runtime commands', () => {
  it('installs labelled extensions under an alias-addressable page', async () => {
    const result = await executeCommand({
      commandId: 'install-1',
      type: 'install-extension',
      source: 'export default []',
      label: 'Example extension',
      reload: false,
    }, env.context) as InstallExtensionResult

    const parent = await env.repo.query.aliasLookup({
      workspaceId: WS,
      alias: AGENT_EXTENSIONS_PARENT_ALIAS,
    }).load()
    expect(parent?.content).toBe(AGENT_EXTENSIONS_PARENT_ALIAS)
    expect(parent?.properties[aliasesProp.name]).toEqual([AGENT_EXTENSIONS_PARENT_ALIAS])
    expect(parent?.properties[typesProp.name]).toEqual([PAGE_TYPE])

    const installed = await env.repo.load(result.id)
    expect(installed?.properties[aliasesProp.name]).toEqual(['Example extension'])
    expect(installed?.properties[typesProp.name]).toEqual([EXTENSION_TYPE, PAGE_TYPE])
  })
})
