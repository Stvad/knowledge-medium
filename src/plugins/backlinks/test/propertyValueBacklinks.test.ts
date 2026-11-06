// @vitest-environment node
/**
 * A link inside a property value, through the real pipeline: property writes
 * dual-write field and value rows, `references.parseReferences` derives their
 * edges, and every backlink route answers from those edges.
 *
 * The rule under test: however a property subtree holds a link, the target
 * lists the subtree's owner once and never the hidden row.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type AnyPropertySchema, type BlockData, type Tx } from '@/data/api'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { definitionSeedsFacet } from '@/data/facets.js'
import { aliasesProp, typesProp } from '@/data/properties'
import { seedProperty } from '@/data/propertySeeds'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { PLAINTEXT_ALIAS_SEATS } from '@/data/test/plaintextAliasSeats'
import { computeAliasSeatId } from '@/data/targets'
import { annotationQuotePrefixProp, annotationTargetProp, THREAD_TYPE } from '@/plugins/annotations/schema'
import { annotationsDataExtension } from '@/plugins/annotations/dataExtension'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension'
import { groupedBacklinksDataExtension } from '@/plugins/grouped-backlinks/dataExtension'
import { GROUPED_BACKLINKS_FOR_BLOCK_QUERY } from '@/plugins/grouped-backlinks/query'
import { referencesDataExtension } from '@/plugins/references/dataExtension'
import { BACKLINKS_COUNT_FOR_BLOCK_QUERY } from '../inline-counts/countQuery.ts'
import { backlinksDataExtension } from '../dataExtension.ts'
import { BACKLINKS_FOR_BLOCK_QUERY, type BacklinksFilter } from '../query.ts'

const WS = 'ws-property-value-backlinks'
const OTHER_WS = 'ws-property-value-backlinks-other'
// The block-ref grammar only reads ids shaped like a UUID, so a ref-typed
// value's `((id))` needs a target with one.
const TARGET = '11111111-1111-4111-8111-111111111111'
const scope = {scope: ChangeScope.BlockDefault}

const noteProp = seedProperty({
  seedKey: 'test:property-value-backlinks/property/note', revision: 1, name: 'test:note',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const tagsProp = seedProperty({
  seedKey: 'test:property-value-backlinks/property/tags', revision: 1, name: 'test:tags',
  preset: 'string-list', changeScope: ChangeScope.BlockDefault,
})
const linkProp = seedProperty({
  seedKey: 'test:property-value-backlinks/property/link', revision: 1, name: 'test:link',
  preset: 'ref', changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  for (const id of [WS, OTHER_WS]) {
    await sharedDb.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
         encryption_mode, properties_migration)
       VALUES (?, 'test', 'user-1', 1, 1, 'none', 'children')`,
      [id],
    )
  }
  ;({repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    startSyncObserver: true,
    extensions: [
      dailyNotesDataExtension,
      referencesDataExtension,
      backlinksDataExtension,
      groupedBacklinksDataExtension,
      annotationsDataExtension,
      definitionSeedsFacet.of(noteProp, {source: 'test'}),
      definitionSeedsFacet.of(tagsProp, {source: 'test'}),
      definitionSeedsFacet.of(linkProp, {source: 'test'}),
    ],
  }))
  repo.setActiveWorkspaceId(WS)
  await settle()
})
afterEach(() => { repo.stopSyncObserver() })

const settle = async () => {
  await repo.awaitReprojections()
  await repo.awaitProcessors()
}

const write = async (fn: (tx: Tx) => Promise<unknown>) => {
  await repo.tx(async tx => { await fn(tx) }, scope)
  await settle()
}

const block = (id: string, content = '', parentId: string | null = null) =>
  write(tx => tx.create({id, workspaceId: WS, parentId, orderKey: `k-${id}`, content}))

const page = (id: string, alias: string) => write(async tx => {
  await tx.create({id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content: alias})
  await tx.setProperty(id, aliasesProp, [alias])
})

const fieldIdOf = (name: string): string => {
  const resolved = repo.propertySchemaResolverFor(WS).resolve(name)
  if (resolved.status !== 'resolved') throw new Error(`no definition for ${name}`)
  return resolved.schema.fieldId
}

const onlyValueRow = async (owner: string, schema: AnyPropertySchema): Promise<BlockData> => {
  const rows = await sharedDb.db.getAll<{id: string}>(
    `SELECT v.id FROM blocks f JOIN blocks v ON v.parent_id = f.id
      WHERE f.parent_id = ? AND f.is_field_form = 1 AND f.reference_target_id = ? AND v.deleted = 0`,
    [owner, fieldIdOf(schema.name)],
  )
  expect(rows).toHaveLength(1)
  return (await repo.load(rows[0].id))!
}

const sources = (target: string, filter?: BacklinksFilter) =>
  repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: target, filter}).load()
const rawSources = (target: string) =>
  repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: target, rawSources: true}).load()
const badge = (target: string) =>
  repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({workspaceId: WS, id: target}).load()

/** Every route agrees: the list, the badge, and the filtered list (a filter
 *  that removes nothing still takes the compiler route). */
