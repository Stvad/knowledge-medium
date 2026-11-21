// @vitest-environment node
/**
 * Copy over property rows on a child-backed workspace: the text carries what
 * the copying surface draws — a drawn property row with its whole subtree,
 * content nested under its value included — and prunes what it leaves out;
 * `'all'` carries every row.
 *
 *   owner
 *     a
 *     status::  → draft → note under status   (drawn in non-hidden)
 *     secret::  → shh   → note under secret   (outline-skipped)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, seedProperty, type BlockData, type User } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { propertyDisplayProp, type PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { pasteMultilineText } from '@/paste/operations'
import { createSharedBlockActions } from '@/shortcuts/blockActions'
import type { BlockShortcutDependencies } from '@/shortcuts/types'
import { serializeBlock } from './copy'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-property-row-copy'

const statusProp = seedProperty({
  seedKey: 'test/property/copy-status', revision: 1, name: 'copy:status',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const secretProp = seedProperty({
  seedKey: 'test/property/copy-secret', revision: 1, name: 'copy:secret',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault, hidden: true,
})

const NON_HIDDEN: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'non-hidden', panel: 'inherit'}
const NONE: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'none', panel: 'inherit'}

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => vi.unstubAllGlobals())

const valueOf = async (ownerId: string, prop: typeof statusProp): Promise<BlockData> => {
  const fieldRows = await repo.runQuery('core.children', {id: ownerId}) as BlockData[]
  for (const row of fieldRows) {
    if (!row.isFieldForm || !row.referenceTargetId) continue
    const resolution = repo.propertySchemaResolverFor(WS).resolveField(row.referenceTargetId)
    if (resolution.status !== 'resolved' || resolution.schema.name !== prop.name) continue
    const [value] = await repo.runQuery('core.children', {id: row.id}) as BlockData[]
    return value
  }
  throw new Error(`no ${prop.name} value`)
}

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    [statusProp, secretProp].map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
  ]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    await tx.create({id: 'owner', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'owner'})
    await tx.create({id: 'a', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content: 'a'})
  }, {scope: ChangeScope.BlockDefault})
  await vi.waitFor(() => expect(repo.propertySchemas.has(secretProp.name)).toBe(true))
  const owner = repo.block('owner')
  await owner.set(statusProp, 'draft')
  await owner.set(secretProp, 'shh')
  const draft = await valueOf('owner', statusProp)
  const shh = await valueOf('owner', secretProp)
  await repo.tx(async tx => {
    await tx.create({id: 'under-status', workspaceId: WS, parentId: draft.id, orderKey: 'a0', content: 'note under status'})
    await tx.create({id: 'under-secret', workspaceId: WS, parentId: shh.id, orderKey: 'a0', content: 'note under secret'})
  }, {scope: ChangeScope.BlockDefault})
})

const copiedLines = async (properties?: Parameters<typeof serializeBlock>[1]): Promise<string[]> =>
  (await serializeBlock(repo.block('owner'), properties)).markdown.split('\n').map(line => line.trim())

describe('copy of a block with property rows', () => {
  it('carries a drawn property row with its subtree, and prunes an outline-skipped one whole', async () => {
    const lines = await copiedLines(NON_HIDDEN)
    expect(lines).toContain('- draft')
    expect(lines).toContain('- note under status')
    expect(lines).not.toContain('- shh')
    expect(lines).not.toContain('- note under secret')
  })

  it('carries every property row with hidden properties', async () => {
    const lines = await copiedLines('all')
    expect(lines).toContain('- shh')
    expect(lines).toContain('- note under secret')
  })

  it('follows a block\'s own display setting over the surface\'s', async () => {
    await repo.block('owner').set(propertyDisplayProp, 'all')
    expect(await copiedLines(NON_HIDDEN)).toContain('- shh')
  })

  it('carries no property row in mode none, as the outline shows none', async () => {
    for (const properties of [NONE, undefined]) {
      expect(await copiedLines(properties)).toEqual(['- owner', '- a'])
    }
  })

  it('round-trips through a paste: the drawn property comes back, the hidden one does not', async () => {
    const {markdown} = await serializeBlock(repo.block('owner'), NON_HIDDEN)
    await repo.tx(tx => tx.create({id: 'target', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: ''}),
      {scope: ChangeScope.BlockDefault})
    const [pasted] = await pasteMultilineText(markdown, repo.block('target'), repo)
    await vi.waitFor(() => expect(pasted.peekProperty(statusProp)).toBe('draft'))
    expect(pasted.peekProperty(secretProp)).toBeUndefined()
  })
})

describe('the copy actions', () => {
  const runCopy = async (
    action: 'copyBlock' | 'copyBlockWithHiddenProperties',
    propertyDisplay?: PropertyDisplayScopeLevels,
  ): Promise<string> => {
    let text = ''
    vi.stubGlobal('ClipboardItem', class {
      constructor(readonly items: Record<string, Blob>) {}
    })
    vi.stubGlobal('navigator', {clipboard: {
      write: vi.fn(async ([item]: [{items: Record<string, Blob>}]) => { text = await item.items['text/plain'].text() }),
    }})
    const deps = {block: repo.block('owner'), uiStateBlock: repo.block('page'), propertyDisplay} as BlockShortcutDependencies
    await createSharedBlockActions({repo})[action].handler(deps, {kind: 'test'} as never)
    return text
  }

  it('copies what the surface draws', async () => {
    const text = await runCopy('copyBlock', NON_HIDDEN)
    expect(text).toContain('draft')
    expect(text).not.toContain('shh')
  })

  it('copies hidden properties too on the explicit command, whatever the surface draws', async () => {
    expect(await runCopy('copyBlockWithHiddenProperties')).toContain('shh')
  })
})
