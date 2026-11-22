/** One owner block and one string property in a child-backed workspace, edited
 *  the way a cell or the outline edits it. */
import {ChangeScope, codecs, defineProperty} from '@/data/api'
import {projectedPropertyDefinitionsFacet} from '@/data/facets'
import {openPropertyValue} from '@/data/internals/propertyValueEdits'
import type {Repo} from '@/data/repo'
import type {AppExtension} from '@/facets/facet.js'
import {resetTestDb, type TestDb} from './createTestDb'
import {createTestRepo} from './createTestRepo'
import {releaseTestRepos} from './testRepoScope'

export const queryProperty = defineProperty('test:query', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const options = {scope: ChangeScope.BlockDefault}
const definitionId = 'definition'

export interface StringValueHarness {
  readonly repo: Repo
  readonly workspaceId: string
  readonly ownerId: string
  /** Opens the owner's value block and writes `text` as its content, as the editor's flush does. */
  typeIntoValue(text: string): Promise<string>
  /** The owner's projected value for {@link queryProperty}. */
  projected(): Promise<unknown>
  valueContents(): Promise<string[]>
  dispose(): Promise<void>
}

export const createStringValueHarness = async (
  db: TestDb, extensions: readonly AppExtension[] = [],
): Promise<StringValueHarness> => {
  const workspaceId = 'ws-string-value'
  const ownerId = 'owner'
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'user-1', 1, 1, 'none', 'children')`, [workspaceId])
  const {repo} = createTestRepo({db: db.db, user: {id: 'user-1'}, extensions})
  repo.setActiveWorkspaceId(workspaceId)
  await repo.tx(async tx => {
    await tx.create({id: definitionId, workspaceId, parentId: null, orderKey: 'a0', content: queryProperty.name,
      properties: {types: ['property-schema']}})
    await tx.create({id: ownerId, workspaceId, parentId: null, orderKey: 'a9', content: 'host'})
  }, options)
  repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-definition', [{
    metadata: {fieldId: definitionId, workspaceId, createdAt: 1, name: queryProperty.name,
      changeScope: queryProperty.changeScope, hidden: false, origin: 'user'},
    schema: queryProperty,
  }], {workspaceId})
  return {
    repo, workspaceId, ownerId,
    typeIntoValue: async text => {
      const {valueId} = await repo.tx(tx => openPropertyValue(tx, ownerId, definitionId), options)
      await repo.tx(tx => tx.update(valueId, {content: text}), options)
      return valueId
    },
    projected: async () => {
      const row = await db.db.get<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', [ownerId])
      return (JSON.parse(row.properties_json) as Record<string, unknown>)[queryProperty.name]
    },
    valueContents: async () => (await db.db.getAll<{content: string}>(
      `SELECT v.content FROM blocks f JOIN blocks v ON v.parent_id = f.id
        WHERE f.parent_id = ? AND f.is_field_form = 1 AND f.deleted = 0 AND v.deleted = 0
        ORDER BY v.order_key, v.id`, [ownerId])).map(row => row.content),
    dispose: async () => {
      await repo.awaitProcessors()
      await releaseTestRepos([repo])
    },
  }
}
