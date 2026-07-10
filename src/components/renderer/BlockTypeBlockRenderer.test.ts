// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { aliasesProp, blockTypeLabelProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { writeBlockTypeLabel } from './BlockTypeBlockRenderer'

describe('writeBlockTypeLabel', () => {
  let h: TestDb | undefined

  afterEach(async () => {
    await h?.cleanup()
    h = undefined
  })

  /** Fresh repo + one alias-less `block-type` block (`type-1`), mirroring
   *  the Types-page "New type" button: created with an empty label and no
   *  alias. Optional `initialAlias` simulates a `createTypeBlock`-minted
   *  type that already claims its label. */
  const setupTypeBlock = async (
    initial: { label?: string; content?: string; alias?: string } = {},
  ): Promise<Repo> => {
    h = await createTestDb()
    let idSeq = 0
    const { repo } = createTestRepo({
      db: h.db,
      user: {id: 'user-1'},
      newId: () => `generated-${++idSeq}`,
      startSyncObserver: false,
    })
    repo.setActiveWorkspaceId('ws-1')

    await repo.tx(async tx => {
      await tx.create({
        id: 'type-1',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: initial.content ?? '',
      })
      await repo.addTypeInTx(tx, 'type-1', BLOCK_TYPE_TYPE, {})
      await tx.setProperty('type-1', blockTypeLabelProp, initial.label ?? '')
      if (initial.alias !== undefined) {
        await tx.setProperty('type-1', aliasesProp, [initial.alias])
      }
    }, {scope: ChangeScope.BlockDefault, description: 'create type'})

    return repo
  }

  it('mirrors the type label into block content for ordinary block search', async () => {
    const repo = await setupTypeBlock()
    const block = repo.block('type-1')
    await writeBlockTypeLabel(block, '', '', 'Author')

    expect(block.peekProperty(blockTypeLabelProp)).toBe('Author')
    expect(block.peek()?.content).toBe('Author')
  })

  it('seeds the label as an alias so a Types-page-created type resolves via [[label]]', async () => {
    const repo = await setupTypeBlock()
    const block = repo.block('type-1')
    await writeBlockTypeLabel(block, '', '', 'Author')

    expect(block.peekProperty(aliasesProp)).toEqual(['Author'])
    const resolved = await repo.query
      .aliasLookup({ workspaceId: 'ws-1', alias: 'Author' })
      .load()
    expect(resolved?.id).toBe('type-1')
  })

  it('does not overwrite an existing alias when the label is renamed', async () => {
    // A `createTypeBlock`-minted type already claims its label; the rename
    // reconciliation belongs to `aliasSyncProcessor` (content → alias),
    // so `writeBlockTypeLabel` must not re-seed / clobber the alias.
    const repo = await setupTypeBlock({ label: 'Author', content: 'Author', alias: 'Author' })
    const block = repo.block('type-1')
    await writeBlockTypeLabel(block, 'Author', 'Author', 'Writer')

    expect(block.peekProperty(blockTypeLabelProp)).toBe('Writer')
    expect(block.peekProperty(aliasesProp)).toEqual(['Author'])
  })

  it('releases the name alias when the label is blanked (so the name can be re-created)', async () => {
    // Blanking un-names the type; aliasSyncProcessor's blank-content guard
    // won't release the alias, so writeBlockTypeLabel must — else [[Author]]
    // keeps resolving to a now-typeless block and re-creating "Author"
    // collides. User-added aliases (`Scribe`) survive.
    const repo = await setupTypeBlock({ label: 'Author', content: 'Author', alias: 'Author' })
    const block = repo.block('type-1')
    await repo.tx(async tx => {
      await tx.setProperty('type-1', aliasesProp, ['Author', 'Scribe'])
    }, { scope: ChangeScope.BlockDefault, description: 'add user alias' })

    await writeBlockTypeLabel(block, 'Author', 'Author', '')

    expect(block.peekProperty(aliasesProp)).toEqual(['Scribe'])
    const resolved = await repo.query
      .aliasLookup({ workspaceId: 'ws-1', alias: 'Author' })
      .load()
    expect(resolved).toBeNull()
  })
})
