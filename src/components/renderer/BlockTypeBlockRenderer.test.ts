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
    initial: { label?: string; content?: string; alias?: string; types?: string[] } = {},
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
      for (const extra of initial.types ?? []) {
        await repo.addTypeInTx(tx, 'type-1', extra, {})
      }
    }, {scope: ChangeScope.BlockDefault, description: 'create type'})

    return repo
  }

  // A block may carry `block-type` AND an opaque type. The content mirror is
  // refused there (it would overwrite an extension's source with the label),
  // and `aliasSyncProcessor` skips opaque rows — so if this did not move the
  // claim itself, the registry would advertise the new name while `[[new]]`
  // resolved nowhere and the OLD name still claimed the block.
  it('renames the alias without touching opaque content', async () => {
    const repo = await setupTypeBlock({
      label: 'Old', content: 'export const x = 1', alias: 'Old', types: ['extension'],
    })

    await writeBlockTypeLabel(repo.block('type-1'), 'Old', 'export const x = 1', 'New')

    const row = await repo.load('type-1')
    expect(row!.content).toBe('export const x = 1')
    expect(row!.properties[blockTypeLabelProp.name]).toBe('New')
    expect(row!.properties[aliasesProp.name]).toEqual(['New'])
  })

  it('leaves hand-added aliases alone when renaming an opaque type', async () => {
    const repo = await setupTypeBlock({
      label: 'Old', content: 'export const x = 1', alias: 'Old', types: ['extension'],
    })
    await repo.tx(
      tx => tx.setProperty('type-1', aliasesProp, ['Old', 'mine']),
      {scope: ChangeScope.BlockDefault},
    )

    await writeBlockTypeLabel(repo.block('type-1'), 'Old', 'export const x = 1', 'New')

    const row = await repo.load('type-1')
    expect(row!.properties[aliasesProp.name]).toEqual(['New', 'mine'])
  })

  it('releases the old label even when the new one is already claimed', async () => {
    const repo = await setupTypeBlock({
      label: 'Old', content: 'export const x = 1', alias: 'Old', types: ['extension'],
    })
    await repo.tx(
      tx => tx.setProperty('type-1', aliasesProp, ['Old', 'New', 'mine']),
      {scope: ChangeScope.BlockDefault},
    )

    await writeBlockTypeLabel(repo.block('type-1'), 'Old', 'export const x = 1', 'New')

    // `Old` is released — otherwise that name stays claimed forever and
    // nothing else can take it, even though the type no longer advertises it.
    const row = await repo.load('type-1')
    expect(row!.properties[aliasesProp.name]).toEqual(['New', 'mine'])
  })

  // Claiming and releasing are independent: with the generated alias deleted
  // by hand there is no old entry to rewrite, but `[[New]]` still has to
  // resolve to the type — nothing else will claim it for an opaque row.
  it('claims the new label even when no old-label alias remains', async () => {
    const repo = await setupTypeBlock({
      label: 'Old', content: 'export const x = 1', alias: 'mine', types: ['extension'],
    })

    await writeBlockTypeLabel(repo.block('type-1'), 'Old', 'export const x = 1', 'New')

    const row = await repo.load('type-1')
    expect(row!.properties[aliasesProp.name]).toEqual(['New', 'mine'])
    expect(row!.content).toBe('export const x = 1')
  })

  // The mirror below is exactly why the label needs hygiene (PR #288 §7):
  // a reference-shaped label becomes reference-shaped CONTENT, and a
  // `::`-marked one makes the type's own block a recognized property field
  // row of the Types page — hidden from the outline, keyed onto its cell.
  it.each([
    ['a marked exact ref', '::((0f7b3c1a-9d2e-4f60-8a1b-2c3d4e5f6a7b))'],
    ['a bare exact ref', '((0f7b3c1a-9d2e-4f60-8a1b-2c3d4e5f6a7b))'],
    ['a wikilink', '[[Author]]'],
  ])('refuses %s as a label, leaving content and label untouched', async (_case, label) => {
    const repo = await setupTypeBlock()
    const block = repo.block('type-1')
    await expect(writeBlockTypeLabel(block, '', '', label))
      .rejects.toThrow(/reads as a block reference/)
    expect(block.peek()?.content).toBe('')
    expect(block.peekProperty(blockTypeLabelProp)).toBe('')
  })

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
