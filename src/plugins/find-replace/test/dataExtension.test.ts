// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockData } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import {
  FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
  FIND_REPLACE_SEARCH_CONTENT_QUERY,
  findReplaceDataExtension,
} from '../dataExtension.ts'
import type {
  ApplyContentReplaceResult,
  ContentSearchResult,
} from '../types.ts'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

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
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    findReplaceDataExtension,
  ]))
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const create = async (args: {
  id: string
  content?: string
  workspaceId?: string
}) => {
  await env.repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: args.workspaceId ?? WS,
      parentId: null,
      orderKey: `key-${args.id}`,
      content: args.content ?? '',
    })
  }, {scope: ChangeScope.BlockDefault})
}

const load = (id: string): Promise<BlockData | null> =>
  env.repo.load(id)

const search = (args: {
  query: string
  workspaceId?: string
  matchCase?: boolean
  wholeWord?: boolean
  maxBlocks?: number
}): Promise<ContentSearchResult> =>
  env.repo.runQuery(FIND_REPLACE_SEARCH_CONTENT_QUERY, {
    workspaceId: args.workspaceId ?? WS,
    query: args.query,
    options: {
      matchCase: args.matchCase ?? false,
      wholeWord: args.wholeWord ?? false,
    },
    maxBlocks: args.maxBlocks,
  })

describe('findReplaceDataExtension', () => {
  it('searches live block content in one workspace', async () => {
    await create({id: 'a', content: 'Alpha beta alpha'})
    await create({id: 'b', content: 'alpha in other workspace', workspaceId: OTHER_WS})
    await create({id: 'c', content: 'nothing'})
    await env.repo.tx(tx => tx.delete('c'), {scope: ChangeScope.BlockDefault})

    const out = await search({query: 'alpha'})

    expect(out.matches.map(match => ({
      id: match.blockId,
      count: match.matchCount,
      content: match.originalContent,
    }))).toEqual([
      {id: 'a', count: 2, content: 'Alpha beta alpha'},
    ])
  })

  it('honors case and whole-word options', async () => {
    await create({id: 'a', content: 'Alpha alpha ALPHA'})
    await create({id: 'b', content: 'Alpha ALPHA betabet'})

    expect((await search({query: 'alpha', matchCase: true})).matches)
      .toMatchObject([{blockId: 'a', matchCount: 1}])
    const wholeWord = await search({query: 'alpha', wholeWord: true})
    expect(wholeWord.matches.map(match => ({id: match.blockId, count: match.matchCount})))
      .toEqual([
        {id: 'b', count: 2},
        {id: 'a', count: 3},
      ])
  })

  it('reports when search results are capped', async () => {
    await create({id: 'a', content: 'alpha'})
    await create({id: 'b', content: 'alpha'})

    const out = await search({query: 'alpha', maxBlocks: 1})

    expect(out.matches).toHaveLength(1)
    expect(out.truncated).toBe(true)
  })

  it('applies replacements from preview snapshots', async () => {
    await create({id: 'a', content: 'Alpha alpha'})
    await create({id: 'b', content: 'alpha'})
    const preview = await search({query: 'alpha'})

    const result = await env.repo.run<ApplyContentReplaceResult>(
      FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
      {
        workspaceId: WS,
        find: 'alpha',
        replace: 'omega',
        options: {matchCase: false, wholeWord: false},
        items: preview.matches.map(match => ({
          blockId: match.blockId,
          originalContent: match.originalContent,
        })),
      },
    )

    expect(result).toEqual({
      updatedBlocks: 2,
      replacements: 3,
      skippedChangedBlocks: 0,
      skippedUnavailableBlocks: 0,
    })
    expect((await load('a'))?.content).toBe('omega omega')
    expect((await load('b'))?.content).toBe('omega')
  })

  it('skips rows that changed after preview', async () => {
    await create({id: 'a', content: 'alpha'})
    const preview = await search({query: 'alpha'})
    await env.repo.tx(tx => tx.update('a', {content: 'alpha user edit'}), {
      scope: ChangeScope.BlockDefault,
    })

    const result = await env.repo.run<ApplyContentReplaceResult>(
      FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
      {
        workspaceId: WS,
        find: 'alpha',
        replace: 'omega',
        options: {matchCase: false, wholeWord: false},
        items: preview.matches.map(match => ({
          blockId: match.blockId,
          originalContent: match.originalContent,
        })),
      },
    )

    expect(result).toEqual({
      updatedBlocks: 0,
      replacements: 0,
      skippedChangedBlocks: 1,
      skippedUnavailableBlocks: 0,
    })
    expect((await load('a'))?.content).toBe('alpha user edit')
  })
})
