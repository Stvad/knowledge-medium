// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { isCollapsedProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { pasteMultilineText } from '@/utils/paste'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
  })
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const createBlock = async (
  id: string,
  content: string,
  parentId: string | null,
  orderKey: string,
): Promise<void> => {
  await env.repo.tx(tx => tx.create({
    id,
    workspaceId: WS,
    parentId,
    orderKey,
    content,
  }), {scope: ChangeScope.BlockDefault})
}

const childContents = async (parentId: string): Promise<string[]> => {
  const rows = await env.repo.query.children({id: parentId}).load()
  return rows.map(row => row.content)
}

describe('pasteMultilineText', () => {
  it('uses an empty target block as the first pasted root', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('empty', '', 'root', 'a0')
    await createBlock('next', 'Next', 'root', 'a1')

    const pasted = await pasteMultilineText(
      '- Alpha\n  - Detail\n- Beta',
      env.repo.block('empty'),
      env.repo,
      {topLevelBlockId: 'root'},
    )

    expect(pasted[0]?.id).toBe('empty')
    expect(env.repo.block('empty').peek()?.content).toBe('Alpha')
    expect(await childContents('empty')).toEqual(['Detail'])
    expect(await childContents('root')).toEqual(['Alpha', 'Beta', 'Next'])
  })

  it('pastes after an expanded target as first visible children', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('parent', 'Parent', 'root', 'a0')
    await createBlock('old-child', 'Old child', 'parent', 'a0')
    await createBlock('sibling', 'Sibling', 'root', 'a1')

    await pasteMultilineText(
      'Pasted\nSecond',
      env.repo.block('parent'),
      env.repo,
      {topLevelBlockId: 'root'},
    )

    expect(await childContents('parent')).toEqual(['Pasted', 'Second', 'Old child'])
    expect(await childContents('root')).toEqual(['Parent', 'Sibling'])
  })

  it('pastes after a collapsed target as a visible sibling', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('parent', 'Parent', 'root', 'a0')
    await createBlock('old-child', 'Old child', 'parent', 'a0')
    await createBlock('sibling', 'Sibling', 'root', 'a1')
    await env.repo.block('parent').set(isCollapsedProp, true)

    await pasteMultilineText(
      'Pasted',
      env.repo.block('parent'),
      env.repo,
      {topLevelBlockId: 'root'},
    )

    expect(await childContents('root')).toEqual(['Parent', 'Pasted', 'Sibling'])
    expect(await childContents('parent')).toEqual(['Old child'])
  })

  it('pastes on the zoomed top-level block inside the visible subtree', async () => {
    await createBlock('workspace-root', 'Workspace root', null, 'a0')
    await createBlock('page', 'Page', 'workspace-root', 'a0')
    await createBlock('existing', 'Existing', 'page', 'a0')

    await pasteMultilineText(
      'Pasted',
      env.repo.block('page'),
      env.repo,
      {topLevelBlockId: 'page'},
    )

    expect(await childContents('workspace-root')).toEqual(['Page'])
    expect(await childContents('page')).toEqual(['Pasted', 'Existing'])
  })

  it('pastes on a parentless top-level block as children instead of no-oping', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('existing', 'Existing', 'root', 'a0')

    await pasteMultilineText(
      'Pasted',
      env.repo.block('root'),
      env.repo,
      {topLevelBlockId: 'root'},
    )

    expect(await childContents('root')).toEqual(['Pasted', 'Existing'])
  })

  it('can force sibling placement for range-style paste', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('parent', 'Parent', 'root', 'a0')
    await createBlock('old-child', 'Old child', 'parent', 'a0')
    await createBlock('sibling', 'Sibling', 'root', 'a1')

    await pasteMultilineText(
      'Pasted',
      env.repo.block('parent'),
      env.repo,
      {placement: 'sibling', topLevelBlockId: 'root'},
    )

    expect(await childContents('root')).toEqual(['Parent', 'Pasted', 'Sibling'])
    expect(await childContents('parent')).toEqual(['Old child'])
  })
})
