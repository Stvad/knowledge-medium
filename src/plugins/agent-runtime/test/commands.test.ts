// @vitest-environment happy-dom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { ActionContextTypes, type BlockShortcutDependencies } from '@/shortcuts/types'
import { createAgentRuntimeContext, executeCommand } from '../commands'
import type { AgentRuntimeContext, InstallExtensionResult } from '../protocol'
import { InvalidBlockIdError } from '@/data/blockId'
import type { BlockData } from '@/data/api'
import { PROPERTY_CELL_BACKFILL_ID, propertyCellBackfill } from '@/data/internals/propertyCellBackfill'

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

  // Block-id shape contract (issue #456), through the two bridge commands
  // that accept an id from outside the app. The contract is ENFORCED by the
  // tx engine (@/data/blockId, pinned in txEngine.test.ts) — these commands
  // pre-check only so the error names the command. So this suite is about the
  // agent-facing behaviour of that pair, not about where the guard lives:
  // this `env` is a `createTestRepo` Repo, i.e. `blockIdPolicy: 'any'`, which
  // means the engine-level guard is OFF here and every rejection below is
  // genuinely the commands' own.
  describe('explicit block id validation (issue #456)', () => {
    // Must contain hex LETTERS (not just digits) — .toUpperCase() below
    // needs to actually change the string for the uppercase-rejection case.
    const VALID_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    it('create-block accepts a canonical UUID id and stores it verbatim', async () => {
      const result = await executeCommand({
        commandId: 'create-uuid',
        type: 'create-block',
        data: {id: VALID_ID, content: 'explicit uuid'},
      }, env.context) as BlockData
      expect(result.id).toBe(VALID_ID)
      expect(await env.repo.load(VALID_ID)).toMatchObject({id: VALID_ID, content: 'explicit uuid'})
    })

    it('create-block still auto-mints a UUID when no id is supplied', async () => {
      const result = await executeCommand({
        commandId: 'create-auto',
        type: 'create-block',
        data: {content: 'auto id'},
      }, env.context) as BlockData
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it.each([
      ['not a UUID at all', 'my-block'],
      ['an uppercase UUID', VALID_ID.toUpperCase()],
      ['a UUID with an embedded newline', `${VALID_ID.slice(0, -1)}\n`],
      ['a UUID with an embedded `]`', `${VALID_ID.slice(0, -1)}]`],
    ])('create-block rejects an id that is %s, with no block created', async (_label, id) => {
      await expect(executeCommand({
        commandId: 'create-invalid',
        type: 'create-block',
        data: {id, content: 'must not be created'},
      }, env.context)).rejects.toThrow(InvalidBlockIdError)

      const row = await env.repo.db.getOptional<{id: string}>(
        'SELECT id FROM blocks WHERE content = ?',
        ['must not be created'],
      )
      expect(row).toBeNull()
    })

    it('create-block rejects an invalid explicit id under a parent too (createChild path)', async () => {
      const parent = await executeCommand({
        commandId: 'create-parent',
        type: 'create-block',
        data: {content: 'parent'},
      }, env.context) as BlockData

      await expect(executeCommand({
        commandId: 'create-child-invalid',
        type: 'create-block',
        parentId: parent.id,
        data: {id: 'not-a-uuid', content: 'must not be created'},
      }, env.context)).rejects.toThrow(InvalidBlockIdError)

      const children = await env.repo.query.children({id: parent.id}).load()
      expect(children).toHaveLength(0)
    })

    it('install-extension accepts a canonical UUID id for a brand-new extension', async () => {
      const result = await executeCommand({
        commandId: 'install-uuid',
        type: 'install-extension',
        source: 'export default []',
        id: VALID_ID,
        reload: false,
      }, env.context) as InstallExtensionResult
      expect(result.id).toBe(VALID_ID)
      expect(await env.repo.load(VALID_ID)).toMatchObject({id: VALID_ID})
    })

    it('install-extension rejects a non-UUID id for a brand-new extension, with nothing created', async () => {
      await expect(executeCommand({
        commandId: 'install-invalid',
        type: 'install-extension',
        source: 'export default []',
        id: 'my-plugin',
        reload: false,
      }, env.context)).rejects.toThrow(InvalidBlockIdError)

      // Validation runs before any lookup or write, so not even the
      // "Agent-installed extensions" root page should have been minted.
      const root = await env.repo.query.aliasLookup({
        workspaceId: WS,
        alias: AGENT_EXTENSIONS_PARENT_ALIAS,
      }).load()
      expect(root).toBeNull()
    })

    // Separate clause from the one above, and NOT covered by it: this id is
    // canonical after `.trim()`. install-extension used to trim before
    // validating, so it stored the trimmed id and reported an id different
    // from the string the caller passed — a silent normalization the case
    // policy explicitly refuses elsewhere. Restoring the trim-then-validate
    // order passes every other test in this suite and fails only this one.
    // (An id whose last hex digit is REPLACED by a newline can't pin it: that
    // string trims to 35 characters and is rejected on length either way.)
    it.each([
      ['a trailing newline', `${VALID_ID}\n`],
      ['surrounding spaces', `  ${VALID_ID}  `],
    ])('install-extension rejects an otherwise-canonical id with %s', async (_label, id) => {
      await expect(executeCommand({
        commandId: 'install-untrimmed',
        type: 'install-extension',
        source: 'export default []',
        id,
        reload: false,
      }, env.context)).rejects.toThrow(InvalidBlockIdError)

      expect(await env.repo.load(VALID_ID)).toBeNull()
    })
  })

  // run-backfill's run-detail decoration: the properties-cell backfill's
  // `lastRun` is populated by whoever last entered the pass, and only taken
  // (consumed) here — a caller that never takes it (e.g. the command-palette
  // surface) leaves it sitting there for the NEXT run-backfill call to pick
  // up, however unrelated that call's own outcome is.
  //
  // `repo.runWorkspaceBackfillNow` is mocked in both tests rather than driven
  // for real: its outcome also depends on the property registry priming from
  // an async subscription (`setFacetRuntime`), which upstream's own comment
  // (repo.ts, `propertyRegistryReadyFor`) documents as "UNPINNED BY A TEST —
  // measured green locally, red on CI". `lastRun` itself is populated for
  // real, by calling `propertyCellBackfill.run` directly against a minimal
  // context — the same seam `repo.runWorkspaceBackfillNow` uses internally,
  // without that race.
  describe('run-backfill run detail', () => {
    // The properties pass is flip-THEN-backfill, and this verb runs only the
    // backfill half — so it refuses an un-flipped workspace outright. These
    // cases are about the run-detail decoration, which lives past that refusal.
    const flipWorkspace = () => env.repo.db.execute(
      `INSERT OR REPLACE INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary,
          properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
      [WS, 'flipped', 'user-1'])

    const populateLastRun = () => propertyCellBackfill.run({
      workspaceId: WS,
      getAll: (sql, params) => env.repo.db.getAll(sql, params as unknown[] | undefined),
      tx: (fn, opts) => env.repo.tx(fn, {scope: ChangeScope.BlockDefault, skipUndo: true, ...opts}),
      resolveNameSchema: () => undefined,
    })

    it('refuses the properties pass on a workspace that has not been switched over', async () => {
      // Run in the old order this verb would build machinery nothing recognizes
      // or maintains and report success — the window flip-first exists to
      // delete. Refused rather than routed through the flip: `run-backfill <id>`
      // is generic over backfill ids and has no business owning one runbook.
      await expect(env.context.runBackfill({backfillId: PROPERTY_CELL_BACKFILL_ID}))
        .rejects.toThrow(/switched to property blocks first/i)
    })

    it('decorates a `ran` outcome with the pass\'s own counts', async () => {
      // `lastRun` populated for real; this request's own outcome is mocked
      // 'ran' so the decoration condition takes it.
      await populateLastRun()
      await flipWorkspace()
      const spy = vi.spyOn(env.repo, 'runWorkspaceBackfillNow')
        .mockResolvedValue({outcome: 'ran', undoHistoryCleared: false})
      try {
        const result = await env.context.runBackfill({backfillId: PROPERTY_CELL_BACKFILL_ID})
        expect(result.outcome).toBe('ran')
        expect(result.blocksScanned).toBeDefined()
        expect(result.blocksMaterialized).toBeDefined()
      } finally {
        spy.mockRestore()
      }
    })

    it('does not decorate a non-ran outcome with a stale run left over from an earlier call', async () => {
      // `lastRun` populated for real by an earlier, unconsumed run — the
      // command-palette's shape, which subscribes to progress and never
      // takes it.
      await populateLastRun()
      await flipWorkspace()

      // This request's own outcome never entered the pass.
      const spy = vi.spyOn(env.repo, 'runWorkspaceBackfillNow')
        .mockResolvedValue({outcome: 'held-by-peer', undoHistoryCleared: false})
      try {
        const result = await env.context.runBackfill({backfillId: PROPERTY_CELL_BACKFILL_ID})
        expect(result.outcome).toBe('held-by-peer')
        expect(result.blocksScanned).toBeUndefined()
        expect(result.blocksMaterialized).toBeUndefined()
        expect(result.failures).toBeUndefined()
      } finally {
        spy.mockRestore()
      }
    })
  })
})

// The bridge is the only surface that can aim a kernel mutator at a workspace
// the user does not have open (the UI's blocks come from workspace-scoped
// queries; sync arrival runs no mutators). That matters because the write path
// is NOT workspace-agnostic: field-row recognition resolves the definition
// through the ACTIVE workspace's registry, which fails closed for any other —
// so a delete aimed at a background workspace rewrites property field rows to
// prose instead of leaving their dangling ref intact, detaching the property
// from its owner (#790). Each case asserts the refusal AND that the row is
// untouched, because a refusal after the write would satisfy `rejects` just as
// well.
describe('mutating verbs refuse a target outside the active workspace (#790)', () => {
  const BG = 'ws-bg'
  const BG_ROOT = 'bg-root'

  const seedBackground = async (): Promise<void> => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: BG_ROOT, workspaceId: BG, parentId: null, orderKey: 'a0', content: 'bg body',
      })
      await tx.create({
        id: 'bg-child', workspaceId: BG, parentId: BG_ROOT, orderKey: 'a0', content: 'bg child',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed background workspace'})
  }

  const refusal = /is not the active one/

  it('delete-block refuses and leaves the subtree live', async () => {
    await seedBackground()

    await expect(executeCommand({
      commandId: 'c', type: 'delete-block', blockId: BG_ROOT,
    }, env.context)).rejects.toThrow(refusal)

    expect((await env.repo.load(BG_ROOT))!.deleted).toBe(false)
    expect((await env.repo.load('bg-child'))!.deleted).toBe(false)
  })

  it('update-block refuses and leaves content and properties alone', async () => {
    await seedBackground()

    await expect(executeCommand({
      commandId: 'c', type: 'update-block', blockId: BG_ROOT,
      content: 'rewritten', properties: {injected: 'yes'},
    }, env.context)).rejects.toThrow(refusal)

    const after = (await env.repo.load(BG_ROOT))!
    expect(after.content).toBe('bg body')
    expect(after.properties.injected).toBeUndefined()
  })

  it('restore-block refuses a tombstone in another workspace', async () => {
    await seedBackground()
    // Deleted through the kernel rather than the bridge — the row has to
    // already be a tombstone for restore to be the operation under test.
    await env.repo.mutate.delete({id: BG_ROOT})

    await expect(executeCommand({
      commandId: 'c', type: 'restore-block', blockId: BG_ROOT,
    }, env.context)).rejects.toThrow(refusal)

    // Raw, because `repo.load` filters tombstones out — the same asymmetry
    // that made the first version of this guard a no-op for restore.
    const row = await env.h.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', [BG_ROOT])
    expect(row.deleted).toBe(1)
  })

  it('move-block refuses and leaves the parent edge intact', async () => {
    await seedBackground()

    await expect(executeCommand({
      commandId: 'c', type: 'move-block', blockId: 'bg-child',
      parentId: null, position: {kind: 'last'},
    }, env.context)).rejects.toThrow(refusal)

    expect((await env.repo.load('bg-child'))!.parentId).toBe(BG_ROOT)
  })

  it('create-block refuses a parent in another workspace, minting nothing', async () => {
    await seedBackground()

    await expect(executeCommand({
      commandId: 'c', type: 'create-block', parentId: BG_ROOT, content: 'injected',
    }, env.context)).rejects.toThrow(refusal)

    const children = await env.h.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [BG_ROOT])
    expect(children.map(r => r.id)).toEqual(['bg-child'])
  })

  it('create-block refuses an explicit foreign workspaceId for a root block', async () => {
    await expect(executeCommand({
      commandId: 'c', type: 'create-block', data: {workspaceId: BG, content: 'injected'},
    }, env.context)).rejects.toThrow(refusal)

    const rows = await env.h.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE workspace_id = ?', [BG])
    expect(rows).toEqual([])
  })

  it('reconcile-markdown-subtree refuses a parent in another workspace', async () => {
    await seedBackground()

    await expect(executeCommand({
      commandId: 'c', type: 'reconcile-markdown-subtree',
      parentId: BG_ROOT, markdown: '- injected', key: 'k1',
    }, env.context)).rejects.toThrow(refusal)

    const children = await env.h.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [BG_ROOT])
    expect(children.map(r => r.id)).toEqual(['bg-child'])
  })

  // The refusal must not swallow the verb's own not-found report: a missing id
  // has no workspace to compare, and answering "wrong workspace" for it would
  // send the caller looking for a workspace problem they don't have. Two
  // tests, because the two verbs take different routes to the same rule —
  // update-block compares the row it already read inside its tx, delete-block
  // goes through the shared pre-read, whose "no row, no opinion" branch is
  // pinned only here.
  it('update-block still reports not-found for a missing block', async () => {
    await expect(executeCommand({
      commandId: 'c', type: 'update-block', blockId: 'no-such-block', content: 'x',
    }, env.context)).rejects.toThrow(/not found/)
  })

  it('delete-block still reports not-found for a missing block', async () => {
    await expect(executeCommand({
      commandId: 'c', type: 'delete-block', blockId: 'no-such-block',
    }, env.context)).rejects.toThrow(/does not exist/)
  })

  // The target lookup is async and bridge commands run detached, so the active
  // workspace can move while it is in flight — leaving a target verified
  // against A to be written under B's registry. Driven through the workspace
  // getter, because the switch has to land in one specific gap: after the
  // guard compared the row, before it re-checks its own pin. `reads` is
  // asserted at the end so that if the guard's read count ever changes, this
  // fails loudly instead of quietly exercising a different gap.
  it('refuses when the active workspace moves while the targets are being checked', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'here', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
    }, {scope: ChangeScope.BlockDefault, description: 'seed active block'})

    let reads = 0
    const spy = vi.spyOn(env.repo, 'activeWorkspaceId', 'get')
      .mockImplementation(() => (reads++ >= 2 ? 'ws-elsewhere' : WS))

    try {
      await expect(executeCommand({
        commandId: 'c', type: 'delete-block', blockId: 'here',
      }, env.context)).rejects.toThrow(/active workspace changed/)
    } finally {
      spy.mockRestore()
    }
    expect(reads).toBeGreaterThanOrEqual(3)

    // The row the caller named is still live — the refusal beat the write.
    const row = await env.h.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', ['here'])
    expect(row.deleted).toBe(0)
  })

  // The refusal has to beat the PARSE, not just the write: a doomed request
  // shouldn't pay `parseMarkdownToBlocks` first. Asserted as "the transaction
  // never opened", which is what distinguishes the pre-flight from the in-tx
  // assertion that also (still) guards it.
  it('reconcile-markdown-subtree refuses before opening a transaction', async () => {
    await seedBackground()
    const txSpy = vi.spyOn(env.repo, 'tx')

    await expect(executeCommand({
      commandId: 'c', type: 'reconcile-markdown-subtree',
      parentId: BG_ROOT, markdown: '- a\n- b\n- c', key: 'k2',
    }, env.context)).rejects.toThrow(refusal)

    expect(txSpy).not.toHaveBeenCalled()
    txSpy.mockRestore()
  })

  // `run-action` is the widest route to a kernel mutator — it turns
  // caller-supplied ids into Block facades and hands them to a handler that
  // may call `Block.delete()`. Guarding only the typed verbs would leave the
  // corruption reachable through here (Codex, PR #803 review). The refusal has
  // to land before `invokeAction`, because once a handler runs, its writes are
  // outside our reach — so these assert the handler never ran, not merely that
  // the command rejected.
  describe('run-action', () => {
    let ran: boolean
    let seenBlockId: string | undefined

    const probeAction = {
      id: 'test.probe',
      description: 'records that it was dispatched',
      context: ActionContextTypes.GLOBAL,
      handler: (deps: BlockShortcutDependencies) => {
        ran = true
        seenBlockId = deps.block?.id
      },
    }

    const withProbeAction = (): AgentRuntimeContext => {
      const runtime = resolveFacetRuntimeSync(
        [staticDataExtensions, extensionsDataExtension, actionsFacet.of(probeAction, {source: 'test'})],
        {repo: env.repo, workspaceId: WS, safeMode: false},
      )
      env.repo.setFacetRuntime(runtime)
      return createAgentRuntimeContext({repo: env.repo, runtime, safeMode: false})
    }

    beforeEach(() => { ran = false; seenBlockId = undefined })

    it('refuses a blockId dependency in another workspace before dispatch', async () => {
      await seedBackground()
      const context = withProbeAction()

      await expect(executeCommand({
        commandId: 'c', type: 'run-action', id: 'test.probe',
        dependencies: {blockId: BG_ROOT},
      }, context)).rejects.toThrow(refusal)

      expect(ran).toBe(false)
    })

    it('refuses a foreign id hidden among selectedBlockIds', async () => {
      await seedBackground()
      const context = withProbeAction()
      await env.repo.tx(async tx => {
        await tx.create({id: 'here', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
      }, {scope: ChangeScope.BlockDefault, description: 'seed active block'})

      // The active id first, so a check that only looked at the head of the
      // list — or only at `blockId` — would pass this.
      await expect(executeCommand({
        commandId: 'c', type: 'run-action', id: 'test.probe',
        dependencies: {blockId: 'here', selectedBlockIds: ['here', BG_ROOT]},
      }, context)).rejects.toThrow(refusal)

      expect(ran).toBe(false)
    })

    // The back-compat top-level `blockId` is IGNORED when `dependencies.blockId`
    // is present, so validating it too refused requests whose effective
    // dependencies were entirely local (Codex, PR #803 review). Precedence is
    // decided once now, and the guard reads the chosen id.
    it('ignores a foreign id in a field the fallback chain does not select', async () => {
      await seedBackground()
      const context = withProbeAction()
      await env.repo.tx(async tx => {
        await tx.create({id: 'here', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
      }, {scope: ChangeScope.BlockDefault, description: 'seed active block'})

      await executeCommand({
        commandId: 'c', type: 'run-action', id: 'test.probe',
        dependencies: {blockId: 'here'},
        blockId: BG_ROOT,
      }, context)

      expect(ran).toBe(true)
      expect(seenBlockId).toBe('here')
    })

    // ...but the same field IS validated when nothing outranks it.
    it('refuses a foreign id in the back-compat field when it is the one selected', async () => {
      await seedBackground()
      const context = withProbeAction()

      await expect(executeCommand({
        commandId: 'c', type: 'run-action', id: 'test.probe',
        blockId: BG_ROOT,
      }, context)).rejects.toThrow(refusal)

      expect(ran).toBe(false)
    })

    // A whole multi-select is one deduplicated query, not one read per entry:
    // the protocol puts no bound on `selectedBlockIds`, and the CLI's command
    // timeout is finite.
    it('checks a whole selection in a single query', async () => {
      const context = withProbeAction()
      await env.repo.tx(async tx => {
        await tx.create({id: 'here', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
      }, {scope: ChangeScope.BlockDefault, description: 'seed active block'})
      const spy = vi.spyOn(env.repo.db, 'getAll')

      await executeCommand({
        commandId: 'c', type: 'run-action', id: 'test.probe',
        // Repeats, plus a duplicate of `blockId`, so a per-id implementation
        // would issue six reads where one is needed.
        dependencies: {blockId: 'here', selectedBlockIds: ['here', 'here', 'here', 'here', 'here']},
      }, context)

      const guardReads = spy.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('json_each'))
      expect(guardReads).toHaveLength(1)
      expect(JSON.parse(guardReads[0][1]![0] as string)).toEqual(['here'])
      spy.mockRestore()
      expect(ran).toBe(true)
    })

    it('still dispatches for an active-workspace block', async () => {
      const context = withProbeAction()
      await env.repo.tx(async tx => {
        await tx.create({id: 'here', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
      }, {scope: ChangeScope.BlockDefault, description: 'seed active block'})

      await executeCommand({
        commandId: 'c', type: 'run-action', id: 'test.probe',
        dependencies: {blockId: 'here'},
      }, context)

      expect(ran).toBe(true)
      expect(seenBlockId).toBe('here')
    })
  })
})
