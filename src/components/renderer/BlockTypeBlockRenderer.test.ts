// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { blockTypeLabelProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { writeBlockTypeLabel } from './BlockTypeBlockRenderer'

describe('writeBlockTypeLabel', () => {
  let h: TestDb | undefined

  afterEach(async () => {
    await h?.cleanup()
    h = undefined
  })

  it('mirrors the type label into block content for ordinary block search', async () => {
    h = await createTestDb()
    let now = 1700_000_000_000
    let idSeq = 0
    let txSeq = 0
    const repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: {id: 'user-1'},
      now: () => ++now,
      newId: () => `generated-${++idSeq}`,
      newTxSeq: () => ++txSeq,
      startSyncObserver: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    repo.setActiveWorkspaceId('ws-1')

    await repo.tx(async tx => {
      await tx.create({
        id: 'type-1',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: '',
      })
      await repo.addTypeInTx(tx, 'type-1', BLOCK_TYPE_TYPE, {})
      await tx.setProperty('type-1', blockTypeLabelProp, '')
    }, {scope: ChangeScope.BlockDefault, description: 'create type'})

    const block = repo.block('type-1')
    await writeBlockTypeLabel(block, '', '', 'Author')

    expect(block.peekProperty(blockTypeLabelProp)).toBe('Author')
    expect(block.peek()?.content).toBe('Author')
  })
})
