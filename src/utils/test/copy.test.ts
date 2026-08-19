// @vitest-environment node
/**
 * Tests for `serializeBlock` / `serializeSelectedBlocks` — the
 * subtree → indented-markdown round-trip used by Cmd-C / Cmd-X.
 *
 * Coverage:
 *   - Single leaf block: copies its content without a markdown list marker
 *   - Block with no children
 *   - Block with children: children indent two spaces per level
 *   - Multi-level nesting (3 deep) with consistent indentation
 *   - Multi-line content: the indentation prefix applies per line
 *   - serializeSelectedBlocks: combines multiple subtrees in markdown
 *     and aggregates the block list
 *   - serializeSelectedBlocks: skips ids that fail to serialize
 *   - serializeSelectedBlocks: throws when no blocks could be
 *     serialized at all
 *
 * Replaces deleted `src/utils/test/copy.test.ts` (legacy Block + stub
 * clipboard tests). The new test runs through the real Block facade
 * + commit pipeline via `createTestDb`. Clipboard plumbing
 * (`copyBlockToClipboard` / `copySelectedBlocksToClipboard`) is
 * intentionally not covered here — that side just wraps
 * `navigator.clipboard.write` and would require a DOM environment.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '../../data/repo'
import { serializeBlock, serializeSelectedBlocks } from '@/utils/copy'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file (beforeAll), reset here per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
  })
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

interface SeedNode {
  id: string
  content: string
  children?: SeedNode[]
}

const seed = async (root: SeedNode): Promise<void> => {
  const insert = async (node: SeedNode, parentId: string | null, orderKey: string): Promise<void> => {
    await env.repo.tx(tx => tx.create({
      id: node.id,
      workspaceId: WS,
      parentId,
      orderKey,
      content: node.content,
    }), {scope: ChangeScope.BlockDefault})
    const kids = node.children ?? []
    for (let i = 0; i < kids.length; i++) {
      await insert(kids[i], node.id, `a${i}`)
    }
  }
  await insert(root, null, 'a0')
}

describe('serializeBlock', () => {
  it('serializes a leaf block as raw content without a list marker', async () => {
    await seed({id: 'leaf', content: 'hello'})
    const result = await serializeBlock(env.repo.block('leaf'))
    expect(result.markdown).toBe('hello')
    expect(result.blocks.map(b => b.id)).toEqual(['leaf'])
  })

  it('preserves multi-line leaf block content as-is', async () => {
    await seed({id: 'leaf', content: 'line 1\nline 2'})
    const result = await serializeBlock(env.repo.block('leaf'))
    expect(result.markdown).toBe('line 1\nline 2')
    expect(result.blocks.map(b => b.id)).toEqual(['leaf'])
  })

  it('serializes a block with one level of children, indenting two spaces', async () => {
    await seed({
      id: 'p',
      content: 'parent',
      children: [
        {id: 'c1', content: 'child 1'},
        {id: 'c2', content: 'child 2'},
      ],
    })
    const result = await serializeBlock(env.repo.block('p'))
    expect(result.markdown).toBe('- parent\n  - child 1\n  - child 2')
    expect(result.blocks.map(b => b.id)).toEqual(['p', 'c1', 'c2'])
  })

  it('serializes a 3-deep subtree with progressive indentation', async () => {
    await seed({
      id: 'p',
      content: 'p',
      children: [{
        id: 'c',
        content: 'c',
        children: [{id: 'g', content: 'g'}],
      }],
    })
    const result = await serializeBlock(env.repo.block('p'))
    expect(result.markdown).toBe('- p\n  - c\n    - g')
  })

  it('indents each line of multi-line content at the matching depth', async () => {
    await seed({
      id: 'p',
      content: 'parent line 1\nparent line 2',
      children: [{id: 'c', content: 'child line 1\nchild line 2'}],
    })
    const result = await serializeBlock(env.repo.block('p'))
    expect(result.markdown).toBe(
      '- parent line 1\n  parent line 2\n  - child line 1\n    child line 2',
    )
  })
})

describe('serializeSelectedBlocks', () => {
  it('combines multiple subtrees in selection order', async () => {
    await seed({id: 'a', content: 'a', children: [{id: 'a1', content: 'a1'}]})
    await seed({id: 'b', content: 'b'})

    const result = await serializeSelectedBlocks(['a', 'b'], env.repo)
    expect(result.markdown).toBe('- a\n  - a1\nb')
    expect(result.blocks.map(x => x.id)).toEqual(['a', 'a1', 'b'])
  })

  it('skips ids that fail to serialize and returns the rest', async () => {
    await seed({id: 'real', content: 'real'})
    const result = await serializeSelectedBlocks(['real', 'missing'], env.repo)
    expect(result.markdown).toBe('real')
    expect(result.blocks.map(x => x.id)).toEqual(['real'])
  })

  it('throws when no ids could be serialized', async () => {
    await expect(serializeSelectedBlocks(['ghost-1', 'ghost-2'], env.repo))
      .rejects.toThrow('No block data could be serialized for copying')
  })

  it('handles empty input by throwing the same error', async () => {
    await expect(serializeSelectedBlocks([], env.repo))
      .rejects.toThrow('No block data could be serialized for copying')
  })
})
