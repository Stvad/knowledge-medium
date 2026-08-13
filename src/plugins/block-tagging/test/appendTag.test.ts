// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ChangeScope } from '@/data/api'
import { appendTagToBlocks, appendTagToContent } from '../appendTag.ts'
import { tagNameIssue } from '../config.ts'
import { MAX_ALIAS_LENGTH, parseReferences, renderWikilink } from '@/plugins/references/referenceParser'

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

  // Both tag entry points take free text, so nothing upstream bounds
  // this. Over the cap the parser refuses to read the emitted `[[…]]`
  // as a wikilink, so appending would write literal markup that never
  // links and never gains a backlink — while `appendTagToBlocks` still
  // counted the block as tagged, since it decides that on string
  // inequality alone. Assert on the ROUND TRIP, not just the length:
  // the reason to reject is that the output stops parsing back.
  it('rejects a name longer than the parser will read back', () => {
    const tooLong = 'a'.repeat(MAX_ALIAS_LENGTH + 1)
    expect(appendTagToContent('hello', tooLong)).toBe('hello')

    const atCap = 'a'.repeat(MAX_ALIAS_LENGTH)
    const tagged = appendTagToContent('hello', atCap)
    expect(tagged).toBe(`hello [[${atCap}]]`)
    expect(parseReferences(tagged).map(r => r.alias)).toEqual([atCap])
  })

  // The entry points render a message per reason, so the reason has to be
  // distinguishable — they used to hard-code "can't contain [[ or ]]",
  // which the length rule turned into a lie for inputs containing neither.
  it('reports WHY a name was rejected', () => {
    expect(tagNameIssue('srs')).toBeNull()
    expect(tagNameIssue('  ')).toBe('empty')
    expect(tagNameIssue('foo[[bar')).toBe('delimiters')
    expect(tagNameIssue('foo]]bar')).toBe('delimiters')
    expect(tagNameIssue('a'.repeat(MAX_ALIAS_LENGTH + 1))).toBe('too-long')
    // The trailing-`]` case is 'too-long', not 'delimiters' — a single
    // bracket is allowed, it is the rendered padding that overflows.
    expect(tagNameIssue(`${'a'.repeat(MAX_ALIAS_LENGTH - 1)}]`)).toBe('too-long')
  })

  // The rendered span, not the input, is what the cap applies to.
  // `renderWikilink` pads a trailing `]` with a space to keep the closing
  // delimiter balanced, so this name is AT the cap but emits an alias one
  // character over it — a length check on the input alone would let it
  // through and write markup that parses to nothing while
  // `appendTagToBlocks` reported the block as tagged.
  it('rejects an at-cap name whose trailing `]` pushes the rendered alias over', () => {
    const atCapWithBracket = `${'a'.repeat(MAX_ALIAS_LENGTH - 1)}]`
    expect(atCapWithBracket.length).toBe(MAX_ALIAS_LENGTH)
    // The shape of the hazard: rendering pads, so the emitted alias is longer.
    expect(renderWikilink(atCapWithBracket)).toBe(`[[${atCapWithBracket} ]]`)
    expect(appendTagToContent('hello', atCapWithBracket)).toBe('hello')

    // One char shorter renders within the cap and is still accepted, so
    // this pins the boundary rather than "trailing brackets are banned".
    const justUnder = `${'a'.repeat(MAX_ALIAS_LENGTH - 2)}]`
    const tagged = appendTagToContent('hello', justUnder)
    expect(parseReferences(tagged)).toHaveLength(1)
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
    repo = createTestRepo({
      db: h.db,
      user: {id: 'user-1'},
    }).repo
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