const expectSources = async (target: string, expected: string[]) => {
  expect([...await sources(target)].sort()).toEqual([...expected].sort())
  expect(await badge(target)).toBe(expected.length)
  expect([...await sources(target, {exclude: [{scope: 'self', id: 'no-such-block'}]})].sort())
    .toEqual([...expected].sort())
}

describe('a link inside a string property value', () => {
  it('lists the owner, once, instead of the value row', async () => {
    await page('T', 'Target')
    await block('O', 'owner')
    await block('Q', 'plain [[Target]]')
    await write(tx => tx.setProperty('O', noteProp, 'plain'))
    const value = await onlyValueRow('O', noteProp)

    await write(tx => tx.update(value.id, {content: 'see [[Target]]'}))

    await expectSources('T', ['O', 'Q'])
    expect(await rawSources('T')).toContain(value.id)
  })

  it('lists the owner for a value that is exactly the link', async () => {
    await page('T', 'Target')
    await block('O', 'owner')
    await write(tx => tx.setProperty('O', noteProp, 'plain'))
    const value = await onlyValueRow('O', noteProp)

    await write(tx => tx.update(value.id, {content: '[[Target]]'}))

    await expectSources('T', ['O'])
  })

  it('takes no backlink from a value written as a literal that only looks like a link', async () => {
    // `setProperty` escapes this value so the row stays inert text: it holds no
    // edge, so nothing may invent a backlink from the owner's decoded cell.
    await page('T', 'Target')
    await block('O', 'owner')

    await write(tx => tx.setProperty('O', noteProp, '[[Target]]'))

    expect(await rawSources('T')).toEqual([])
    await expectSources('T', [])
  })

  it('lists the owner for a value that mints its target', async () => {
    await block('O', 'owner')

    await write(tx => tx.setProperty('O', noteProp, 'see [[Brand New]]'))

    await expectSources(computeAliasSeatId(PLAINTEXT_ALIAS_SEATS, 'Brand New', WS), ['O'])
  })

  it('follows the target through a rename and the link out of the value', async () => {
    await page('T', 'Target')
    await block('O', 'owner')
    await write(tx => tx.setProperty('O', noteProp, 'see [[Target]]'))
    const value = await onlyValueRow('O', noteProp)

    await write(tx => tx.setProperty('T', aliasesProp, ['Renamed']))
    expect((await repo.load(value.id))?.content).toBe('see [[Renamed]]')
    await expectSources('T', ['O'])

    await write(tx => tx.update(value.id, {content: 'no link any more'}))
    await expectSources('T', [])
  })

  it('follows undo and redo of the edit that added the link', async () => {
    await page('T', 'Target')
    await block('O', 'owner')
    await write(tx => tx.setProperty('O', noteProp, 'plain'))
    const value = await onlyValueRow('O', noteProp)
    await write(tx => tx.update(value.id, {content: 'see [[Target]]'}))
    await expectSources('T', ['O'])

    await repo.undo(ChangeScope.BlockDefault)
    await settle()
    await expectSources('T', [])

    await repo.redo(ChangeScope.BlockDefault)
    await settle()
    await expectSources('T', ['O'])
  })

  it('lists the owner for a value row that arrived by sync, with nothing re-parsed', async () => {
    await page('T', 'Target')
    await block('O', 'owner')
    await write(tx => tx.setProperty('O', noteProp, 'plain'))
    const field = (await onlyValueRow('O', noteProp)).parentId!
    const handle = repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'T'})
    const fired: string[][] = []
    handle.subscribe(value => { fired.push(value) })
    await expect.poll(() => fired.length).toBe(1)

    await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
      id: 'arrived', workspaceId: WS, parentId: field, orderKey: 'zz',
      content: 'see [[Target]]', properties: {}, references: [{id: 'T', alias: 'Target'}],
      createdAt: 0, updatedAt: 9_000_000_000_000, userUpdatedAt: 9_000_000_000_000,
      createdBy: 'remote', updatedBy: 'remote', deleted: false,
    }))
    await repo.flushSyncObserver()

    await expect.poll(() => fired.at(-1)).toEqual(['O'])
    expect(await badge('T')).toBe(1)
    expect((await repo.load('O'))?.references).toEqual([])
  })

  it('drops the backlink with the owner and with the field row, whichever is tombstoned', async () => {
    // Sync-apply permits a live value row under either tombstone. Raw writes so
    // no processor repairs the shape, before anything has read the answer.
    await page('T', 'Target')
    for (const owner of ['ownerGone', 'fieldGone', 'control']) {
      await block(owner, owner)
      await write(tx => tx.setProperty(owner, noteProp, 'see [[Target]]'))
    }
    const field = (await onlyValueRow('fieldGone', noteProp)).parentId!

    await sharedDb.db.writeTransaction(async tx => {
      await tx.execute(`UPDATE blocks SET deleted = 1 WHERE id = 'ownerGone'`)
      await tx.execute(`UPDATE blocks SET deleted = 1 WHERE id = ?`, [field])
    })

    expect(await rawSources('T')).toHaveLength(3)
    await expectSources('T', ['control'])
  })

  it('does not reach into another workspace for the owner', async () => {
    await page('T', 'Target')
    for (const owner of ['moved', 'control']) {
      await block(owner, owner)
      await write(tx => tx.setProperty(owner, noteProp, 'see [[Target]]'))
    }

    await sharedDb.db.writeTransaction(tx =>
      tx.execute(`UPDATE blocks SET workspace_id = ? WHERE id = 'moved'`, [OTHER_WS]))

    await expectSources('T', ['control'])
  })

  it('does not list a block as its own backlink through its value', async () => {
    await page('T', 'Target')

    await write(tx => tx.setProperty('T', noteProp, 'self [[Target]]'))

    const value = await onlyValueRow('T', noteProp)
    expect(await rawSources('T')).toContain(value.id)
    await expectSources('T', [])
  })
})

