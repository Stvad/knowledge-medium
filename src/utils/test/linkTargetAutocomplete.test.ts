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

  it('can publish alias matches before slower content matches', async () => {
    const blockRows = deferred<BlockData[]>()
    const repo = {
      query: {
        aliasMatches: vi.fn(() => ({
          load: () => Promise.resolve([
            {alias: 'Dating', blockId: 'page', content: 'Dating notes'},
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

  it('searches distinct alias labels for CodeMirror page completion', async () => {
    await create({id: 'exact', aliases: ['Dating']})
    await create({id: 'prefix', aliases: ['Dating pool']})

    await expect(searchAliasLabels(env.repo, {
      workspaceId: WS,
      query: 'dating',
    })).resolves.toEqual(['Dating', 'Dating pool'])
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
