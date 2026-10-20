// @vitest-environment happy-dom
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
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
    expect(atlas.id).toBe(computeAliasSeatId('Atlas', WS, 0))
    expect((await context.repo.load(atlas.id))?.updatedAt).toBeGreaterThan(0)
    const existing = await context.repo.withTxContext({contributorId: null}).tx(tx => ensureAliasTarget(
      tx, context.repo, 'Existing', WS,
    ), {scope: ChangeScope.BlockDefault})
    await expect(run({type: 'create-contributor', name: 'Existing'})).rejects.toThrow(/already exists/)
    expect((await context.repo.query.aliasLookup({alias: 'Existing', workspaceId: WS}).load())?.id).toBe(existing.id)
  })

  it('refuses human profiles on external writes before creating the target', async () => {
    const human = await run({type: 'create-contributor', name: 'Alice', kind: 'human'}) as ContributorProfile
    for (const contributorId of [human.id, userPageBlockId(WS, 'vlad')]) {
      await expect(run({type: 'create-page', name: 'Must not exist', contributorId})).rejects.toThrow(/agent or automation/)
    }
    expect(await context.repo.db.getAll('SELECT id FROM blocks WHERE content = ?', ['Must not exist'])).toEqual([])
  })

  it('keeps inspection and watcher setup free of profiles, then attributes legacy client writes as agents', async () => {
    await run({type: 'eval', code: 'return 1'})
    await run({type: 'watch-events', consumer: 'contributor-test', watchers: []})
    expect(await run({type: 'list-contributors'})).toEqual({contributors: []})
    const page = await run({type: 'create-page', name: 'Legacy client'}) as {id: string}
    const profiles = await run({type: 'list-contributors'}) as {contributors: ContributorProfile[]}
    const agent = profiles.contributors.find(profile => profile.name === 'Unconfigured agent')!
    expect(agent).toMatchObject({kind: 'agent', workspaceId: WS})
    expect((await context.repo.load(page.id))?.properties[attributionCreatorsProp.name]).toEqual([agent.id])
    await run({type: 'delete-block', id: agent.id, contributorId: null})
    expect(await context.repo.load(agent.id)).toBeNull()
    const next = await run({type: 'create-page', name: 'Legacy client again'}) as {id: string}
    expect((await context.repo.load(next.id))?.properties[attributionCreatorsProp.name]).toEqual([agent.id])
    expect((await context.repo.load(agent.id))?.deleted).toBe(false)
  })

  it('records the selected profile through multi-transaction and eval write paths', async () => {
    const profile = await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile
    const result = await run({type: 'create-page', name: 'Research', contributorId: profile.id}) as {id: string}
    expect((await context.repo.load(result.id))?.properties[attributionCreatorsProp.name]).toEqual([profile.id])
    await run({type: 'eval', contributorId: profile.id, code: 'await block(data.id).setContent("Revised")', data: {id: result.id}})
    expect((await context.repo.load(result.id))?.properties[attributionEditorsProp.name]).toEqual([profile.id])
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

  it('leaves explicitly opted-out writes unattributed and does not leak the previous selection', async () => {
    const profile = await run({type: 'create-contributor', name: 'Atlas'}) as ContributorProfile
    await run({type: 'create-page', name: 'First', contributorId: profile.id})
    const second = await run({type: 'create-page', name: 'Second'}) as {id: string}
    expect((await context.repo.load(second.id))?.properties[attributionCreatorsProp.name]).not.toContain(profile.id)
    const result = await run({type: 'create-page', name: 'Third', contributorId: null}) as {id: string}
    expect((await context.repo.load(result.id))?.properties[attributionCreatorsProp.name]).toBeUndefined()
  })
})
