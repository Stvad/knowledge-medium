// @vitest-environment happy-dom
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {ChangeScope} from '@/data/api'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {createAgentRuntimeContext, executeCommand} from '../commands'
import type {AgentRuntimeContext} from '../protocol'
import type {ContributorProfile} from '@/plugins/contributors/profiles'
import {attributionCreatorsProp, attributionEditorsProp} from '@/plugins/contributors/schema'
import {userPageBlockId} from '@/data/stateBlocks'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {computeAliasSeatId, ensureAliasTarget} from '@/data/targets'
import {PLAINTEXT_ALIAS_SEATS} from '@/data/test/plaintextAliasSeats'
import {actionsFacet} from '@/extensions/core'
import {contributorsDataExtension} from '@/plugins/contributors/dataExtension'
import {getOrCreatePropertiesPage} from '@/data/propertiesPage'

const WS = 'ws'
let db: TestDb
let context: AgentRuntimeContext
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  const {repo} = createTestRepo({db: db.db, user: {id: 'vlad', name: 'Vlad'}})
  const runtime = resolveFacetRuntimeSync(staticDataExtensions, {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
})
const run = (command: Record<string, unknown>) => executeCommand({commandId: 'test', ...command} as never, context)

describe('agent contributor selection', () => {
  it('permits discovery and profile creation without a preselected contributor', async () => {
    expect(await run({type: 'list-contributors'})).toEqual({contributors: []})
    const profile = await run({type: 'create-contributor', name: 'Atlas', role: 'Researcher'}) as ContributorProfile
    expect(profile).toMatchObject({name: 'Atlas', kind: 'agent', role: 'Researcher', workspaceId: WS})
    expect(await context.repo.query.aliasLookup({alias: 'Atlas', workspaceId: WS}).load()).toMatchObject({id: profile.id})
    expect(await run({type: 'list-contributors'})).toMatchObject({contributors: expect.arrayContaining([
      expect.objectContaining({id: profile.id}),
      expect.objectContaining({id: userPageBlockId(WS, 'vlad'), kind: 'human'}),
    ])})
  })

  it('creates contributor profiles at the shared alias seat and refuses an existing page', async () => {
    const atlas = await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile
    expect(atlas.id).toBe(computeAliasSeatId(PLAINTEXT_ALIAS_SEATS, 'Atlas', WS, 0))
    expect((await context.repo.load(atlas.id))?.updatedAt).toBeGreaterThan(0)
    const existing = await context.repo.withTxContext({contributorId: null}).tx(tx => ensureAliasTarget(
      tx, context.repo, 'Existing', WS,
    ), {scope: ChangeScope.BlockDefault})
    await expect(run({type: 'create-contributor', name: 'Existing'})).rejects.toThrow(/already exists/)
    expect((await context.repo.query.aliasLookup({alias: 'Existing', workspaceId: WS}).load())?.id).toBe(existing.id)
  })

  it('refuses human profiles on external writes before creating the target', async () => {
    const human = await run({type: 'create-contributor', name: 'Alice', kind: 'human'}) as ContributorProfile
    const write = vi.spyOn(context.repo, 'tx')
    for (const contributorId of [human.id, userPageBlockId(WS, 'vlad')]) {
      await expect(run({type: 'create-page', name: 'Must not exist', contributorId})).rejects.toThrow(/agent or automation/)
    }
    expect(write).not.toHaveBeenCalled()
    expect(await context.repo.db.getAll('SELECT id FROM blocks WHERE content = ?', ['Must not exist'])).toEqual([])
  })

  it('allows inspection and watcher setup, but requires a selected actor for meaningful external writes', async () => {
    await run({type: 'eval', code: 'return 1'})
    await run({type: 'watch-events', consumer: 'contributor-test', watchers: []})
    expect(await run({type: 'list-contributors'})).toEqual({contributors: []})
    await expect(run({type: 'create-page', name: 'Unconfigured client'})).rejects.toThrow(/Choose a contributor.*CLI or MCP/)
    expect(await context.repo.db.getAll('SELECT id FROM blocks WHERE content = ?', ['Unconfigured client'])).toEqual([])
    expect(await run({type: 'list-contributors'})).toEqual({contributors: []})
  })

  it('binds schema creation reached through the supplied eval Repo to its contributor', async () => {
    const repo = context.repo
    await getOrCreatePropertiesPage(repo, WS)
    const code = 'return (await repo.userSchemas.addSchema({name: "agent:rating", presetId: "string"})).fieldId'
    await expect(run({type: 'eval', code})).rejects.toThrow(/Choose a contributor/)
    expect(repo.userSchemas.getSchemaBlockId('agent:rating')).toBeUndefined()

    const contributor = await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile
    const id = await run({type: 'eval', code, contributorId: contributor.id}) as string
    expect((await repo.load(id))?.properties[attributionCreatorsProp.name]).toEqual([contributor.id])
    expect(repo.userSchemas.getSchemaBlockId('agent:rating')).toBe(id)
  })

  it.each([undefined, null, 'selected'] as const)('refuses action closures that bypass the command-bound repository (selection: %s)', async selection => {
    const contributorId = selection === 'selected'
      ? (await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile).id
      : selection
    const capturedRepo = context.repo
    const handler = vi.fn(async () => {
      await capturedRepo.tx(tx => tx.create({
        id: 'action-created', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Captured repo write',
      }), {scope: ChangeScope.BlockDefault})
    })
    const runtime = resolveFacetRuntimeSync([staticDataExtensions, actionsFacet.of({
      id: 'test.captured-repo', description: 'Captured repository action', context: 'global', handler,
    })], {repo: capturedRepo, workspaceId: WS, safeMode: false})
    capturedRepo.setFacetRuntime(runtime)
    context = createAgentRuntimeContext({repo: capturedRepo, runtime, safeMode: false})

    for (const type of ['run-action', 'action']) {
      await expect(run({type, id: 'test.captured-repo', contributorId})).rejects.toThrow(/run-action.*Contributors/)
    }
    expect(handler).not.toHaveBeenCalled()
    expect(await capturedRepo.load('action-created')).toBeNull()
  })

  it('keeps action dispatch available when Contributors is disabled', async () => {
    const capturedRepo = context.repo
    const runtime = resolveFacetRuntimeSync([
      staticDataExtensions.filter(extension => extension !== contributorsDataExtension),
      actionsFacet.of({
        id: 'test.captured-repo', description: 'Captured repository action', context: 'global',
        handler: async () => {
          await capturedRepo.tx(tx => tx.create({
            id: 'action-created', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Action write',
          }), {scope: ChangeScope.BlockDefault})
        },
      }),
    ], {repo: capturedRepo, workspaceId: WS, safeMode: false})
    capturedRepo.setFacetRuntime(runtime)
    context = createAgentRuntimeContext({repo: capturedRepo, runtime, safeMode: false})

    await run({type: 'run-action', id: 'test.captured-repo'})

    expect((await capturedRepo.load('action-created'))?.content).toBe('Action write')
  })

  it.each([
    {id: 'unknown', dependencies: undefined, actionContext: 'global', error: /Action not found/},
    {id: 'test.validation', dependencies: 'invalid', actionContext: 'global', error: /dependencies must be an object/},
    {id: 'test.validation', dependencies: {}, actionContext: 'edit-mode-cm', error: /cannot provide editor/},
  ])('preserves action validation for $id in $actionContext with $dependencies', async ({id, dependencies, actionContext, error}) => {
    const handler = vi.fn()
    const repo = context.repo
    const runtime = resolveFacetRuntimeSync([staticDataExtensions, actionsFacet.of({
      id: 'test.validation', description: 'Validate before refusal', context: actionContext, handler,
    })], {repo, workspaceId: WS, safeMode: false})
    repo.setFacetRuntime(runtime)
    context = createAgentRuntimeContext({repo, runtime, safeMode: false})

    await expect(run({type: 'run-action', id, dependencies})).rejects.toThrow(error)
    expect(handler).not.toHaveBeenCalled()
  })

  it('records the selected profile through multi-transaction and eval write paths', async () => {
    const profile = await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile
    const result = await run({type: 'create-page', name: 'Research', contributorId: profile.id}) as {id: string}
    expect((await context.repo.load(result.id))?.properties[attributionCreatorsProp.name]).toEqual([profile.id])
    await run({type: 'eval', contributorId: profile.id, code: 'await block(data.id).setContent("Revised")', data: {id: result.id}})
    expect((await context.repo.load(result.id))?.properties[attributionEditorsProp.name]).toEqual([profile.id])
  })

  it.each(['move-parent', 'move-order', 'delete', 'restore'] as const)(
    'requires a contributor for %s and attributes surviving blocks', async operation => {
      const profile = await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile
      await context.repo.withTxContext({contributorId: null}).tx(async tx => {
        for (const id of ['parent', 'other', 'target', 'sibling']) {
          await tx.create({id, workspaceId: WS, parentId: id === 'target' || id === 'sibling' ? 'parent' : null,
            orderKey: id === 'sibling' ? 'a1' : 'a0', content: id})
        }
        if (operation === 'restore') await tx.delete('target')
      }, {scope: ChangeScope.BlockDefault})
      const readState = () => context.repo.db.get<{parent_id: string | null, order_key: string, deleted: number}>(
        'SELECT parent_id, order_key, deleted FROM blocks WHERE id = ?', ['target'],
      )
      const before = await readState()
      const command = operation.startsWith('move')
        ? {type: 'move-block', id: 'target', parentId: operation === 'move-parent' ? 'other' : 'parent', position: {kind: 'last'}}
        : {type: `${operation}-block`, id: 'target'}
      await expect(run(command)).rejects.toThrow(/Choose a contributor/)
      expect(await readState()).toEqual(before)
      await run({...command, contributorId: profile.id})
      const after = await readState()
      if (operation === 'move-parent') {
        expect(after.parent_id).toBe('other')
      } else if (operation === 'move-order') {
        expect(after.parent_id).toBe(before.parent_id)
        expect(after.order_key).not.toBe(before.order_key)
      } else {
        expect(after.deleted).toBe(operation === 'delete' ? 1 : 0)
      }
      if (operation !== 'delete') {
        expect((await context.repo.load('target'))?.properties[attributionEditorsProp.name]).toEqual([profile.id])
      }
    },
  )

  it('allows an explicitly unattributed deletion', async () => {
    const page = await run({type: 'create-page', name: 'Disposable', contributorId: null}) as {id: string}
    await run({type: 'delete-block', id: page.id, contributorId: null})
    expect(await context.repo.load(page.id)).toBeNull()
  })

  it.each([false, true])('preserves provenance when properties are replaced (children: %s)', async children => {
    if (children) {
      await context.repo.db.execute(`INSERT INTO workspaces
        (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
        VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
    }
    const atlas = await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile
    const scout = await run({type: 'create-contributor', name: 'Scout'}) as ContributorProfile
    const page = await run({type: 'create-page', name: 'Research', contributorId: atlas.id}) as {id: string}
    await run({type: 'update-block', id: page.id, contributorId: atlas.id, content: 'First revision'})
    await run({type: 'update-block', id: page.id, contributorId: scout.id, content: 'Second revision', properties: {}, replaceProperties: true})
    expect((await context.repo.load(page.id))?.properties[attributionCreatorsProp.name]).toEqual([atlas.id])
    expect((await context.repo.load(page.id))?.properties[attributionEditorsProp.name]).toEqual([atlas.id, scout.id])
    await run({type: 'update-block', id: page.id, contributorId: null, content: 'Unattributed revision', properties: {}, replaceProperties: true})
    expect((await context.repo.load(page.id))?.properties[attributionCreatorsProp.name]).toEqual([atlas.id])
    expect((await context.repo.load(page.id))?.properties[attributionEditorsProp.name]).toEqual([atlas.id, scout.id])
  })

  it('requires selection for update-block provenance corrections and validates their profile references', async () => {
    const atlas = await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile
    const scout = await run({type: 'create-contributor', name: 'Scout'}) as ContributorProfile
    const page = await run({type: 'create-page', name: 'Research', contributorId: atlas.id}) as {id: string}
    const correct = {type: 'update-block', id: page.id, properties: {[attributionCreatorsProp.name]: []}}
    await expect(run(correct)).rejects.toThrow(/Choose a contributor/)
    await expect(run({...correct, contributorId: null, properties: {[attributionCreatorsProp.name]: [page.id]}}))
      .rejects.toThrow(/Contributor.*profile.*workspace/)
    expect((await context.repo.load(page.id))?.properties[attributionCreatorsProp.name]).toEqual([atlas.id])

    await run({...correct, contributorId: atlas.id, properties: {[attributionCreatorsProp.name]: [scout.id]}})
    const row = await context.repo.load(page.id)
    expect(row?.properties[attributionCreatorsProp.name]).toEqual([scout.id])
    expect(row?.properties[attributionEditorsProp.name]).toBeUndefined()
  })

  it('leaves explicitly opted-out writes unattributed and does not leak the previous selection', async () => {
    const profile = await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile
    await run({type: 'create-page', name: 'First', contributorId: profile.id})
    await expect(run({type: 'create-page', name: 'Second'})).rejects.toThrow(/Choose a contributor/)
    const result = await run({type: 'create-page', name: 'Third', contributorId: null}) as {id: string}
    expect((await context.repo.load(result.id))?.properties[attributionCreatorsProp.name]).toBeUndefined()
  })
})
