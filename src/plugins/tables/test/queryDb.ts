/** A test workspace whose properties mirror `queryFixtures`, for running parsed
 *  queries through the real engine. Blocks are written raw, so a value can be
 *  stored in the wrong shape and `created_at` set to a chosen instant. */
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { ChangeScope, seedProperty, type AnyPropertySchema, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { trackTestRepo } from '@/data/test/testRepoScope'
import type { QueryProperty, QueryResolver } from '../query/parse'
import { resolver as fixtureResolver } from './queryFixtures'

export const WS = 'ws-query'

const DEFAULTS: Readonly<Record<string, unknown>> = {
  'strict-enum': 'open', number: 0, string: '', boolean: false, date: undefined, 'string-list': [], ref: '', refList: [],
}
const seed = (name: string, preset: string, config?: unknown) => seedProperty({
  seedKey: `test/property/tables-query-${name.replace(/\s/g, '-')}`, revision: 1, name, preset, ...(config ? {config} : {}),
  defaultValue: DEFAULTS[preset], changeScope: ChangeScope.BlockDefault,
} as unknown as Parameters<typeof seedProperty>[0])

const SEEDS = [
  seed('status', 'strict-enum', {options: ['open', 'closed', 'two words'].map(value => ({value, label: value}))}),
  seed('rating', 'number'),
  seed('label', 'string'),
  seed('done', 'boolean'),
  seed('due', 'date'),
  seed('tags', 'string-list'),
  seed('assignee', 'ref'),
  seed('related', 'refList'),
  seed('due date', 'string'),
  seed('under', 'string'),
]

const dbProperty = (schema: AnyPropertySchema): QueryProperty => ({
  name: schema.name, fieldId: `f-${schema.name.replace(/\s/g, '-')}`, schema,
})
export const DB_PROPERTIES = SEEDS.map(s => dbProperty(s as unknown as AnyPropertySchema))

/** The fixture resolver, answering properties with the seeds the engine knows. */
export const dbResolver: QueryResolver = {
  ...fixtureResolver,
  propertyByName: name => DB_PROPERTIES.find(p => p.name === name),
  propertyById: id => DB_PROPERTIES.find(p => p.fieldId === id),
}

export interface RawBlock {
  id: string
  parentId?: string | null
  types?: readonly string[]
  properties?: Record<string, unknown>
  references?: readonly BlockReference[]
  createdAt?: number
}

export const createQueryRepo = async (db: TestDb): Promise<Repo> => {
  await resetTestDb(db.db)
  const repo = trackTestRepo(new Repo({
    db: db.db, cache: new BlockCache(), user: {id: 'user-1'}, blockIdPolicy: 'any',
  }))
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    ...SEEDS.map(s => definitionSeedsFacet.of(s, {source: 'test'})),
  ]))
  repo.setActiveWorkspaceId(WS)
  return repo
}

export const writeBlocks = async (db: TestDb, blocks: readonly RawBlock[]) => {
  await db.db.writeTransaction(async tx => {
    for (const [index, block] of blocks.entries()) {
      const properties = {...block.properties, ...(block.types ? {[typesProp.name]: [...block.types]} : {})}
      const createdAt = block.createdAt ?? 1
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json,
          created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'user-1', 'user-1', 0)`,
        [block.id, WS, block.parentId ?? null, `a${String(index).padStart(3, '0')}`, JSON.stringify(properties),
          JSON.stringify(block.references ?? []), createdAt, createdAt, createdAt],
      )
    }
  })
}
