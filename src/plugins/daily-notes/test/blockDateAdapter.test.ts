// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  blockDateAdapterFacet,
  pickBlockDateAdapter,
  hasAnyBlockDateAdapter,
  type BlockDateAdapter,
} from '../blockDateAdapter.ts'
import {
  createEditorReferenceDateAdapter,
  referenceDateAdapter,
} from '../referenceDateAdapter.ts'

const fakeEditorView = (content: string) => {
  let text = content
  return {
    dispatch: vi.fn((spec: {changes?: {from: number; to: number; insert: string}}) => {
      if (!spec.changes) return
      text = text.slice(0, spec.changes.from) + spec.changes.insert + text.slice(spec.changes.to)
    }),
    state: {
      get doc() {
        return {
          length: text.length,
          toString: () => text,
        }
      },
    },
  }
}

const stubAdapter = (id: string, predicate: (content: string) => boolean): BlockDateAdapter => ({
  id,
  canHandle: block => {
    const data = block.peek()
    return !!data && predicate(data.content)
  },
  getCurrentIso: async () => '2026-01-01',
  setIso: async () => true,
})

let sharedDb: TestDb

beforeAll(async () => {
  sharedDb = await createTestDb()
})

afterAll(async () => {
  await sharedDb.cleanup()
})

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
})

const makeRepo = () =>
  new Repo({
    db: sharedDb.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    registerKernelProcessors: false,
    startSyncObserver: false,
  })

describe('blockDateAdapter dispatch', () => {
  it('returns null when no adapter applies', async () => {
    const repo = makeRepo()
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      blockDateAdapterFacet.of(referenceDateAdapter, {source: 'test'}),
    ])
    repo.setFacetRuntime(runtime)

    await repo.tx(tx => tx.create({
      id: 'plain', workspaceId: 'ws', parentId: null, orderKey: 'a',
      content: 'just text, no date here',
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('plain')
    await block.load()

    expect(pickBlockDateAdapter(runtime, block)).toBeNull()
    expect(hasAnyBlockDateAdapter(runtime, block)).toBe(false)
  })

  it('picks the reference adapter when content has one date wikilink', async () => {
    const repo = makeRepo()
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      blockDateAdapterFacet.of(referenceDateAdapter, {source: 'test'}),
    ])
    repo.setFacetRuntime(runtime)

    await repo.tx(tx => tx.create({
      id: 'dated', workspaceId: 'ws', parentId: null, orderKey: 'a',
      content: 'due [[2026-05-15]]',
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('dated')
    await block.load()

    const adapter = pickBlockDateAdapter(runtime, block)
    expect(adapter?.id).toBe(referenceDateAdapter.id)
    expect(await adapter?.getCurrentIso(block)).toBe('2026-05-15')
  })

  it('respects negative precedence — higher-priority adapter wins when both apply', async () => {
    const repo = makeRepo()
    const winner = stubAdapter('test.high-priority', () => true)
    const loser = stubAdapter('test.low-priority', () => true)
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      blockDateAdapterFacet.of(loser, {source: 'test-low'}),
      blockDateAdapterFacet.of(winner, {source: 'test-high', precedence: -1}),
    ])
    repo.setFacetRuntime(runtime)

    await repo.tx(tx => tx.create({
      id: 'b', workspaceId: 'ws', parentId: null, orderKey: 'a',
      content: 'whatever',
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('b')
    await block.load()
    expect(pickBlockDateAdapter(runtime, block)?.id).toBe(winner.id)
  })

  it('falls through past adapters whose canHandle returns false', async () => {
    const repo = makeRepo()
    const skip = stubAdapter('test.skip', content => content.includes('SKIP'))
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      blockDateAdapterFacet.of(skip, {source: 'test-skip', precedence: -1}),
      blockDateAdapterFacet.of(referenceDateAdapter, {source: 'test'}),
    ])
    repo.setFacetRuntime(runtime)

    await repo.tx(tx => tx.create({
      id: 'dated', workspaceId: 'ws', parentId: null, orderKey: 'a',
      content: 'due [[2026-05-15]]',
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('dated')
    await block.load()
    expect(pickBlockDateAdapter(runtime, block)?.id).toBe(referenceDateAdapter.id)
  })
})

describe('referenceDateAdapter', () => {
  it('canHandle accepts blocks with exactly one date reference', async () => {
    const repo = makeRepo()
    await repo.tx(async tx => {
      await tx.create({id: 'one', workspaceId: 'ws', parentId: null, orderKey: 'a',
        content: 'meet [[2026-05-15]]'})
      await tx.create({id: 'two', workspaceId: 'ws', parentId: null, orderKey: 'b',
        content: '[[2026-05-15]] vs [[2026-05-16]]'})
      await tx.create({id: 'none', workspaceId: 'ws', parentId: null, orderKey: 'c',
        content: 'no reference here'})
    }, {scope: ChangeScope.BlockDefault})

    const one = repo.block('one'); await one.load()
    const two = repo.block('two'); await two.load()
    const none = repo.block('none'); await none.load()

    expect(referenceDateAdapter.canHandle(one)).toBe(true)
    expect(referenceDateAdapter.canHandle(two)).toBe(false)
    expect(referenceDateAdapter.canHandle(none)).toBe(false)
  })

  it('setIso preserves the reference style (ISO vs long form)', async () => {
    const repo = makeRepo()
    await repo.tx(async tx => {
      await tx.create({id: 'iso', workspaceId: 'ws', parentId: null, orderKey: 'a',
        content: 'due [[2026-05-15]]'})
      await tx.create({id: 'long', workspaceId: 'ws', parentId: null, orderKey: 'b',
        content: 'meet [[May 15th, 2026]]'})
    }, {scope: ChangeScope.BlockDefault})

    const iso = repo.block('iso'); await iso.load()
    const long = repo.block('long'); await long.load()

    expect(await referenceDateAdapter.setIso(iso, '2026-06-01')).toBe(true)
    expect(iso.peek()?.content).toBe('due [[2026-06-01]]')

    expect(await referenceDateAdapter.setIso(long, '2026-06-01')).toBe(true)
    expect(long.peek()?.content).toBe('meet [[June 1st, 2026]]')
  })

  it('can target the live CodeMirror document before persisted content catches up', async () => {
    const repo = makeRepo()
    await repo.tx(tx => tx.create({
      id: 'edited', workspaceId: 'ws', parentId: null, orderKey: 'a',
      content: 'stale [[2026-05-01]]',
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('edited')
    await block.load()
    const editorView = fakeEditorView('live [[2026-05-01]]')
    const adapter = createEditorReferenceDateAdapter(editorView as never)

    expect(adapter.canHandle(block)).toBe(true)
    expect(await adapter.getCurrentIso(block)).toBe('2026-05-01')
    expect(await adapter.setIso(block, '2026-05-08')).toBe(true)

    expect(editorView.state.doc.toString()).toBe('live [[2026-05-08]]')
    expect(block.peek()?.content).toBe('live [[2026-05-08]]')
  })
})
