// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { isCollapsedProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import {
  pasteChordIntent,
  pasteEditModeMultilineText,
  pasteMultilineText,
  planEditModeMultilinePaste,
  planSingleBlockPaste,
} from '@/utils/paste'

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
      {scopeRootId: 'root'},
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
      {scopeRootId: 'root'},
    )

    expect(await childContents('parent')).toEqual(['Pasted', 'Second', 'Old child'])
    expect(await childContents('root')).toEqual(['Parent', 'Sibling'])
  })

  it('reveals a collapsed scope-root target when pasting as its children', async () => {
    // Pasting onto a nested scope root (scopeRootId === target.id) inserts
    // the roots as its children; if it's collapsed they'd be hidden, so the
    // paste must reveal it (same invariant as create-child / move).
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('sr', 'Scope root', 'root', 'a0')
    await createBlock('existing', 'Existing', 'sr', 'a0')
    await env.repo.mutate.setProperty({id: 'sr', schema: isCollapsedProp, value: true})

    await pasteMultilineText('Alpha\nBeta', env.repo.block('sr'), env.repo, {scopeRootId: 'sr'})

    expect(env.repo.block('sr').peek()?.properties[isCollapsedProp.name]).toBe(false)
    expect(await childContents('sr')).toEqual(['Alpha', 'Beta', 'Existing'])
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
      {scopeRootId: 'root'},
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
      {scopeRootId: 'page'},
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
      {scopeRootId: 'root'},
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
      {placement: 'sibling', scopeRootId: 'root'},
    )

    expect(await childContents('root')).toEqual(['Parent', 'Pasted', 'Sibling'])
    expect(await childContents('parent')).toEqual(['Old child'])
  })
})

describe('pasteEditModeMultilineText', () => {
  it('merges the first line at the caret and moves the suffix to the last pasted block', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'hello world', 'root', 'a0')
    await createBlock('next', 'Next', 'root', 'a1')

    const plan = planEditModeMultilinePaste('alpha\nbeta', 'hello world', {
      from: 'hello '.length,
      to: 'hello '.length,
    })
    expect(plan?.targetContent).toBe('hello alpha')

    const result = await pasteEditModeMultilineText(
      plan!,
      env.repo.block('target'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(env.repo.block('target').peek()?.content).toBe('hello alpha')
    expect(await childContents('root')).toEqual(['hello alpha', 'betaworld', 'Next'])
    expect(result?.focusBlock.id).not.toBe('target')
    expect(result?.focusOffset).toBe('beta'.length)
  })

  it('parents children of the first pasted root under the edited block', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'prefix ', 'root', 'a0')
    await createBlock('next', 'Next', 'root', 'a1')

    const plan = planEditModeMultilinePaste('- Parent\n  - Child\n- Sibling', 'prefix ', {
      from: 'prefix '.length,
      to: 'prefix '.length,
    })

    const result = await pasteEditModeMultilineText(
      plan!,
      env.repo.block('target'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(env.repo.block('target').peek()?.content).toBe('prefix Parent')
    expect(await childContents('target')).toEqual(['Child'])
    expect(await childContents('root')).toEqual(['prefix Parent', 'Sibling', 'Next'])
    expect(result?.focusBlock.peek()?.content).toBe('Sibling')
  })

  it('keeps remaining lines visible when editing the zoomed top-level block', async () => {
    await createBlock('workspace-root', 'Workspace root', null, 'a0')
    await createBlock('page', 'Page', 'workspace-root', 'a0')
    await createBlock('existing', 'Existing', 'page', 'a0')

    const plan = planEditModeMultilinePaste(' title\nchild', 'Page', {
      from: 'Page'.length,
      to: 'Page'.length,
    })

    await pasteEditModeMultilineText(
      plan!,
      env.repo.block('page'),
      env.repo,
      {scopeRootId: 'page'},
    )

    expect(await childContents('workspace-root')).toEqual(['Page title'])
    expect(await childContents('page')).toEqual(['child', 'Existing'])
  })
})

describe('pasteChordIntent', () => {
  const key = (over: Partial<KeyboardEvent>): Parameters<typeof pasteChordIntent>[0] => ({
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: 'v', ...over,
  })

  it('classifies Cmd/Ctrl+V as a split paste', () => {
    expect(pasteChordIntent(key({metaKey: true}))).toBe('split')
    expect(pasteChordIntent(key({ctrlKey: true}))).toBe('split')
  })

  it('classifies Cmd/Ctrl+Shift+V as a single-block paste', () => {
    // Browsers report the key as 'V' when Shift is held.
    expect(pasteChordIntent(key({metaKey: true, shiftKey: true, key: 'V'}))).toBe('single-block')
    expect(pasteChordIntent(key({ctrlKey: true, shiftKey: true, key: 'v'}))).toBe('single-block')
  })

  it('ignores non-paste keys and AltGr/Option pastes', () => {
    expect(pasteChordIntent(key({metaKey: true, key: 'c'}))).toBeNull()
    expect(pasteChordIntent(key({key: 'v'}))).toBeNull()
    expect(pasteChordIntent(key({metaKey: true, altKey: true}))).toBeNull()
  })
})

describe('planSingleBlockPaste', () => {
  it('replaces the selected range and places the cursor after the insert', () => {
    const plan = planSingleBlockPaste('AAA', {from: 0, to: 5})
    expect(plan).toEqual({insert: 'AAA', from: 0, to: 5, cursor: 3})
  })

  it('normalizes CRLF/CR to LF so the cursor stays inside the document', () => {
    const plan = planSingleBlockPaste('one\r\ntwo\rthree', {from: 2, to: 2})
    expect(plan.insert).toBe('one\ntwo\nthree')
    expect(plan.cursor).toBe(2 + 'one\ntwo\nthree'.length)
  })
})
