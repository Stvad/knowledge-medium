// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { propertySchemasFacet } from '@/data/facets.ts'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { moveSrsState } from '../moveSrsState.ts'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '../schema.ts'
import { srsReschedulingDataExtension } from '../dataExtension.ts'

const WS = 'ws-1'

// A property that doesn't belong to the SRS type, used to assert that
// move only touches SRS fields.
const unrelatedProp = defineProperty<string>('unrelated', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

const seedSrsBlock = async (
  repo: Repo,
  id: string,
  values: {
    interval: number
    factor: number
    reviewCount: number
    archived?: boolean
    grade?: number
    extra?: Record<string, unknown>
  },
): Promise<void> => {
  const snapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    await tx.create({
      id,
      workspaceId: WS,
      parentId: null,
      orderKey: `a-${id}`,
      content: id,
    })
    await repo.addTypeInTx(tx, id, SRS_SM25_TYPE, {}, snapshot)
    const row = await tx.get(id)
    if (!row) throw new Error(`missing ${id}`)
    await tx.update(id, {
      properties: {
        ...row.properties,
        [srsIntervalProp.name]: srsIntervalProp.codec.encode(values.interval),
        [srsFactorProp.name]: srsFactorProp.codec.encode(values.factor),
        [srsReviewCountProp.name]: srsReviewCountProp.codec.encode(values.reviewCount),
        [srsArchivedProp.name]: srsArchivedProp.codec.encode(values.archived ?? false),
        [srsGradeProp.name]: srsGradeProp.codec.encode(values.grade ?? 0),
        ...(values.extra ?? {}),
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: `seed ${id}`})
}

const seedPlainBlock = async (
  repo: Repo,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id,
      workspaceId: WS,
      parentId: null,
      orderKey: `a-${id}`,
      content: id,
    })
    if (Object.keys(extra).length > 0) {
      const row = await tx.get(id)
      if (!row) throw new Error(`missing ${id}`)
      await tx.update(id, {properties: {...row.properties, ...extra}})
    }
  }, {scope: ChangeScope.BlockDefault, description: `seed plain ${id}`})
}

