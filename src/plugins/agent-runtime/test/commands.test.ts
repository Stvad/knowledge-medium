// @vitest-environment happy-dom

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EXTENSION_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { ChangeScope } from '@/data/api'
import { aliasesProp, extensionDescriptionProp, extensionNameProp, typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { staticDataExtensions } from '@/extensions/staticDataExtensions'
import { extensionsDataExtension } from '@/plugins/extensions-settings/dataExtension'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { __setCompileImplForTest, readApproval } from '@/extensions/compileExtensionModule'
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
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
  })
  const runtime = resolveFacetRuntimeSync([staticDataExtensions, extensionsDataExtension], {
    repo,
    workspaceId: WS,
    safeMode: false,
  })
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  const context = createAgentRuntimeContext({repo, runtime, safeMode: false})
  return {h, repo, context}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

describe('agent runtime commands', () => {
  it('update-block treats soft-deleted blocks as not found', async () => {
    await env.repo.tx(
      async tx => {
        await tx.create({
          id: 'deleted-target',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a0',
          content: 'original',
          properties: {keep: 'yes'},
        })
      },
      {scope: ChangeScope.BlockDefault, description: 'seed deleted update-block target'},
    )
    await env.repo.mutate.delete({id: 'deleted-target'})

    await expect(executeCommand({
      commandId: 'update-deleted',
      type: 'update-block',
      id: 'deleted-target',
      content: 'updated',
      properties: {keep: 'no'},
    }, env.context)).rejects.toThrow(/updateBlock: block deleted-target not found/)

    const row = await env.h.db.get<{content: string; deleted: 0 | 1; properties_json: string}>(
      'SELECT content, deleted, properties_json FROM blocks WHERE id = ?',
      ['deleted-target'],
    )
    expect(row).toMatchObject({
      content: 'original',
      deleted: 1,
    })
    expect(JSON.parse(row!.properties_json)).toEqual({keep: 'yes'})
  })

  it('installs labelled extensions under a per-label container page', async () => {
    const result = await executeCommand({
      commandId: 'install-1',
      type: 'install-extension',
      source: 'export default []',
      label: 'Example extension',
      description: 'A worked example for the agent bridge',
      reload: false,
    }, env.context) as InstallExtensionResult

    const root = await env.repo.query.aliasLookup({
      workspaceId: WS,
      alias: AGENT_EXTENSIONS_PARENT_ALIAS,
    }).load()
    expect(root?.content).toBe(AGENT_EXTENSIONS_PARENT_ALIAS)
    expect(root?.properties[aliasesProp.name]).toEqual([AGENT_EXTENSIONS_PARENT_ALIAS])
    expect(root?.properties[typesProp.name]).toEqual([PAGE_TYPE])

    const installed = await env.repo.load(result.id)
    expect(installed?.properties[extensionNameProp.name]).toEqual('Example extension')
    expect(installed?.properties[extensionDescriptionProp.name]).toEqual(
      'A worked example for the agent bridge',
    )
    // The extension block is identified by extension:name only — no
    // alias, no PAGE_TYPE (keeps its source out of the alias index).
    expect(installed?.properties[aliasesProp.name]).toBeUndefined()
    expect(installed?.properties[typesProp.name]).toEqual([EXTENSION_TYPE])

    // The extension block is nested under a label-named container,
    // which is itself a child of the agent-extensions root. So the
    // shape is: root → container("Example extension") → extension.
    const container = installed?.parentId ? await env.repo.load(installed.parentId) : null
    expect(container?.content).toBe('Example extension')
    expect(container?.parentId).toBe(root?.id)
    expect(container?.properties[typesProp.name]).toEqual([PAGE_TYPE])
    expect(container?.properties[aliasesProp.name]).toBeUndefined()
  })

  it('reuses an existing label container instead of creating a duplicate', async () => {
    // First install creates the container.
    await executeCommand({
      commandId: 'install-nest-1',
      type: 'install-extension',
      source: 'export default []',
      label: 'Shared container',
      reload: false,
    }, env.context) as InstallExtensionResult

    // Second install with the same label updates the existing extension
    // (re-install path) — but if we forced a NEW install with a different
    // id, it should still land under the same container. We can simulate
    // this by inspecting that the root has only one container child
    // after a label-stable update.
    const second = await executeCommand({
      commandId: 'install-nest-2',
      type: 'install-extension',
      source: 'export default [/* v2 */]',
      label: 'Shared container',
      reload: false,
    }, env.context) as InstallExtensionResult

    const root = await env.repo.query.aliasLookup({
      workspaceId: WS,
      alias: AGENT_EXTENSIONS_PARENT_ALIAS,
    }).load()
    expect(root).toBeTruthy()

    const rootChildren = await env.repo.query
      .children({id: root!.id})
      .load() as Array<{id: string, content: string, deleted: boolean}>
    const liveChildren = rootChildren.filter(child => !child.deleted)
    const containers = liveChildren.filter(child => child.content === 'Shared container')
    expect(containers).toHaveLength(1)

    const installed = await env.repo.load(second.id)
    expect(installed?.parentId).toBe(containers[0]!.id)
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
    // The vitest happy-dom env can't resolve `@/…` app modules (e.g.
    // `@/extensions/core.js`) from inside a Babel-compiled blob URL, so
    // we stub the compile to
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
    // enable now also grants the device-local approval (#67), which would
    // otherwise load real Babel + a blob-URL import (unsupported in happy-dom),
    // so stub the compile pipeline to a synthetic module.
    const restore = __setCompileImplForTest(async () => ({default: []}))
    try {
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

      // Re-enabling leaves intent unchanged (but still re-approves the
      // current source — that's how the agent ships an update).
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
    } finally {
      restore()
    }
  })

  it('enable-extension errors when no extension matches', async () => {
    await expect(executeCommand({
      commandId: 'enable-missing',
      type: 'enable-extension',
      label: 'nonexistent-plugin',
    }, env.context)).rejects.toThrow(/nonexistent-plugin/)
  })

  it('uninstall-extension soft-deletes the block', async () => {
    const installed = await executeCommand({
      commandId: 'install-uninstall',
      type: 'install-extension',
      source: 'export default []',
      label: 'Uninstall target',
      reload: false,
    }, env.context) as InstallExtensionResult

    const before = await env.repo.load(installed.id)
    expect(before?.deleted).toBe(false)

    const result = await executeCommand({
      commandId: 'uninstall-1',
      type: 'uninstall-extension',
      label: 'Uninstall target',
    }, env.context) as {id: string, label: string | null, removed: boolean}
    expect(result.id).toBe(installed.id)
    expect(result.label).toBe('Uninstall target')
    expect(result.removed).toBe(true)

    // Soft-delete: the row still exists with deleted=1, so a second lookup
    // by label finds nothing live.
    await expect(executeCommand({
      commandId: 'uninstall-again',
      type: 'uninstall-extension',
      label: 'Uninstall target',
    }, env.context)).rejects.toThrow(/Uninstall target/)
  })

  it('uninstall-extension errors when no extension matches', async () => {
    await expect(executeCommand({
      commandId: 'uninstall-missing',
      type: 'uninstall-extension',
      label: 'nonexistent-plugin',
    }, env.context)).rejects.toThrow(/nonexistent-plugin/)
  })

  it('enable grants a device-local approval; uninstall revokes it (#67)', async () => {
    const restore = __setCompileImplForTest(async () => ({default: []}))
    try {
      const installed = await executeCommand({
        commandId: 'install-trust',
        type: 'install-extension',
        source: 'export default []',
        label: 'Trust target',
        reload: false,
      }, env.context) as InstallExtensionResult

      // Installed but not enabled → no device-local trust yet.
      expect(await readApproval(installed.id)).toBeUndefined()

      await executeCommand({
        commandId: 'enable-trust',
        type: 'enable-extension',
        id: installed.id,
      }, env.context)
      // Enabling pinned the live source on this device — the REAL block
      // content, not '' (findExtensionBlock must carry `content`).
      expect(await readApproval(installed.id)).toMatchObject({
        compilerVersion: '2',
        approvedSource: 'export default []',
      })

      await executeCommand({
        commandId: 'uninstall-trust',
        type: 'uninstall-extension',
        id: installed.id,
      }, env.context)
      // Uninstall dropped the trust grant along with the block.
      expect(await readApproval(installed.id)).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('sql execute refuses a raw write to a synced table (blocks) by default', async () => {
    await env.repo.tx(
      async tx => {
        await tx.create({
          id: 'sql-guard-target',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a0',
          content: 'original',
        })
      },
      {scope: ChangeScope.BlockDefault, description: 'seed sql-guard target'},
    )

    await expect(executeCommand({
      commandId: 'sql-guard-1',
      type: 'sql',
      mode: 'execute',
      sql: 'UPDATE blocks SET content = ? WHERE id = ?',
      params: ['raw-write', 'sql-guard-target'],
    }, env.context)).rejects.toThrow(/refusing to write to synced table "blocks"/)

    // The raw write must never have landed.
    const row = await env.h.db.get<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?',
      ['sql-guard-target'],
    )
    expect(row?.content).toBe('original')
  })

  // SQLite lets a WITH clause prefix DML, so `WITH … UPDATE blocks` is a real
  // raw write whose first token is `WITH` — it used to sail past the guard
  // (PR #386 review). Recursive-CTE READS are the bridge's bread and butter,
  // so they must keep working.
  it('sql refuses a CTE-prefixed write but still allows a CTE-prefixed read', async () => {
    await env.repo.tx(
      async tx => {
        await tx.create({
          id: 'sql-guard-cte',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a0',
          content: 'original',
        })
      },
      {scope: ChangeScope.BlockDefault, description: 'seed sql-guard cte target'},
    )

    await expect(executeCommand({
      commandId: 'sql-guard-cte-1',
      type: 'sql',
      mode: 'execute',
      sql: 'WITH ids AS (SELECT id FROM blocks WHERE id = ?) '
        + 'UPDATE blocks SET content = ? WHERE id IN (SELECT id FROM ids)',
      params: ['sql-guard-cte', 'raw-write'],
    }, env.context)).rejects.toThrow(/refusing to write to synced table "blocks"/)

    const row = await env.h.db.get<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?',
      ['sql-guard-cte'],
    )
    expect(row?.content).toBe('original')

    const read = await executeCommand({
      commandId: 'sql-guard-cte-2',
      type: 'sql',
      mode: 'all',
      sql: 'WITH RECURSIVE up(id) AS (SELECT id FROM blocks WHERE id = ?) SELECT id FROM up',
      params: ['sql-guard-cte'],
    }, env.context)
    expect(read).toEqual([{id: 'sql-guard-cte'}])
  })

  it('sql execute allows the same write once allowSyncedWrite opts in', async () => {
    await env.repo.tx(
      async tx => {
        await tx.create({
          id: 'sql-guard-override',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a0',
          content: 'original',
        })
      },
      {scope: ChangeScope.BlockDefault, description: 'seed sql-guard override target'},
    )

    await executeCommand({
      commandId: 'sql-guard-2',
      type: 'sql',
      mode: 'execute',
      sql: 'UPDATE blocks SET content = ? WHERE id = ?',
      params: ['raw-write', 'sql-guard-override'],
      allowSyncedWrite: true,
    }, env.context)

    const row = await env.h.db.get<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?',
      ['sql-guard-override'],
    )
    expect(row?.content).toBe('raw-write')
  })

  it('sql select and writes to a LOCAL table (block_aliases) are unaffected by the guard', async () => {
    await env.repo.tx(
      async tx => {
        await tx.create({
          id: 'sql-guard-select',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a0',
          content: 'selectable',
        })
      },
      {scope: ChangeScope.BlockDefault, description: 'seed sql-guard select target'},
    )

    // A read against the synced `blocks` table is never a "write" — the
    // guard must not touch it.
    const selectResult = await executeCommand({
      commandId: 'sql-guard-select-1',
      type: 'sql',
      mode: 'all',
      sql: 'SELECT content FROM blocks WHERE id = ?',
      params: ['sql-guard-select'],
    }, env.context) as Array<{content: string}>
    expect(selectResult).toEqual([{content: 'selectable'}])

    // A raw write to a LOCAL derived-index table (not in SYNCED_TABLES)
    // must go through unguarded.
    await executeCommand({
      commandId: 'sql-guard-local-write',
      type: 'sql',
      mode: 'execute',
      sql: 'INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower) VALUES (?, ?, ?, ?)',
      params: ['sql-guard-select', WS, 'Manual Alias', 'manual alias'],
    }, env.context)

    const aliasRow = await env.h.db.get<{alias: string}>(
      'SELECT alias FROM block_aliases WHERE block_id = ?',
      ['sql-guard-select'],
    )
    expect(aliasRow?.alias).toBe('Manual Alias')
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
