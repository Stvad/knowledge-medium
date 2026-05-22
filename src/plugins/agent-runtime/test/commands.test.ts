// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { EXTENSION_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, extensionDescriptionProp, extensionNameProp, typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { staticDataExtensions } from '@/extensions/staticDataExtensions'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { __setCompileImplForTest } from '@/extensions/compileExtensionModule'
import { actionsFacet, appMountsFacet, blockRenderersFacet } from '@/extensions/core'
import { ActionContextTypes } from '@/shortcuts/types'
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
      description: 'A worked example for the agent bridge',
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
    expect(installed?.properties[extensionNameProp.name]).toEqual('Example extension')
    expect(installed?.properties[extensionDescriptionProp.name]).toEqual(
      'A worked example for the agent bridge',
    )
    expect(installed?.properties[aliasesProp.name]).toEqual(['Example extension'])
    expect(installed?.properties[typesProp.name]).toEqual([EXTENSION_TYPE, PAGE_TYPE])
  })

  it('omits extension:description when not provided', async () => {
    const result = await executeCommand({
      commandId: 'install-no-desc',
      type: 'install-extension',
      source: 'export default []',
      label: 'No description',
      reload: false,
    }, env.context) as InstallExtensionResult

    const installed = await env.repo.load(result.id)
    expect(installed?.properties[extensionNameProp.name]).toEqual('No description')
    expect(installed?.properties[extensionDescriptionProp.name]).toBeUndefined()
  })

  it('verify reports actions reached via FacetContribution.enables', async () => {
    // Regression: verify used to call the bare resolveFacetRuntime,
    // which does not walk into `enables`. An extension whose action
    // is contributed via `enables: actionsFacet.of(...)` would
    // verify against a smaller surface than production sees, so the
    // agent would see "no action 'inner.action' installed" even
    // though production registers it. The fix swaps in
    // resolveAppRuntime, which mirrors the production walk.
    //
    // The vitest jsdom env can't resolve `@/extensions/api.js` from
    // inside a Babel-compiled blob URL, so we stub the compile to
    // emit the AppExtension shape directly. The compile is just a
    // text→module step — the rest of the install + verify path is
    // exercised end-to-end.
    const innerAction = {
      id: 'inner.action',
      description: 'Pulled in via enables',
      context: ActionContextTypes.GLOBAL,
      handler: () => {},
    }
    const outerAction = {
      id: 'outer.action',
      description: 'Outer action',
      context: ActionContextTypes.GLOBAL,
      handler: () => {},
    }
    const restore = __setCompileImplForTest(async () => ({
      default: actionsFacet.of(outerAction, {
        enables: actionsFacet.of(innerAction),
      }),
    }))

    try {
      const result = await executeCommand({
        commandId: 'install-verify',
        type: 'install-extension',
        source: 'STUBBED', // ignored — compile is stubbed above
        label: 'Enables verify',
        reload: false,
        verify: true,
      }, env.context) as InstallExtensionResult

      expect(result.verification?.ok).toBe(true)
      const actionIds = result.verification?.actions.map(a => a.id) ?? []
      expect(actionIds).toContain('outer.action')
      expect(actionIds).toContain('inner.action')
    } finally {
      restore()
    }
  })

  it('enable-extension / disable-extension flip the overrides map', async () => {
    // Install a bare extension so we have a block to toggle. reload:false
    // keeps the test from racing with refreshAppRuntime.
    const installed = await executeCommand({
      commandId: 'install-toggle',
      type: 'install-extension',
      source: 'export default []',
      label: 'Toggle target',
      reload: false,
    }, env.context) as InstallExtensionResult

    // Enable by id
    const enableResult = await executeCommand({
      commandId: 'enable-1',
      type: 'enable-extension',
      id: installed.id,
    }, env.context) as {id: string, label: string | null, enabled: boolean, changed: boolean}
    expect(enableResult.id).toBe(installed.id)
    expect(enableResult.enabled).toBe(true)
    expect(enableResult.changed).toBe(true)

    // Re-enabling is a no-op
    const reEnable = await executeCommand({
      commandId: 'enable-2',
      type: 'enable-extension',
      label: 'Toggle target',
    }, env.context) as {changed: boolean, id: string}
    expect(reEnable.id).toBe(installed.id)
    expect(reEnable.changed).toBe(false)

    // Disable removes the override (back to default `false`)
    const disableResult = await executeCommand({
      commandId: 'disable-1',
      type: 'disable-extension',
      id: installed.id,
    }, env.context) as {enabled: boolean, changed: boolean}
    expect(disableResult.enabled).toBe(false)
    expect(disableResult.changed).toBe(true)
  })

  it('enable-extension errors when no extension matches', async () => {
    await expect(executeCommand({
      commandId: 'enable-missing',
      type: 'enable-extension',
      label: 'nonexistent-plugin',
    }, env.context)).rejects.toThrow(/nonexistent-plugin/)
  })

  it('verify lists per-extension contribution ids (renderers, appMounts)', async () => {
    const renderer = () => null
    const Component = () => null
    const restore = __setCompileImplForTest(async () => ({
      default: [
        blockRenderersFacet.of({id: 'demo-renderer', renderer}),
        appMountsFacet.of({id: 'demo-mount', component: Component}),
      ],
    }))

    try {
      const result = await executeCommand({
        commandId: 'install-contributions',
        type: 'install-extension',
        // Distinct content so the compile cache (keyed by content hash)
        // doesn't serve a prior test's stubbed module.
        source: 'STUBBED-renderer-and-mount',
        label: 'Contributions verify',
        reload: false,
        verify: true,
      }, env.context) as InstallExtensionResult

      expect(result.verification?.ok).toBe(true)
      expect(result.verification?.contributions.renderers).toContain('demo-renderer')
      expect(result.verification?.contributions.appMounts).toContain('demo-mount')
    } finally {
      restore()
    }
  })

})
