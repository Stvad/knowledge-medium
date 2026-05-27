// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { BlockData } from '@/data/api'
import { aliasesProp } from '@/data/properties.js'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import {
  labelForBlockData,
  searchAliasLabels,
  searchLinkTargetIdCandidates,
  searchLinkTargets,
  searchLinkTargetsProgressively,
  searchLinkTargetValueCandidates,
} from '../linkTargetAutocomplete.ts'

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
    registerKernelProcessors: false,
  })
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const create = async (args: {
  id: string
  content?: string
  aliases?: string[]
}) => {
  await env.repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: WS,
      parentId: null,
      orderKey: `key-${args.id}`,
      content: args.content ?? '',
      properties: args.aliases
        ? {[aliasesProp.name]: aliasesProp.codec.encode(args.aliases)}
        : {},
    })
  }, {scope: ChangeScope.BlockDefault})
}

const blockData = (id: string, content: string, aliases?: string[]): BlockData => ({
  id,
  workspaceId: WS,
  parentId: null,
  orderKey: `key-${id}`,
  content,
  properties: aliases ? {[aliasesProp.name]: aliases} : {},
  references: [],
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'u',
  updatedBy: 'u',
  deleted: false,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

describe('link target autocomplete helpers', () => {
  it('labels blocks by first alias, then content, then fallback', () => {
    expect(labelForBlockData({
      id: 'with-alias',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content: 'Content',
      properties: {[aliasesProp.name]: ['Page']},
      references: [],
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'u',
      updatedBy: 'u',
      deleted: false,
    }, 'fallback')).toBe('Page')

    expect(labelForBlockData({
      id: 'with-content',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content: 'Content',
      properties: {},
      references: [],
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'u',
      updatedBy: 'u',
      deleted: false,
    }, 'fallback')).toBe('Content')
  })

  it('searches aliases and content while de-duping content hits covered by aliases', async () => {
    await create({id: 'page', content: 'Dating notes', aliases: ['Dating']})
    await create({id: 'block', content: 'My Dating notes'})

    const out = await searchLinkTargets(env.repo, {
      workspaceId: WS,
      query: 'dating',
      limit: 10,
    })

    expect(out.aliases.map(match => match.blockId)).toEqual(['page'])
    expect(out.blocks.map(match => match.blockId)).toEqual(['block'])
  })

  it('keeps FTS exclusion matches even when fuzzy ranking cannot score the raw query', async () => {
    await create({id: 'keep', content: 'sync token'})
    await create({id: 'drop', content: 'sync wallet'})

    const out = await searchLinkTargets(env.repo, {
      workspaceId: WS,
      query: 'sync -wallet',
      limit: 10,
    })

    expect(out.blocks.map(match => match.blockId)).toEqual(['keep'])
  })

  it('can publish alias matches before slower content matches', async () => {
    const blockRows = deferred<BlockData[]>()
    const repo = {
      query: {
        aliasMatchesFuzzy: vi.fn(() => ({
          load: () => Promise.resolve([
            {alias: 'Dating', blockId: 'page', content: 'Dating notes', updatedAt: 1},
          ]),
        })),
        searchByContent: vi.fn(() => ({
          load: () => blockRows.promise,
        })),
      },
    } as unknown as Repo
    const phases: string[] = []

    const search = searchLinkTargetsProgressively(repo, {
      workspaceId: WS,
      query: 'dating',
      limit: 10,
    }, {
      onAliases: aliases => {
        phases.push(`aliases:${aliases.map(alias => alias.blockId).join(',')}`)
      },
      onBlocks: blocks => {
        phases.push(`blocks:${blocks.map(block => block.blockId).join(',')}`)
      },
    })

    await vi.waitFor(() => expect(phases).toEqual(['aliases:page']))

    blockRows.resolve([
      blockData('page', 'Dating notes', ['Dating']),
      blockData('block', 'My Dating notes'),
    ])

    await expect(search).resolves.toEqual({
      aliases: [{alias: 'Dating', blockId: 'page', content: 'Dating notes'}],
      blocks: [{blockId: 'block', content: 'My Dating notes', label: 'My Dating notes'}],
    })
    expect(phases).toEqual(['aliases:page', 'blocks:block'])
  })

  it('skips the content scan for short queries (under 3 chars)', async () => {
    // Short prefixes (1-2 chars) match a huge fraction of any non-trivial
    // workspace's blocks. The substring LIKE scan that backs
    // `core.searchByContent` is O(workspace content bytes) regardless of
    // result count, and the rendered hits aren't useful at this length.
    // Aliases are index-backed and meaningful at any length, so they
    // still fire.
    const searchByContent = vi.fn()
    const repo = {
      query: {
        aliasMatchesFuzzy: vi.fn(() => ({
          load: () => Promise.resolve([
            {alias: 'Apples', blockId: 'page', content: 'Apples', updatedAt: 1},
          ]),
        })),
        searchByContent,
      },
    } as unknown as Repo

    const result = await searchLinkTargetsProgressively(repo, {
      workspaceId: WS,
      query: 'ap',
      limit: 10,
    })

    expect(searchByContent).not.toHaveBeenCalled()
    expect(result.aliases.map(match => match.blockId)).toEqual(['page'])
    expect(result.blocks).toEqual([])
  })

  it('searches distinct alias labels for CodeMirror page completion', async () => {
    await create({id: 'exact', aliases: ['Dating']})
    await create({id: 'prefix', aliases: ['Dating pool']})

    await expect(searchAliasLabels(env.repo, {
      workspaceId: WS,
      query: 'dating',
    })).resolves.toEqual(['Dating', 'Dating pool'])
  })

  it('matches out-of-order tokens (word skip)', async () => {
    await create({id: 'match', aliases: ['PR Review Skill']})
    await create({id: 'no-pr', aliases: ['Book Review']})

    const out = await searchAliasLabels(env.repo, {
      workspaceId: WS,
      query: 'review pr',
    })
    expect(out).toContain('PR Review Skill')
    expect(out).not.toContain('Book Review')
  })

  it('tolerates a single-char typo on tokens of length >= 4', async () => {
    await create({id: 'a', aliases: ['Apples']})

    const out = await searchAliasLabels(env.repo, {
      workspaceId: WS,
      query: 'appls',
    })
    expect(out).toEqual(['Apples'])
  })

  it('boosts recently-opened pages ahead of older matches', async () => {
    await create({id: 'older', aliases: ['Apple Tarte']})
    await create({id: 'recent', aliases: ['Apple Strudel']})

    const out = await searchAliasLabels(env.repo, {
      workspaceId: WS,
      query: 'apple',
      recentBlockIds: ['recent'],
    })
    expect(out).toEqual(['Apple Strudel', 'Apple Tarte'])
  })

  it('builds id candidates with excluded block ids', async () => {
    await create({id: 'page', content: 'Dating notes', aliases: ['Dating']})
    await create({id: 'block', content: 'My Dating notes'})

    const out = await searchLinkTargetIdCandidates(env.repo, {
      workspaceId: WS,
      query: 'dating',
      limit: 10,
      excludeIds: ['page'],
    })

    expect(out).toEqual([
      {id: 'block', label: 'My Dating notes', detail: 'My Dating notes'},
    ])
  })

  it('builds value candidates with excluded labels', async () => {
    await create({id: 'page', content: 'Dating notes', aliases: ['Dating']})
    await create({id: 'block', content: 'My Dating notes'})

    const out = await searchLinkTargetValueCandidates(env.repo, {
      workspaceId: WS,
      query: 'dating',
      limit: 10,
      excludeValues: ['Dating'],
    })

    expect(out.map(candidate => candidate.value)).toEqual(['My Dating notes'])
  })
})
