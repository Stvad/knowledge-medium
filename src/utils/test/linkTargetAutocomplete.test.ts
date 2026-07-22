// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { BlockData } from '@/data/api'
import { aliasesProp } from '@/data/properties.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { searchSourcesFacet, type SearchSourceContribution } from '@/data/facets.js'
import {
  labelForBlockData,
  searchAliasLabels,
  searchBlocksAcrossSources,
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
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
  })
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

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
  userUpdatedAt: 1,
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
      userUpdatedAt: 1,
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
      userUpdatedAt: 1,
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

  it('boosts recent block content matches without filtering FTS rows through fuzzy rank', async () => {
    await create({id: 'older', content: 'sync alpha'})
    await create({id: 'newer', content: 'sync beta'})

    const out = await searchLinkTargets(env.repo, {
      workspaceId: WS,
      query: 'sync',
      limit: 10,
      recentBlockIds: ['older'],
    })

    expect(out.blocks.map(match => match.blockId)).toEqual(['older', 'newer'])
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

  it('ranks an exact alias first even when prefix-sharing aliases crowd the pre-filter', async () => {
    // "backup dancer" is a real partial match; the "dana NN" rows only
    // share the 3-char filter prefix ("dan") and never match the full
    // "dancer" token, so they exist purely to overflow the candidate pool
    // the pre-filter LIMIT pulls before JS ranking. The exact alias is
    // created last, so an unordered LIMIT evicts it from the pool.
    await create({id: 'partial', aliases: ['backup dancer']})
    for (let i = 0; i < 30; i++) {
      await create({id: `decoy-${i}`, aliases: [`dana ${String(i).padStart(2, '0')}`]})
    }
    await create({id: 'exact', aliases: ['dancer']})

    const out = await searchLinkTargetIdCandidates(env.repo, {
      workspaceId: WS,
      query: 'dancer',
      limit: 5,
    })

    expect(out[0]).toMatchObject({id: 'exact', label: 'dancer'})
    expect(out.map(candidate => candidate.id)).toContain('partial')
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

describe('searchBlocksAcrossSources (searchSourcesFacet merge point)', () => {
  it('with no extra sources contributed, reproduces the pre-facet default ranking (exact > prefix > substring)', async () => {
    // Same score buckets `orderBlockSearchRows` used to compute inline —
    // this pins that `coreContentSearchSource` alone (the only
    // `searchSourcesFacet` contribution here) is a behavior-preserving
    // relocation of that logic, not a rewrite.
    await create({id: 'substring', content: 'we love dating shows'})
    await create({id: 'exact', content: 'dating'})
    await create({id: 'prefix', content: 'dating apps'})

    const results = await searchBlocksAcrossSources(env.repo, {
      workspaceId: WS,
      query: 'dating',
      limit: 10,
    })

    expect(results.map(block => block.id)).toEqual(['exact', 'prefix', 'substring'])

    // limit:0 yields 0 results even though the (mocked or real) source
    // doesn't itself enforce the hint.
    expect(await searchBlocksAcrossSources(env.repo, {workspaceId: WS, query: 'dating', limit: 0})).toEqual([])
  })

  it('honors a limit above the candidate ceiling — fetchLimit floors at `limit`, not capped at 200', async () => {
    // Old fetchLimit formula was `min(limit*4, 200)`, so any requested
    // limit above 200 (e.g. an agent `search --limit 250`) capped the
    // underlying SQL fetch at 200 regardless of how many rows the
    // caller actually wanted — silently truncating results a direct
    // `searchByContent({limit})` call would have returned in full. Mock
    // `searchByContent` to honor whatever limit it's asked for (like the
    // real query does) and assert all 250 rows make it through the
    // merge to the final result.
    const requestedLimit = 250
    const rows = Array.from({length: requestedLimit}, (_, i) =>
      blockData(`row-${i}`, `dating item ${String(i).padStart(3, '0')}`))
    const searchByContent = vi.fn(({limit}: {limit: number}) => ({
      load: () => Promise.resolve(rows.slice(0, limit)),
    }))
    const repo = {
      query: {searchByContent},
    } as unknown as Repo

    const results = await searchBlocksAcrossSources(repo, {
      workspaceId: WS,
      query: 'dating',
      limit: requestedLimit,
    })

    expect(results).toHaveLength(requestedLimit)
  })

  it('merges a plugin-contributed second source with core content search, ranked by score', async () => {
    // Core's own hit is a prefix match (score 200); the toy source
    // reports a higher score for a block core's text scorer would never
    // surface (no literal substring overlap) — standing in for e.g. a
    // semantic-search extension.
    await create({id: 'core-hit', content: 'sync notes'})
    const semanticHit = blockData('semantic-hit', 'totally unrelated content')

    const toySource: SearchSourceContribution = {
      id: 'test.toy',
      search: async () => [{block: semanticHit, score: 250}],
    }
    env.repo.setRuntimeContributions(searchSourcesFacet, 'test:toy-source', [toySource])

    const results = await searchBlocksAcrossSources(env.repo, {
      workspaceId: WS,
      query: 'sync',
      limit: 10,
    })

    expect(results.map(block => block.id)).toEqual(['semantic-hit', 'core-hit'])
  })

  it('dedupes a block id contributed by two sources, ranking by the max score but keeping the freshest payload', async () => {
    // Core matches "shared" as a prefix hit (score 200) with its real DB
    // content and a real (freshly-written) `userUpdatedAt`. The toy
    // source reports the SAME block id at a higher score (999) but with
    // a STALE payload (`blockData`'s default `userUpdatedAt: 1`) —
    // standing in for an index copy of the block that's fallen behind
    // live data. The surviving RANK must reflect the higher score (so a
    // confident source still promotes the row over a lower-scored one),
    // but the surviving PAYLOAD must be the fresher, real copy — not the
    // stale content that happened to win on score alone.
    await create({id: 'shared', content: 'sync notes'})
    await create({id: 'lower-score', content: 'sync other stuff'})
    const stale = blockData('shared', 'STALE BOOSTED CONTENT')

    const toySource: SearchSourceContribution = {
      id: 'test.toy',
      search: async () => [{block: stale, score: 999}],
    }
    env.repo.setRuntimeContributions(searchSourcesFacet, 'test:toy-source', [toySource])

    const results = await searchBlocksAcrossSources(env.repo, {
      workspaceId: WS,
      query: 'sync',
      limit: 10,
    })

    // 'shared' ranks first — its surviving score is the toy source's
    // 999, not core's own (lower) text-match score.
    expect(results.map(block => block.id)).toEqual(['shared', 'lower-score'])
    // ...but its payload is the fresher, real DB copy — not the stale
    // toy-source content that won on score.
    expect(results[0].content).toBe('sync notes')
  })

  it('drops a source that throws without failing the others', async () => {
    await create({id: 'core-hit', content: 'sync notes'})

    const brokenSource: SearchSourceContribution = {
      id: 'test.broken',
      search: async () => {
        throw new Error('boom')
      },
    }
    env.repo.setRuntimeContributions(searchSourcesFacet, 'test:broken-source', [brokenSource])

    const results = await searchBlocksAcrossSources(env.repo, {
      workspaceId: WS,
      query: 'sync',
      limit: 10,
    })

    expect(results.map(block => block.id)).toEqual(['core-hit'])
  })

  it('rethrows when every contributed source fails, instead of resolving to an empty result', async () => {
    // The single-source/fallback case (no `searchSourcesFacet` runtime
    // wired at all) is the common shape this regresses: before the fix,
    // a throwing `coreContentSearchSource` was swallowed to `[]` here,
    // silently hiding a failed `searchByContent` call from every
    // consumer (the agent `search` command, quick-find). Per-source
    // isolation (the test above) still holds when at least one source
    // succeeds — this only rethrows when ALL of them fail.
    const repo = {
      query: {
        searchByContent: vi.fn(() => ({
          load: () => Promise.reject(new Error('db exploded')),
        })),
      },
    } as unknown as Repo

    await expect(searchBlocksAcrossSources(repo, {
      workspaceId: WS,
      query: 'sync',
      limit: 10,
    })).rejects.toThrow('db exploded')
  })
})
