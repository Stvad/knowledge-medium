// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
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

  it('is idempotent for names whose canonical form differs from the input', () => {
    // `]]` inside an alias is rewritten by renderWikilink so the
    // output is parseable. The dedup check must run against that
    // canonical form, otherwise a second invocation would append a
    // duplicate.
    const once = appendTagToContent('hello', 'weird]]name')
    expect(once).not.toBe('hello')
    expect(appendTagToContent(once, 'weird]]name')).toBe(once)
  })
})

describe('appendTagToBlocks', () => {
  let h: TestDb
  let repo: Repo

  beforeEach(async () => {
    h = await createTestDb()
    repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: {id: 'user-1'},
      registerKernelProcessors: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
  })

  afterEach(async () => {
    await h.cleanup()
  })

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