describe('a link elsewhere in a property subtree', () => {
  it('lists the owner for a second sibling value the cell does not project', async () => {
    await page('T', 'Target')
    await block('O', 'owner')
    await write(tx => tx.setProperty('O', noteProp, 'first'))
    const field = (await onlyValueRow('O', noteProp)).parentId!

    await block('sibling', 'second [[Target]]', field)

    await expectSources('T', ['O'])
  })

  it('lists the owner for a row nested under a value', async () => {
    await page('T', 'Target')
    await block('O', 'owner')
    await write(tx => tx.setProperty('O', noteProp, 'first'))
    const value = await onlyValueRow('O', noteProp)

    await block('nested', 'nested [[Target]]', value.id)

    await expectSources('T', ['O'])
  })

  it('lists the outermost owner for a property of a value row', async () => {
    await page('T', 'Target')
    await block('O', 'owner')
    await write(tx => tx.setProperty('O', noteProp, 'first'))
    const value = await onlyValueRow('O', noteProp)

    await write(tx => tx.setProperty(value.id, noteProp, 'inner [[Target]]'))

    await expectSources('T', ['O'])
  })

  it('lists the owner once however many rows state the link', async () => {
    await page('T', 'Target')
    await block('O', 'owner [[Target]]')
    await write(tx => tx.setProperty('O', noteProp, 'see [[Target]]'))
    const field = (await onlyValueRow('O', noteProp)).parentId!

    await block('sibling', 'second [[Target]]', field)

    await expectSources('T', ['O'])
  })

  it('lists the owner for a member of a string list', async () => {
    await page('T', 'Target')
    await block('O', 'owner')

    await write(tx => tx.setProperty('O', tagsProp, ['plain', 'see [[Target]]']))

    await expectSources('T', ['O'])
  })

  it('lists the owner for prose typed into a ref-typed value', async () => {
    await page(TARGET, 'Target')
    await page('P', 'Prose')
    await block('O', 'owner')
    await write(tx => tx.setProperty('O', linkProp, TARGET))
    const value = await onlyValueRow('O', linkProp)

    await write(tx => tx.update(value.id, {content: 'see [[Prose]]'}))

    await expectSources('P', ['O'])
  })
})

