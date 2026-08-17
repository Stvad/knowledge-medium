// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { aliasesProp, blockTypeLabelProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { aliasDataExtension } from '@/plugins/alias/dataExtension'
import { writeBlockTypeLabel } from './BlockTypeBlockRenderer'

// One DB for the FILE — both suites below share it, reset between tests. The
// repo is still built fresh per test: these exercise processor-driven alias
// writes, so they want their own registry and id sequence, just not their own
// database.
let h: TestDb
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })
beforeEach(async () => { await resetTestDb(h.db) })

describe('writeBlockTypeLabel', () => {

  /** Fresh repo + one alias-less `block-type` block (`type-1`), mirroring
   *  the Types-page "New type" button: created with an empty label and no
   *  alias. Optional `initialAlias` simulates a `createTypeBlock`-minted
   *  type that already claims its label. */
  const setupTypeBlock = async (
    initial: { label?: string; content?: string; alias?: string } = {},
  ): Promise<Repo> => {
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

  // The editor captured `Author` when it rendered; a rename — remote, or from
  // a second view — advanced the stored label, content and alias to `Editor`
  // before this commit landed. Releasing the CAPTURED name drops nothing and
  // leaves `[[Editor]]` claimed by a now-typeless block; blanking empties
  // `content` too, so `aliasSyncProcessor`'s blank-content guard will not
  // come back for it either.
  it('releases the label as stored, not as captured, when a rename landed first', async () => {
    const repo = await setupTypeBlock({ label: 'Author', content: 'Author', alias: 'Author' })
    const block = repo.block('type-1')
    await repo.tx(async tx => {
      await tx.setProperty('type-1', blockTypeLabelProp, 'Editor')
      await tx.update('type-1', { content: 'Editor' })
      await tx.setProperty('type-1', aliasesProp, ['Editor'])
    }, { scope: ChangeScope.BlockDefault, description: 'rename from elsewhere' })

    await writeBlockTypeLabel(block, 'Author', 'Author', '')

    expect(block.peekProperty(aliasesProp)).toEqual([])
    const resolved = await repo.query
      .aliasLookup({ workspaceId: 'ws-1', alias: 'Editor' })
      .load()
    expect(resolved).toBeNull()
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

/** The rename path against the REAL `alias.sync` processor. The suite above
 *  runs without the alias plugin on purpose — it pins what
 *  `writeBlockTypeLabel` itself writes — but "does the old name actually stop
 *  being claimed" is a property of the two together, and that is where the
 *  drift bug lived. */
describe('writeBlockTypeLabel + alias.sync — the old name must stop being claimed', () => {
  const setupTypeBlock = async (
    initial: { label: string; content: string; aliases: readonly string[] },
  ): Promise<Repo> => {
    const { repo } = createTestRepo({
      db: h.db,
      user: {id: 'user-1'},
      startSyncObserver: false,
      extensions: [aliasDataExtension],
    })
    repo.setActiveWorkspaceId('ws-1')
    await repo.tx(async tx => {
      await tx.create({
        id: 'type-1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0',
        content: initial.content,
      })
      await repo.addTypeInTx(tx, 'type-1', BLOCK_TYPE_TYPE, {})
      await tx.setProperty('type-1', blockTypeLabelProp, initial.label)
      await tx.setProperty('type-1', aliasesProp, [...initial.aliases])
    }, {scope: ChangeScope.BlockDefault, description: 'create type'})
    return repo
  }

  const claimantOf = async (repo: Repo, alias: string): Promise<string | null> =>
    (await repo.query.aliasLookup({workspaceId: 'ws-1', alias}).load())?.id ?? null

  it('replaces the alias on a content-anchored rename (unchanged behaviour)', async () => {
    // content == label == alias: `alias.sync` rule 1 owns this, and still does.
    const repo = await setupTypeBlock({label: 'Author', content: 'Author', aliases: ['Author']})
    await writeBlockTypeLabel(repo.block('type-1'), 'Author', 'Author', 'Writer')
    await repo.awaitProcessors()

    expect(repo.block('type-1').peekProperty(aliasesProp)).toEqual(['Writer'])
    expect(await claimantOf(repo, 'Author')).toBeNull()
    expect(await claimantOf(repo, 'Writer')).toBe('type-1')
  })

  it('replaces the alias when it tracks the LABEL and content has drifted', async () => {
    // The bug: `alias.sync` matches the entry equal to the block's OLD CONTENT.
    // Here the alias is the old LABEL and content is something else, so rule 1
    // misses and rule 2 only appends — leaving "Author" claimed forever, which
    // both mis-resolves `[[Author]]` and blocks re-creating a type by that name.
    const repo = await setupTypeBlock({label: 'Author', content: 'scratch', aliases: ['Author']})
    await writeBlockTypeLabel(repo.block('type-1'), 'Author', 'scratch', 'Writer')
    await repo.awaitProcessors()

    expect(repo.block('type-1').peekProperty(aliasesProp)).toEqual(['Writer'])
    expect(await claimantOf(repo, 'Author')).toBeNull()
    expect(await claimantOf(repo, 'Writer')).toBe('type-1')
  })

  it('keeps user-added aliases when healing the drifted one', async () => {
    const repo = await setupTypeBlock({
      label: 'Author', content: 'scratch', aliases: ['Scribe', 'Author'],
    })
    await writeBlockTypeLabel(repo.block('type-1'), 'Author', 'scratch', 'Writer')
    await repo.awaitProcessors()

    expect(repo.block('type-1').peekProperty(aliasesProp)).toEqual(['Scribe', 'Writer'])
    expect(await claimantOf(repo, 'Scribe')).toBe('type-1')
  })

  it('leaves a deliberately un-claimed type un-claimed', async () => {
    // The alias list is non-empty but holds neither the old label nor the old
    // content — the type's name is simply not claimed by this block. Healing
    // must not invent a claim; that stays `alias.sync`'s rule-2 drift heal.
    const repo = await setupTypeBlock({label: 'Author', content: 'Author', aliases: ['Scribe']})
    await writeBlockTypeLabel(repo.block('type-1'), 'Author', 'Author', 'Writer')
    await repo.awaitProcessors()

    expect(repo.block('type-1').peekProperty(aliasesProp)).not.toContain('Author')
  })
})