describe('moveSrsState', () => {
  let h: TestDb
  let repo: Repo

  beforeEach(async () => {
    h = await createTestDb()
    let txSeq = 0
    repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: {id: 'user-1'},
      newTxSeq: () => ++txSeq,
      registerKernelProcessors: false,
      startRowEventsTail: false,
    })
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      dailyNotesDataExtension,
      srsReschedulingDataExtension,
      propertySchemasFacet.of(unrelatedProp, {source: 'test'}),
    ])
    repo.setFacetRuntime(runtime)
  })

  afterEach(async () => {
    await h.cleanup()
  })

  const loadProps = async (id: string) => {
    const block = repo.block(id)
    const data = await block.load()
    if (!data) throw new Error(`missing ${id}`)
    return data
  }

  it('moves SRS type and all SRS field values from source to target', async () => {
    await seedSrsBlock(repo, 'src', {interval: 7, factor: 2.3, reviewCount: 4, grade: 5})
    await seedPlainBlock(repo, 'dst')

    await moveSrsState(repo, 'src', 'dst')

    const src = await loadProps('src')
    const dst = await loadProps('dst')

    expect(dst.properties.types).toEqual([SRS_SM25_TYPE])
    expect(srsIntervalProp.codec.decode(dst.properties[srsIntervalProp.name])).toBe(7)
    expect(srsFactorProp.codec.decode(dst.properties[srsFactorProp.name])).toBeCloseTo(2.3)
    expect(srsReviewCountProp.codec.decode(dst.properties[srsReviewCountProp.name])).toBe(4)
    expect(srsGradeProp.codec.decode(dst.properties[srsGradeProp.name])).toBe(5)

    expect(src.properties.types ?? []).not.toContain(SRS_SM25_TYPE)
    expect(src.properties[srsIntervalProp.name]).toBeUndefined()
    expect(src.properties[srsFactorProp.name]).toBeUndefined()
    expect(src.properties[srsReviewCountProp.name]).toBeUndefined()
    expect(src.properties[srsGradeProp.name]).toBeUndefined()
    expect(src.properties[srsArchivedProp.name]).toBeUndefined()
    expect(src.properties[srsSnapshotHistoryProp.name]).toBeUndefined()
  })

  it('replaces existing SRS state on the target (move semantics, not merge)', async () => {
    await seedSrsBlock(repo, 'src', {interval: 7, factor: 2.3, reviewCount: 4, grade: 5})
    await seedSrsBlock(repo, 'dst', {interval: 1, factor: 1.3, reviewCount: 99, grade: 0})

    await moveSrsState(repo, 'src', 'dst')

    const dst = await loadProps('dst')
    expect(srsIntervalProp.codec.decode(dst.properties[srsIntervalProp.name])).toBe(7)
    expect(srsFactorProp.codec.decode(dst.properties[srsFactorProp.name])).toBeCloseTo(2.3)
    expect(srsReviewCountProp.codec.decode(dst.properties[srsReviewCountProp.name])).toBe(4)
    expect(srsGradeProp.codec.decode(dst.properties[srsGradeProp.name])).toBe(5)
  })

  it('clears stale SRS fields on the target that the source did not set', async () => {
    // Target has interval set; source intentionally has no interval value
    // (only factor). After move, target should NOT keep its old interval —
    // the SRS state is fully transplanted.
    await seedPlainBlock(repo, 'src')
    const snapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      await repo.addTypeInTx(tx, 'src', SRS_SM25_TYPE, {}, snapshot)
      const row = await tx.get('src')
      if (!row) throw new Error('missing src')
      await tx.update('src', {
        properties: {
          ...row.properties,
          [srsFactorProp.name]: srsFactorProp.codec.encode(2.9),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed partial src'})
    await seedSrsBlock(repo, 'dst', {interval: 42, factor: 1.0, reviewCount: 0})

    await moveSrsState(repo, 'src', 'dst')

    const dst = await loadProps('dst')
    expect(dst.properties[srsIntervalProp.name]).toBeUndefined()
    expect(srsFactorProp.codec.decode(dst.properties[srsFactorProp.name])).toBeCloseTo(2.9)
  })

  it('preserves non-SRS properties on both source and target', async () => {
    await seedSrsBlock(repo, 'src', {
      interval: 7,
      factor: 2.3,
      reviewCount: 4,
      extra: {[unrelatedProp.name]: unrelatedProp.codec.encode('src-stays')},
    })
    await seedPlainBlock(repo, 'dst', {
      [unrelatedProp.name]: unrelatedProp.codec.encode('dst-stays'),
    })

    await moveSrsState(repo, 'src', 'dst')

    const src = await loadProps('src')
    const dst = await loadProps('dst')
    expect(unrelatedProp.codec.decode(src.properties[unrelatedProp.name])).toBe('src-stays')
    expect(unrelatedProp.codec.decode(dst.properties[unrelatedProp.name])).toBe('dst-stays')
  })

  it('is a no-op when the source has no SRS type', async () => {
    await seedPlainBlock(repo, 'src', {
      [unrelatedProp.name]: unrelatedProp.codec.encode('keep'),
    })
    await seedPlainBlock(repo, 'dst')

    await moveSrsState(repo, 'src', 'dst')

    const src = await loadProps('src')
    const dst = await loadProps('dst')
    expect(src.properties[unrelatedProp.name]).toBeDefined()
    expect(dst.properties.types ?? []).not.toContain(SRS_SM25_TYPE)
  })

  it('is a no-op when source and target are the same block', async () => {
    await seedSrsBlock(repo, 'src', {interval: 9, factor: 2.7, reviewCount: 2})

    await moveSrsState(repo, 'src', 'src')

    const src = await loadProps('src')
    expect(src.properties.types).toEqual([SRS_SM25_TYPE])
    expect(srsIntervalProp.codec.decode(src.properties[srsIntervalProp.name])).toBe(9)
  })
})
