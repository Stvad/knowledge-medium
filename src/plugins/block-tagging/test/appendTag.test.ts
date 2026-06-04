// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { ChangeScope } from '@/data/api'
import { appendTagToBlocks, appendTagToContent } from '../appendTag.ts'

describe('appendTagToContent', () => {
  it('appends [[name]] with a separating space when content is non-empty', () => {
    expect(appendTagToContent('hello world', 'srs')).toBe('hello world [[srs]]')
  })

  it('omits the separator when content is empty', () => {
    expect(appendTagToContent('', 'srs')).toBe('[[srs]]')
  })

  it('omits the separator when content already ends with whitespace', () => {
    expect(appendTagToContent('trailing space ', 'srs')).toBe(
      'trailing space [[srs]]',
    )
  })

  it('is a no-op when the tag is already present anywhere in the content', () => {
    expect(appendTagToContent('foo [[srs]] bar', 'srs')).toBe(
      'foo [[srs]] bar',
    )
    expect(appendTagToContent('[[srs]]', 'srs')).toBe('[[srs]]')
  })

  it('matches alias exactly (case-sensitive)', () => {
    expect(appendTagToContent('foo [[SRS]] bar', 'srs')).toBe(
      'foo [[SRS]] bar [[srs]]',
    )
  })

  it('rejects names containing wikilink delimiters as a no-op', () => {
    // `[[` is left alone by renderWikilink, so `foo[[bar` would
    // parse to alias `bar` and corrupt subsequent dedup checks.
    // `]]` has the symmetric problem at the closing side. Both are
    // rejected at the entry point.
    expect(appendTagToContent('hello', 'foo[[bar')).toBe('hello')
    expect(appendTagToContent('hello', 'foo]]bar')).toBe('hello')
    expect(appendTagToContent('hello', '   ')).toBe('hello')
  })

  it('is idempotent for benign tag names', () => {
    const once = appendTagToContent('hello', 'srs')
    expect(once).toBe('hello [[srs]]')
    expect(appendTagToContent(once, 'srs')).toBe(once)
  })
})

describe('appendTagToBlocks', () => {
  let sharedDb: TestDb
  let h: TestDb
  let repo: Repo
  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    h = sharedDb
    repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: {id: 'user-1'},
      registerKernelProcessors: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
  })

  afterEach(() => { repo.stopSyncObserver() })

  const seed = async (id: string, content: string): Promise<void> => {
    await repo.tx(tx => tx.create({
      id,
      workspaceId: 'ws-1',
      parentId: null,
      orderKey: `a-${id}`,
      content,
    }), {scope: ChangeScope.BlockDefault, description: `seed ${id}`})
  }

  it('appends the tag to every block in a single tx', async () => {
    await seed('a', 'first')
    await seed('b', 'second')

    const result = await appendTagToBlocks(
      [repo.block('a'), repo.block('b')],
      'srs',
    )

    expect(result).toEqual({total: 2, updated: 2, alreadyTagged: 0})
    expect((await repo.load('a'))?.content).toBe('first [[srs]]')
    expect((await repo.load('b'))?.content).toBe('second [[srs]]')
  })

  it('skips blocks that already carry the tag', async () => {
    await seed('a', 'already [[srs]] tagged')
    await seed('b', 'untagged')

    const result = await appendTagToBlocks(
      [repo.block('a'), repo.block('b')],
      'srs',
    )

    expect(result).toEqual({total: 2, updated: 1, alreadyTagged: 1})
    expect((await repo.load('a'))?.content).toBe('already [[srs]] tagged')
    expect((await repo.load('b'))?.content).toBe('untagged [[srs]]')
  })

  it('is a no-op for empty input', async () => {
    const result = await appendTagToBlocks([], 'srs')
    expect(result).toEqual({total: 0, updated: 0, alreadyTagged: 0})
  })

  it('is a no-op when the tag name is empty', async () => {
    await seed('a', 'first')
    const result = await appendTagToBlocks([repo.block('a')], '')
    expect(result).toEqual({total: 1, updated: 0, alreadyTagged: 0})
    expect((await repo.load('a'))?.content).toBe('first')
  })
})
