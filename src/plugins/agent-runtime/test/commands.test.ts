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
import {
  __setCompileImplForTest,
  __setTranspileImplForTest,
  readApproval,
} from '@/extensions/compileExtensionModule'
import { getCompiledModuleCache } from '@/extensions/compiledModuleCache'
import { actionsFacet, appMountsFacet, blockRenderersFacet } from '@/extensions/core'
import { definitionSeedsFacet, valuePresetCoresFacet } from '@/data/facets'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { getPluginPrefsBlock } from '@/data/stateBlocks'
import { extensionsOverridesProp, extensionsPrefsType } from '@/plugins/extensions-settings/config'
import { userToggle } from '@/facets/togglable'
import { codecs, definePresetCore, type Codec } from '@/data/api'
import { seedProperty } from '@/data/propertySeeds'
import { extensionPropertySeedKey } from '@/extensions/dynamicExtensionSeeds'
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
  describe('value preset identity at install', () => {
    const RATING = 'demo:rating'
    const numberRating = definePresetCore<number>({
      id: RATING, build: () => codecs.number, defaultValue: 0,
    })
    const stringRating = definePresetCore<string>({
      id: RATING, build: () => codecs.string, defaultValue: '',
    })

    /** `demo:rating` starts out registered as a number, the way a running
     *  earlier version of this extension would have left it, with one
     *  definition using it. */
    const registerNumberRatingWithDefinition = async (): Promise<void> => {
      env.repo.setRuntimeContributions(valuePresetCoresFacet, 'installed-extension', [numberRating])
      await getOrCreatePropertiesPage(env.repo, WS)
      await env.repo.userSchemas.addSchema({name: 'demo-rating', presetId: RATING})
    }

    const compileTo = (extension: unknown) =>
      __setCompileImplForTest(async () => ({default: extension}))

    const install = (commandId: string, extra: Record<string, unknown> = {}) =>
      executeCommand({
        commandId,
        type: 'install-extension',
        source: `STUBBED ${commandId}`, // ignored — compile is stubbed by the caller
        label: 'Ratings',
        reload: false,
        ...extra,
      }, env.context) as Promise<InstallExtensionResult>

    /** Install + enable, so the block is APPROVED on this device — the state in
     *  which the next install re-pins the new source and makes it live. */
    const installApproved = async (extension: unknown): Promise<string> => {
      const restore = compileTo(extension)
      try {
        const installed = await install('install-approved')
        await executeCommand({
          commandId: 'enable-approved',
          type: 'enable-extension',
          id: installed.id,
        }, env.context)
        return installed.id
      } finally {
        restore()
      }
    }

    it('refuses an install that re-types values under a preset it re-registers', async () => {
      await registerNumberRatingWithDefinition()
      const id = await installApproved(valuePresetCoresFacet.of(numberRating))
      const before = (await env.repo.load(id))?.content

      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        await expect(install('install-preset-refuse'))
          .rejects.toThrow(/codec type "number" -> codec type "string"/)
      } finally {
        restore()
      }

      // The refusal wrote nothing. That matters beyond tidiness: storing the
      // new source would change the block's hash and un-pin the approved
      // version, stopping a working extension dead as a side effect of no.
      expect((await env.repo.load(id))?.content).toBe(before)
      expect(await readApproval(id)).not.toBeNull()
    })

    it('installs anyway under allowPresetChange, and reports what it re-typed', async () => {
      await registerNumberRatingWithDefinition()
      await installApproved(valuePresetCoresFacet.of(numberRating))

      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        const result = await install('install-preset-allow', {allowPresetChange: true})
        expect(result.presetChanges?.map(change => change.presetId)).toEqual([RATING])
        expect(result.presetChanges?.[0]?.definitions.map(d => d.name)).toEqual(['demo-rating'])
      } finally {
        restore()
      }
    })

    it('does not execute source this install will not make live', async () => {
      // #67: a first install neither approves nor enables, so nothing it
      // stores runs — and evaluating it to inspect it would defeat the gate it
      // never passed. No conflict can be found, because none can happen yet.
      await registerNumberRatingWithDefinition()
      let compiled = 0
      const restore = __setCompileImplForTest(async () => {
        compiled += 1
        return {default: valuePresetCoresFacet.of(stringRating)}
      })
      try {
        const result = await install('install-preset-unapproved')
        expect(compiled).toBe(0)
        expect(result.presetChanges).toBeUndefined()
      } finally {
        restore()
      }
    })

    it('reports without refusing when --verify finds a conflict that cannot run yet', async () => {
      await registerNumberRatingWithDefinition()
      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        const result = await install('install-preset-verify', {verify: true})
        expect(result.presetChanges?.map(change => change.presetId)).toEqual([RATING])
        expect(result.verification?.ok).toBe(true)
      } finally {
        restore()
      }
    })

    it('sees a core behind a nested toggle the device has switched on', async () => {
      // The extension declares its own `userToggle` for part of itself. It is
      // off by default and ON in this device's overrides, so the app registers
      // the core beneath it — and so must the isolated resolution, or the
      // refusal never fires for anything an extension puts behind a toggle.
      const advanced = userToggle({id: 'demo:advanced', name: 'Advanced ratings'})
      await registerNumberRatingWithDefinition()
      const id = await installApproved(advanced.of([valuePresetCoresFacet.of(numberRating)]))

      const prefsBlock = await getPluginPrefsBlock(
        env.repo, WS, env.repo.user, extensionsPrefsType)
      const overrides = prefsBlock.peekProperty(extensionsOverridesProp)
        ?? new Map<string, boolean>()
      await prefsBlock.set(
        extensionsOverridesProp,
        new Map([...overrides, [advanced.id, true]]),
      )

      const restore = compileTo(advanced.of([valuePresetCoresFacet.of(stringRating)]))
      try {
        await expect(install('install-preset-nested'))
          .rejects.toThrow(/codec type "number" -> codec type "string"/)
      } finally {
        restore()
      }
      expect(await readApproval(id)).not.toBeNull()
    })

    it('refuses when the update DROPS an id it currently registers', async () => {
      // The direction a scan of the candidate cannot see. The new source
      // declares nothing, and the id still changes codec — here to nothing at
      // all, so every definition using it publishes no schema.
      const restoreBase = compileTo(valuePresetCoresFacet.of(numberRating))
      let id: string
      try {
        const installed = await install('install-drop-base')
        await executeCommand({
          commandId: 'enable-drop', type: 'enable-extension', id: installed.id,
        }, env.context)
        id = installed.id
      } finally {
        restoreBase()
      }
      // The running extension's live contribution, sourced at its block — what
      // the registry diff reads to know which ids it would stop claiming.
      env.repo.setRuntimeContributions(valuePresetCoresFacet, `block:${id}`, [numberRating])
      await getOrCreatePropertiesPage(env.repo, WS)
      await env.repo.userSchemas.addSchema({name: 'demo-rating', presetId: RATING})

      const restore = compileTo([])
      try {
        await expect(install('install-drop')).rejects.toThrow(/no core registers this id/)
      } finally {
        restore()
      }
    })

    it('refuses on the core a dropped id falls BACK to, not on its absence', async () => {
      // Same drop, but the block was shadowing a kernel id: the id keeps
      // resolving, to a different codec. Reading the fallback is what tells
      // "cells stop resolving" apart from "cells get re-typed".
      const shadowString = definePresetCore<number>({
        id: 'string', build: () => codecs.number, defaultValue: 0,
      })
      const restoreBase = compileTo(valuePresetCoresFacet.of(shadowString))
      let id: string
      try {
        const installed = await install('install-shadow-base')
        await executeCommand({
          commandId: 'enable-shadow', type: 'enable-extension', id: installed.id,
        }, env.context)
        id = installed.id
      } finally {
        restoreBase()
      }
      env.repo.setRuntimeContributions(valuePresetCoresFacet, `block:${id}`, [shadowString])
      expect(env.repo.valuePresetCores.get('string')).toBe(shadowString)
      await getOrCreatePropertiesPage(env.repo, WS)
      await env.repo.userSchemas.addSchema({name: 'demo-text', presetId: 'string'})

      const restore = compileTo([])
      try {
        await expect(install('install-shadow-drop'))
          .rejects.toThrow(/codec type "number" -> codec type "string"/)
      } finally {
        restore()
      }
    })

    it('does not re-pin in safe mode, where there is no live core to compare', async () => {
      // Safe mode registers no dynamic-extension contribution at all, so the
      // live registry holds none of the cores an install would replace and
      // every id reads as unregistered. Declining the re-pin is what makes
      // that an honest "nothing goes live" instead of a second blind spot:
      // unpinned source runs at no later boot either.
      await registerNumberRatingWithDefinition()
      const id = await installApproved(valuePresetCoresFacet.of(numberRating))
      const pinnedBefore = await readApproval(id)
      const safeModeContext = createAgentRuntimeContext({
        repo: env.repo, runtime: env.context.runtime, safeMode: true,
      })
      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        const result = await executeCommand({
          commandId: 'install-preset-safemode',
          type: 'install-extension',
          source: 'STUBBED safemode',
          label: 'Ratings',
          reload: false,
        }, safeModeContext) as InstallExtensionResult
        expect(result.presetChanges).toBeUndefined()
        // The source is stored, and the device still pins the OLD one.
        expect(await readApproval(id)).toEqual(pinnedBefore)
      } finally {
        restore()
      }
    })

    it('resolves the candidate in NORMAL mode even while the app is in safe mode', async () => {
      // A function-valued extension reads `ctx.safeMode` itself. Handing it the
      // app's value lets it omit the very core the check exists to see. Driven
      // through `--verify`, which is what asks for the evaluation when the
      // install itself makes nothing live.
      await registerNumberRatingWithDefinition()
      await installApproved(valuePresetCoresFacet.of(numberRating))
      const safeModeContext = createAgentRuntimeContext({
        repo: env.repo, runtime: env.context.runtime, safeMode: true,
      })
      const restore = __setCompileImplForTest(async () => ({
        default: (ctx: {safeMode?: boolean}) =>
          ctx.safeMode ? [] : valuePresetCoresFacet.of(stringRating),
      }))
      try {
        const result = await executeCommand({
          commandId: 'install-preset-safemode-verify',
          type: 'install-extension',
          source: 'STUBBED safemode',
          label: 'Ratings',
          reload: false,
          verify: true,
        }, safeModeContext) as InstallExtensionResult
        expect(result.presetChanges?.[0]?.differences).toEqual([
          'codec type "number" -> codec type "string" (at the preset default config)',
        ])
      } finally {
        restore()
      }
    })

    it('refuses rather than checking against overrides it could not read', async () => {
      // An empty override map is not a safe default here: it prunes every
      // boundary that is off by default and on by override, which is exactly
      // where a core can hide.
      await registerNumberRatingWithDefinition()
      await installApproved(valuePresetCoresFacet.of(numberRating))
      const prefsBlock = await getPluginPrefsBlock(
        env.repo, WS, env.repo.user, extensionsPrefsType)
      await env.repo.tx(async tx => {
        const current = await tx.get(prefsBlock.id)
        await tx.update(prefsBlock.id, {
          properties: {...current!.properties, [extensionsOverridesProp.name]: 'not-a-map'},
        })
      }, {scope: ChangeScope.BlockDefault, description: 'corrupt stored overrides'})

      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        await expect(install('install-preset-badprefs'))
          .rejects.toThrow(/extension overrides could not be read/)
      } finally {
        restore()
      }
    })

    it('does not execute an update to an APPROVED but disabled extension', async () => {
      // `disable-extension` deliberately keeps the trust grant, so an approval
      // record is not "this will run". A re-install of a disabled block makes
      // nothing live, and must not evaluate its source to find that out.
      await registerNumberRatingWithDefinition()
      const id = await installApproved(valuePresetCoresFacet.of(numberRating))
      await executeCommand({
        commandId: 'disable-for-exec-gate', type: 'disable-extension', id,
      }, env.context)
      expect(await readApproval(id)).not.toBeNull()

      let compiled = 0
      const restore = __setCompileImplForTest(async () => {
        compiled += 1
        return {default: valuePresetCoresFacet.of(stringRating)}
      })
      try {
        const result = await install('install-disabled')
        expect(compiled).toBe(0)
        expect(result.presetChanges).toBeUndefined()
      } finally {
        restore()
      }
    })

    it('honours --allow-preset-change when the overrides cannot be read', async () => {
      // The refusal advertises the escape hatch, so the escape hatch has to
      // work — otherwise one malformed prefs row blocks every install with no
      // way past it.
      await registerNumberRatingWithDefinition()
      await installApproved(valuePresetCoresFacet.of(numberRating))
      const prefsBlock = await getPluginPrefsBlock(
        env.repo, WS, env.repo.user, extensionsPrefsType)
      await env.repo.tx(async tx => {
        const current = await tx.get(prefsBlock.id)
        await tx.update(prefsBlock.id, {
          properties: {...current!.properties, [extensionsOverridesProp.name]: 'not-a-map'},
        })
      }, {scope: ChangeScope.BlockDefault, description: 'corrupt stored overrides'})

      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        const result = await install('install-badprefs-allowed', {allowPresetChange: true})
        expect(result.id).toBeTruthy()
        // Nothing was checked, so nothing is reported — the override bought a
        // skipped check, not a silent all-clear.
        expect(result.presetChanges).toBeUndefined()
      } finally {
        restore()
      }
    })

    it('folds the candidate into the live registry, so a rival contribution still wins', async () => {
      // The candidate resolved in ISOLATION always names itself the winner for
      // the ids it declares. Folded back into the app's own contribution list
      // at this block's position, a later contribution of the same id keeps
      // winning — and the effective codec does not change at all.
      const restoreBase = compileTo(valuePresetCoresFacet.of(numberRating))
      let id: string
      try {
        const installed = await install('install-rival-base')
        await executeCommand({
          commandId: 'enable-rival', type: 'enable-extension', id: installed.id,
        }, env.context)
        id = installed.id
      } finally {
        restoreBase()
      }
      env.repo.setRuntimeContributions(valuePresetCoresFacet, `block:${id}`, [numberRating])
      // Registered AFTER the block, so it outranks it in the fold — this is the
      // core actually live under the id, before and after.
      env.repo.setRuntimeContributions(valuePresetCoresFacet, 'later-plugin', [numberRating])
      expect(env.repo.valuePresetCores.get(RATING)).toBe(numberRating)
      await getOrCreatePropertiesPage(env.repo, WS)
      await env.repo.userSchemas.addSchema({name: 'demo-rating', presetId: RATING})

      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        const result = await install('install-rival')
        expect(result.presetChanges).toBeUndefined()
      } finally {
        restore()
      }
    })

    it('diffs what a PARTIALLY failed candidate did register', async () => {
      // A module that throws in one function-valued sibling still transpiles,
      // still pins, and still registers the preset core beside it. Errors mean
      // absence proves nothing; presence still does.
      await liveRatingExtension('install-partial')
      const restore = compileTo([
        valuePresetCoresFacet.of(stringRating),
        () => { throw new Error('sibling blew up') },
      ])
      try {
        await expect(install('install-partial'))
          .rejects.toThrow(/codec type "number" -> codec type "string"/)
      } finally {
        restore()
      }
    })

    /** An approved+enabled block already contributing `demo:rating`, with a
     *  definition using it — the state every "what does this update change"
     *  case starts from. */
    const liveRatingExtension = async (commandId: string): Promise<string> => {
      const restoreBase = compileTo(valuePresetCoresFacet.of(numberRating))
      let id: string
      try {
        const installed = await install(`${commandId}-base`)
        await executeCommand({
          commandId: `${commandId}-enable`, type: 'enable-extension', id: installed.id,
        }, env.context)
        id = installed.id
      } finally {
        restoreBase()
      }
      env.repo.setRuntimeContributions(valuePresetCoresFacet, `block:${id}`, [numberRating])
      await getOrCreatePropertiesPage(env.repo, WS)
      await env.repo.userSchemas.addSchema({name: 'demo-rating', presetId: RATING})
      return id
    }

    it('does not diff a source that cannot be PINNED, and reports why', async () => {
      // A source that will not transpile leaves the previous pin — and the code
      // it already runs — in place, so the registry does not move. Diffing the
      // empty runtime would read it as dropping every id the block registers.
      await liveRatingExtension('install-untranspilable')
      const restore = __setTranspileImplForTest(async () => {
        throw new SyntaxError('Unexpected token')
      })
      try {
        const result = await install('install-untranspilable')
        expect(result.presetChanges).toBeUndefined()
        // Reported without `--verify`, so a plain install does not look clean.
        expect(result.verification?.ok).toBe(false)
        expect(result.verification?.errors[0]?.message).toContain('Unexpected token')
      } finally {
        restore()
      }
    })

    it('does not re-pin a source the scan could not transpile', async () => {
      // The skip and the pin have to agree: skipping the diff is justified only
      // by "this cannot be pinned", so pinning it anyway — `approveExtension`
      // transpiles a SECOND time, and a transient failure would not repeat —
      // would make live a core nothing compared.
      const id = await liveRatingExtension('install-nopin')
      const before = await readApproval(id)
      let attempts = 0
      const restore = __setTranspileImplForTest(async () => {
        attempts += 1
        // Transient: the scan's attempt fails, a retry would succeed.
        if (attempts === 1) throw new SyntaxError('transient')
        return 'export default []'
      })
      try {
        await install('install-nopin')
      } finally {
        restore()
      }
      // One attempt only, and the pin is untouched.
      expect(attempts).toBe(1)
      expect(await readApproval(id)).toEqual(before)
    })

    it('refuses an unreadable override map for --verify too', async () => {
      // `--verify` asks for a REPORT, and a report built from an empty override
      // map calls a preset behind a default-off nested toggle absent. "No
      // conflicts" is then a finding the caller acts on and a later enable
      // contradicts. On an EXISTING block: a first install reads no gate at
      // all (see below), so it is the re-install that has something to report.
      await registerNumberRatingWithDefinition()
      await installApproved(valuePresetCoresFacet.of(numberRating))
      const prefsBlock = await getPluginPrefsBlock(
        env.repo, WS, env.repo.user, extensionsPrefsType)
      await env.repo.tx(async tx => {
        const current = await tx.get(prefsBlock.id)
        await tx.update(prefsBlock.id, {
          properties: {...current!.properties, [extensionsOverridesProp.name]: 'not-a-map'},
        })
      }, {scope: ChangeScope.BlockDefault, description: 'corrupt stored overrides'})

      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        await expect(install('install-verify-badprefs', {verify: true}))
          .rejects.toThrow(/extension overrides could not be read/)
      } finally {
        restore()
      }
    })

    it('installs a FIRST install on an unreadable override map', async () => {
      // A block this device has never seen is not running here, and no value
      // is stored under a core it has never registered — so the gates are not
      // read at all and a malformed prefs row cannot block a fresh install.
      const prefsBlock = await getPluginPrefsBlock(
        env.repo, WS, env.repo.user, extensionsPrefsType)
      await env.repo.tx(async tx => {
        const current = await tx.get(prefsBlock.id)
        await tx.update(prefsBlock.id, {
          properties: {...current!.properties, [extensionsOverridesProp.name]: 'not-a-map'},
        })
      }, {scope: ChangeScope.BlockDefault, description: 'corrupt stored overrides'})

      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        const result = await install('install-fresh-badprefs', {verify: true})
        expect(result.inserted).toBe(true)
        expect(result.presetChanges).toBeUndefined()
      } finally {
        restore()
      }
    })

    it("compares a seed against its own previous config, end to end", async () => {
      // The core does not move — the update re-contributes an identical one —
      // and the SEED moves onto a config where that core builds a different
      // codec. The configs come off the isolated resolution's seeds, paired
      // against the live declaration by seedKey.
      const modeCodec: Codec<{mode: string}> = {
        type: 'demo:mode',
        encode: value => ({mode: value.mode}),
        decode: json => ({mode: String((json as {mode?: unknown})?.mode ?? 'wide')}),
      }
      const core = definePresetCore<unknown, {mode: string}>({
        id: RATING,
        build: config => (config.mode === 'narrow' ? codecs.number : codecs.string),
        defaultValue: '',
        defaultConfig: {mode: 'wide'},
        configCodec: modeCodec,
      })
      const seedOn = (seedKey: string, mode: string) =>
        seedProperty<unknown, {mode: string}>({
          seedKey,
          revision: 1,
          name: 'demo:seedcfg-rating',
          preset: core,
          config: {mode},
          // The seed's default encodes through the codec its config selects.
          defaultValue: mode === 'narrow' ? 0 : '',
          changeScope: ChangeScope.BlockDefault,
        })

      // A dynamic extension's seeds carry a block-owned key; the loader
      // rebinds the reserved prefix to the block id before the contribution
      // reaches the runtime, so the live side is registered under that same
      // bound form.
      const restoreBase = compileTo([
        valuePresetCoresFacet.of(core),
        definitionSeedsFacet.of(seedOn(extensionPropertySeedKey('seedcfg'), 'wide')),
      ])
      let id: string
      try {
        const installed = await install('install-seedcfg-base')
        await executeCommand({
          commandId: 'enable-seedcfg', type: 'enable-extension', id: installed.id,
        }, env.context)
        id = installed.id
      } finally {
        restoreBase()
      }
      const boundKey = `${encodeURIComponent(id)}/property/seedcfg`
      env.repo.setRuntimeContributions(valuePresetCoresFacet, `block:${id}`, [core])
      env.repo.setRuntimeContributions(definitionSeedsFacet, `block:${id}`, [
        seedOn(boundKey, 'wide'),
      ])
      await vi.waitFor(() =>
        expect(env.repo.propertyDefinitions?.seedsByKey.has(boundKey)).toBe(true))

      const restore = compileTo([
        valuePresetCoresFacet.of(core),
        definitionSeedsFacet.of(seedOn(extensionPropertySeedKey('seedcfg'), 'narrow')),
      ])
      try {
        await expect(install('install-seedcfg'))
          .rejects.toThrow(/at the config seed "[^"]*\/property\/seedcfg" declares/)
      } finally {
        restore()
      }
    })

    it('refuses when it cannot read whether this device approved the block', async () => {
      // A transient approval-store failure is not a "no". Read as one it would
      // skip the check AND skip the re-pin, so the install reports success and
      // its hint sends the operator to `enable-extension`, which re-pins with
      // no check of its own (#1046) — a refusal turned into a recommendation
      // to do the dangerous thing.
      await registerNumberRatingWithDefinition()
      await installApproved(valuePresetCoresFacet.of(numberRating))
      const readSpy = vi.spyOn(getCompiledModuleCache(), 'read')
        .mockRejectedValue(new Error('IndexedDB transaction aborted'))
      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        await expect(install('install-unreadable-approval'))
          .rejects.toThrow(/approval record could not be read/)
      } finally {
        restore()
        readSpy.mockRestore()
      }
    })

    it('names the load failure that is why the candidate registers less', async () => {
      // A candidate that transpiled and then THREW contributes nothing, which
      // the diff reads as dropping every id it registered. The crash is the
      // cause and the dropped id only its consequence, so a refusal naming the
      // consequence alone sends the reader looking for a preset change that is
      // not there — and its `--allow-preset-change` way out pins a module that
      // does not run.
      const restoreBase = compileTo(valuePresetCoresFacet.of(numberRating))
      let id: string
      try {
        const installed = await install('install-throwing-base')
        await executeCommand({
          commandId: 'enable-throwing', type: 'enable-extension', id: installed.id,
        }, env.context)
        id = installed.id
      } finally {
        restoreBase()
      }
      // The running extension's live contribution, sourced at its block: the
      // id the crashed candidate is read as dropping.
      env.repo.setRuntimeContributions(valuePresetCoresFacet, `block:${id}`, [numberRating])
      await getOrCreatePropertiesPage(env.repo, WS)
      await env.repo.userSchemas.addSchema({name: 'demo-rating', presetId: RATING})

      const restore = __setCompileImplForTest(async () => {
        throw new Error('boom in module top level')
      })
      try {
        await expect(install('install-throwing-module'))
          .rejects.toThrow(/boom in module top level/)
      } finally {
        restore()
      }
    })

    it('refuses a FIRST install whose workspace moved before the write', async () => {
      // The create path mints an extension root, a label container and the
      // block itself, against type registries snapshotted outside the tx. A
      // switch landing in the alias lookup between them would write that whole
      // tree into one workspace off another's snapshot.
      const real = env.repo.snapshotTypeRegistries.bind(env.repo)
      const restore = vi.spyOn(env.repo, 'snapshotTypeRegistries').mockImplementation(() => {
        // The switch lands between the snapshot and the tx that writes off it.
        env.repo.setActiveWorkspaceId('ws-elsewhere')
        return real()
      })
      try {
        await expect(install('install-fresh-ws-switch'))
          .rejects.toThrow(/not the active one/)
      } finally {
        restore.mockRestore()
        env.repo.setActiveWorkspaceId(WS)
      }
    })

    it('refuses when the active workspace moved while the candidate compiled', async () => {
      // The scan reads the CAPTURED workspace's definition rows against the
      // ACTIVE workspace's registry and runtime, both of which a switch
      // re-filters. Comparing the two answers about neither — an
      // extension-owned preset absent from the new workspace reads as
      // "nothing registers this id" — so the install must not proceed on it.
      await registerNumberRatingWithDefinition()
      await installApproved(valuePresetCoresFacet.of(numberRating))

      const restore = __setCompileImplForTest(async () => {
        // The switch lands inside the await the install makes here.
        env.repo.setActiveWorkspaceId('ws-elsewhere')
        return {default: valuePresetCoresFacet.of(stringRating)}
      })
      try {
        await expect(install('install-ws-switch'))
          .rejects.toThrow(/not the active one/)
      } finally {
        restore()
        env.repo.setActiveWorkspaceId(WS)
      }
    })

    it('refuses when the active workspace moves between the scan and the write', async () => {
      // The other half of the same window: the scan has passed, and the switch
      // lands while `repo.tx` waits for the write lock. Without the re-check
      // inside it, the transaction re-pins this workspace's extension off a
      // scan that no longer describes anything.
      await registerNumberRatingWithDefinition()
      await installApproved(valuePresetCoresFacet.of(numberRating))

      const restore = compileTo(valuePresetCoresFacet.of(numberRating))
      // `snapshotTypeRegistries` is the last call before `repo.tx`, so it is
      // the window's near edge.
      const spy = vi.spyOn(env.repo, 'snapshotTypeRegistries').mockImplementation(function (this: Repo) {
        env.repo.setActiveWorkspaceId('ws-elsewhere')
        spy.mockRestore()
        return env.repo.snapshotTypeRegistries()
      })
      try {
        await expect(install('install-ws-late-switch'))
          .rejects.toThrow(/not the active one/)
      } finally {
        restore()
        spy.mockRestore()
        env.repo.setActiveWorkspaceId(WS)
      }
    })

    it('reports an id a PINNABLE candidate drops, even with a failing sibling', async () => {
      // Transpiled is pinned, and pinned takes effect. The resolution ran the
      // same code the reload will, so its absences are real absences — a
      // dropped id must still refuse however the rest of the module fared.
      await liveRatingExtension('install-drop-sibling')
      const restore = compileTo([
        () => { throw new Error('sibling blew up') },
      ])
      try {
        await expect(install('install-drop-sibling'))
          .rejects.toThrow(/no core registers this id/)
      } finally {
        restore()
      }
    })

    it('compares the core that would WIN, when one id is contributed twice', async () => {
      // `valuePresetCoresFacet` is a last-wins keyed map, here and app-wide, so
      // the second contribution is the one that would reach
      // `repo.valuePresetCores`. Comparing the loser would refuse an install
      // over a codec that never gets registered.
      await registerNumberRatingWithDefinition()
      await installApproved(valuePresetCoresFacet.of(numberRating))

      const restore = compileTo([
        valuePresetCoresFacet.of(stringRating),
        valuePresetCoresFacet.of(numberRating),
      ])
      try {
        const result = await install('install-preset-duplicate')
        expect(result.presetChanges).toBeUndefined()
      } finally {
        restore()
      }
    })

    it('installs a preset id nothing is registered under', async () => {
      const restore = compileTo(valuePresetCoresFacet.of(stringRating))
      try {
        const result = await install('install-preset-new', {verify: true})
        expect(result.presetChanges).toBeUndefined()
        expect(result.inserted).toBe(true)
      } finally {
        restore()
      }
    })
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
  // raw write whose first token is `WITH` — it used to sail past the guard.
  // Recursive-CTE READS are the bridge's bread and butter, so they must keep
  // working.
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

  // The operator remedy for a durable materialization gap (km-boj1). The pass
  // itself is pinned against a real observer in `data/test/rematerializeWorkspace`;
  // what belongs HERE is the verb's refusals, which are the whole reason an
  // operator-facing wrapper exists around a Repo method that would otherwise
  // happily run against whatever it was handed.
  describe('rematerialize-workspace', () => {
    it('refuses an empty --workspace rather than falling back to the active one', async () => {
      // `--workspace "$UNSET"` expands to this. The option asserts which graph
      // the pass rewrites, so an empty expansion must fail, not default.
      await expect(env.context.rematerializeWorkspace({workspaceId: '   '}))
        .rejects.toThrow(/empty value/i)
    })

    it('refuses a workspace this client does not have open', async () => {
      // Workspace-scoped maintenance must not touch workspaces nobody opened:
      // materializability, key state and the block cache are all the ACTIVE
      // workspace's, so the option is an assertion, not a target.
      await expect(env.context.rematerializeWorkspace({workspaceId: 'ws-elsewhere'}))
        .rejects.toThrow(/not the active workspace/i)
    })

    it('names an unrecognized scope instead of quietly picking one', async () => {
      // Both scopes are legitimate answers with very different costs, so a
      // typo must not silently resolve to either.
      await expect(env.context.rematerializeWorkspace({scope: 'everything'}))
        .rejects.toThrow(/--scope must be/i)
    })

    it('runs the narrow scope against the active workspace by default', async () => {
      const spy = vi.spyOn(env.repo, 'rematerializeWorkspace')
        .mockResolvedValue({} as Awaited<ReturnType<Repo['rematerializeWorkspace']>>)
      try {
        await env.context.rematerializeWorkspace({})
        expect(spy).toHaveBeenCalledWith(WS, {scope: 'unapplied'})
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
  // corruption reachable through here. The refusal has to land before
  // `invokeAction`, because once a handler runs, its writes are
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
    // dependencies were entirely local. Precedence is decided once now, and
    // the guard reads the chosen id.
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

    // One case per independently guarded dependency: each of these ids reaches
    // a handler that can mutate or navigate through it, so a new one needs its
    // own case here or the guarded set can lose an entry silently.
    it.each([
      ['uiStateBlockId'],
      ['anchorBlockId'],
      ['scopeRootId'],
    ])('refuses a foreign %s', async (dependency) => {
      await seedBackground()
      const context = withProbeAction()

      await expect(executeCommand({
        commandId: 'c', type: 'run-action', id: 'test.probe',
        dependencies: {[dependency]: BG_ROOT},
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