describe('edges another surface owns', () => {
  it('keeps a ref-typed value at one backlink, from the owner', async () => {
    await page(TARGET, 'Target')
    await block('O', 'owner')

    await write(tx => tx.setProperty('O', linkProp, TARGET))

    const value = await onlyValueRow('O', linkProp)
    expect(await rawSources(TARGET)).toEqual(expect.arrayContaining(['O', value.id]))
    await expectSources(TARGET, ['O'])
  })

  it('leaves the value row of an excluded field out of the mentions', async () => {
    // The owner's own edge is excluded by field; its value row states the same
    // edge and must not bring the owner back. No thread type here, so the field
    // exclusion alone has to hold.
    await page(TARGET, 'Target')
    await block('O', 'owner')

    await write(tx => tx.setProperty('O', annotationTargetProp, TARGET))

    const value = await onlyValueRow('O', annotationTargetProp)
    expect(await rawSources(TARGET)).toContain(value.id)
    await expectSources(TARGET, [])
  })

  it('takes no mention from a value row of a block whose text is a copy', async () => {
    // A thread's quote context is copied from the annotated block, like the
    // thread's own content. Neither states a link of its own.
    await page(TARGET, 'Target')
    await page('X', 'Linked')
    await block('thread', '')
    await write(async tx => {
      await tx.setProperty('thread', typesProp, [THREAD_TYPE])
      await tx.setProperty('thread', annotationTargetProp, TARGET)
      await tx.setProperty('thread', annotationQuotePrefixProp, 'before [[Linked]] ')
    })

    const value = await onlyValueRow('thread', annotationQuotePrefixProp)
    expect(await rawSources('X')).toContain(value.id)
    await expectSources('X', [])
  })
})

describe('routes that narrow the sources', () => {
  const seed = async () => {
    await page('T', 'Target')
    await page('P', 'Scope')
    await page('C', 'Chip')
    await block('O', 'owner', 'P')
    await block('Q', 'plain [[Target]]')
    await write(tx => tx.setProperty('O', noteProp, 'see [[Target]] and [[Chip]]'))
  }

  it('applies an ancestor-scoped filter to the owner of a value source', async () => {
    await seed()

    expect(await sources('T', {include: [{scope: 'ancestor', id: 'P'}]})).toEqual(['O'])
    expect(await sources('T', {exclude: [{scope: 'ancestor', id: 'P'}]})).toEqual(['Q'])
  })

  it('reads a chip on another link in the same value', async () => {
    await seed()

    expect(await sources('T', {include: [{scope: 'ancestor', referencedBy: {id: 'C'}}]})).toEqual(['O'])
    expect(await sources('T', {exclude: [{scope: 'ancestor', referencedBy: {id: 'C'}}]})).toEqual(['Q'])
  })

  it('orders owners by their own age, as the unfiltered list does', async () => {
    await page('T', 'Target')
    await block('older', 'older owner')
    await block('newer', 'newer owner')
    // Value rows created in the opposite order to their owners.
    await write(tx => tx.setProperty('newer', noteProp, 'see [[Target]]'))
    await write(tx => tx.setProperty('older', noteProp, 'see [[Target]]'))
    await sharedDb.db.execute(`UPDATE blocks SET created_at = 1 WHERE id = 'older'`)
    await sharedDb.db.execute(`UPDATE blocks SET created_at = 2 WHERE id = 'newer'`)

    const unfiltered = await sources('T')
    expect(unfiltered).toEqual(['newer', 'older'])
    expect(await sources('T', {exclude: [{scope: 'self', id: 'no-such-block'}]})).toEqual(unfiltered)
  })

  it('hands grouped backlinks the owner', async () => {
    await page('T', 'Target')
    await block('O', 'owner')
    await write(tx => tx.setProperty('O', noteProp, 'see [[Target]]'))

    const out = await repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'T'}).load()

    expect(out.unfilteredSourceIds).toEqual(['O'])
    expect(out.total).toBe(1)
  })
})
