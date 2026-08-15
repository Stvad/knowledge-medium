// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { BlockData, TypeContribution } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { searchSourcesFacet, type SearchSourceContribution } from '@/data/facets.js'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import {
  completionTypeHint,
  displayableTypes,
  labelForBlockData,
  searchAliasLabels,
  searchBlocksAcrossSources,
  widenedFetchLimit,
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
  types?: string[]
}) => {
  await env.repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: WS,
      parentId: null,
      orderKey: `key-${args.id}`,
      content: args.content ?? '',
      properties: {
        ...(args.aliases ? {[aliasesProp.name]: aliasesProp.codec.encode(args.aliases)} : {}),
        ...(args.types ? {[typesProp.name]: typesProp.codec.encode(args.types)} : {}),
      },
    })
  }, {scope: ChangeScope.BlockDefault})
}

/** `searchAliasLabels` returns `{label, typeIds}` rows; most assertions
 *  here only care about the labels and their order. */
const labelsOf = async (args: {
  query: string
  recentBlockIds?: string[]
  limit?: number
}): Promise<string[]> =>
  (await searchAliasLabels(env.repo, {workspaceId: WS, ...args})).map(row => row.label)

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

const typeRegistry = (
  ...types: {id: string; label?: string; hideFromBlockDisplay?: boolean}[]
): ReadonlyMap<string, TypeContribution> => new Map(types.map(type => [type.id, type]))

describe('completionTypeHint', () => {
  it('names the first display-worthy type', () => {
    expect(completionTypeHint(
      ['page', 'person'],
      typeRegistry({id: 'page', label: 'Page', hideFromBlockDisplay: true}, {id: 'person', label: 'Person'}),
    )).toBe('Person')
  })

  it('skips plumbing types whose chip is hidden on the block itself', () => {
    // `page` sits on every page — annotating every dropdown row with it
    // is noise, which is exactly what hideFromBlockDisplay already means.
    expect(completionTypeHint(
      ['page'],
      typeRegistry({id: 'page', label: 'Page', hideFromBlockDisplay: true}),
    )).toBeUndefined()
  })

  it('skips ids the registry does not know rather than showing a raw id', () => {
    expect(completionTypeHint(['b7f2-uuid'], typeRegistry())).toBeUndefined()
  })

  it('skips a registered type that has no label to show', () => {
    expect(completionTypeHint(['nameless'], typeRegistry({id: 'nameless'}))).toBeUndefined()
  })

  it('returns undefined for an untyped block', () => {
    expect(completionTypeHint([], typeRegistry())).toBeUndefined()
  })
})

describe('displayableTypes', () => {
  it('keeps every display-worthy type, in the order the block stores them', () => {
    // The hint takes the first; a chip row shows several, so the filter
    // has to be a list rather than a single winner.
    expect(displayableTypes(
      ['page', 'person', 'author'],
      typeRegistry(
        {id: 'page', label: 'Page', hideFromBlockDisplay: true},
        {id: 'person', label: 'Person'},
        {id: 'author', label: 'Author'},
      ),
    ).map(({label}) => label)).toEqual(['Person', 'Author'])
  })

  it('hands back the registry contribution, not just a name', () => {
    // The chip colors itself from the contribution; resolving the label
    // and then re-looking-up the type to paint it would be two lookups
    // that can disagree.
    const person = {id: 'person', label: 'Person'}

    expect(displayableTypes(['person'], typeRegistry(person)))
      .toEqual([{typeId: 'person', type: person, label: 'Person'}])
  })

  it('shows a repeated id once', () => {
    // A raw properties-bag write (agent verb, importer, sync-applied row)
    // can repeat an id; two identical chips read as two tags.
    expect(displayableTypes(['person', 'person'], typeRegistry({id: 'person', label: 'Person'})))
      .toHaveLength(1)
  })
})

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

  // The sources slice to `limit` before exclusions are applied, so
  // without headroom the exclusion set is paid for out of the display
  // budget: exclude enough top-ranked matches and the caller gets "No
  // results" while real targets sat just past the cut. That bit the
  // move picker, which excludes a whole subtree; the fix belongs here
  // rather than in each caller's over-fetch.
  it('still returns `limit` survivors when the exclusion set outranks them', async () => {
    // Exact matches outrank the substring one (SCORE_BLOCK_FULL_EXACT vs
    // SCORE_BLOCK_FULL_SUBSTRING), so the excluded ids deterministically
    // occupy the whole `limit: 2` budget.
    const excluded = ['x1', 'x2', 'x3', 'x4', 'x5']
    for (const id of excluded) await create({id, content: 'refactor'})
    await create({id: 'survivor', content: 'a refactor plan'})

    const out = await searchLinkTargets(env.repo, {
      workspaceId: WS,
      query: 'refactor',
      limit: 2,
      excludeBlockIds: excluded,
    })

    expect(out.blocks.map(match => match.blockId)).toEqual(['survivor'])
  })

  it('carries each content match\'s types, with no second query to fetch them', async () => {
    // The rows behind a content match are whole `BlockData`, so a
    // consumer that wants to show what KIND of thing a result is gets it
    // off the row — unlike the ALIAS path, whose rows come from
    // `block_aliases` and need `loadTypeIdsByBlock` to fill the same gap.
    await create({id: 'ada', content: 'Ada Lovelace notes', types: ['person', 'author']})

    const out = await searchLinkTargets(env.repo, {
      workspaceId: WS,
      query: 'Lovelace',
      limit: 5,
    })

    expect(out.blocks.map(match => match.typeIds)).toEqual([['person', 'author']])
  })

  it('still returns `limit` alias survivors when the exclusion set outranks them', async () => {
    // Prefix matches outrank the substring one, so — as with the block
    // case above — the excluded ids deterministically fill `limit`.
    const excluded = ['a1', 'a2', 'a3', 'a4', 'a5']
    for (const id of excluded) await create({id, aliases: [`Roadmap ${id}`]})
    await create({id: 'survivor', aliases: ['Q3 Roadmap']})

    const out = await searchLinkTargets(env.repo, {
      workspaceId: WS,
      query: 'Roadmap',
      limit: 2,
      excludeBlockIds: excluded,
    })

    expect(out.aliases.map(match => match.blockId)).toEqual(['survivor'])
  })

  it('does not let an over-fetched alias suppress its block from the Blocks group', async () => {
    // The headroom fetch pulls alias candidates that then get sliced away.
    // If those still counted as "already shown as a page", a block whose
    // alias just missed the cut but whose CONTENT is the best match would
    // be filtered out of the Blocks group too and appear nowhere.
    // The exclusions exist only to buy headroom (fetchLimit = 1 + 3), so
    // the alias pass fetches BOTH aliases below and then slices to one.
    const excluded = ['e1', 'e2', 'e3']
    for (const id of excluded) await create({id, content: `Ledger ${id}`})

    // Exact alias match — takes the single Pages slot.
    await create({id: 'top-alias', aliases: ['Ledger']})
    // Substring alias, so it ranks second and gets sliced out of Pages —
    // but its CONTENT is the only surviving content match, so it has to
    // come back under Blocks.
    await create({id: 'hidden-alias', aliases: ['Q3 Ledger'], content: 'Ledger notes'})

    const out = await searchLinkTargets(env.repo, {
      workspaceId: WS,
      query: 'Ledger',
      limit: 1,
      excludeBlockIds: excluded,
    })

    expect(out.aliases.map(m => m.blockId)).toEqual(['top-alias'])
    expect(out.blocks.map(m => m.blockId)).toEqual(['hidden-alias'])
  })

  it('never returns more than `limit`, headroom notwithstanding', async () => {
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5']) await create({id, content: 'backlog'})

    const out = await searchLinkTargets(env.repo, {
      workspaceId: WS,
      query: 'backlog',
      limit: 2,
      excludeBlockIds: ['b1'],
    })

    expect(out.blocks).toHaveLength(2)
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
        // Alias rows carry no properties, so their types are a second
        // read — see `LinkTargetAliasMatch.typeIds`.
        blockTypesByIds: vi.fn(() => ({load: () => Promise.resolve([])})),
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
      aliases: [{alias: 'Dating', blockId: 'page', content: 'Dating notes', typeIds: []}],
      blocks: [{
        blockId: 'block',
        content: 'My Dating notes',
        label: 'My Dating notes',
        parentId: null,
        typeIds: [],
      }],
    })
    expect(phases).toEqual(['aliases:page', 'blocks:block'])
  })

  it('chunks the type read so a large result set does not reject the search', async () => {
    // `core.blockTypesByIds` validates blockIds at 200 and a zod failure
    // REJECTS — so handing it every surviving alias would lose the whole
    // search, not just the types, the moment a caller asked for more than
    // 200. Today's callers ask for 25, but the alias fetch deliberately
    // honours limits above its own ceiling, so the bound is the caller's.
    const aliasRows = Array.from({length: 250}, (_, i) => ({
      alias: `Dating ${i}`, blockId: `page-${i}`, content: `Dating ${i}`, updatedAt: 1,
    }))
    const blockTypesByIds = vi.fn(({blockIds}: {blockIds: string[]}) => ({
      load: () => Promise.resolve(blockIds.map(blockId => ({blockId, type: 'person'}))),
    }))
    const repo = {
      query: {
        aliasMatchesFuzzy: vi.fn(() => ({load: () => Promise.resolve(aliasRows)})),
        searchByContent: vi.fn(() => ({load: () => Promise.resolve([])})),
        blockTypesByIds,
      },
    } as unknown as Repo

    const result = await searchLinkTargetsProgressively(repo, {
      workspaceId: WS,
      query: 'dating',
      limit: 250,
    }, {})

    expect(result.aliases).toHaveLength(250)
    // Two reads, neither over the cap — and every row still got its type.
    const sizes = blockTypesByIds.mock.calls.map(([args]) => args.blockIds.length)
    expect(sizes).toEqual([200, 50])
    expect(result.aliases.every(alias => alias.typeIds.includes('person'))).toBe(true)
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
        blockTypesByIds: vi.fn(() => ({load: () => Promise.resolve([])})),
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

    expect(await labelsOf({query: 'dating'})).toEqual(['Dating', 'Dating pool'])
  })

  it('uses recently-opened page aliases for an empty CodeMirror completion query', async () => {
    await create({id: 'older', aliases: ['Older page']})
    await create({id: 'recent', aliases: ['Recent page', 'Recent alternate']})
    await create({id: 'not-recent', aliases: ['Not recent']})

    expect(await labelsOf({query: '', recentBlockIds: ['recent', 'older']}))
      .toEqual(['Recent page', 'Recent alternate', 'Older page'])
  })

  it('does not browse every workspace alias for an empty completion query', async () => {
    await create({id: 'page', aliases: ['Workspace page']})

    expect(await labelsOf({query: '', recentBlockIds: []})).toEqual([])
  })

  it('skips missing recent blocks and limits aliases without falling through to older pages', async () => {
    await create({id: 'recent', aliases: ['Recent page', 'Recent alternate']})
    await create({id: 'older', aliases: ['Older page']})

    expect(await labelsOf({query: '', recentBlockIds: ['recent', 'missing', 'older'], limit: 2}))
      .toEqual(['Recent page', 'Recent alternate'])
  })

  it('matches out-of-order tokens (word skip)', async () => {
    await create({id: 'match', aliases: ['PR Review Skill']})
    await create({id: 'no-pr', aliases: ['Book Review']})

    const out = await labelsOf({query: 'review pr'})
    expect(out).toContain('PR Review Skill')
    expect(out).not.toContain('Book Review')
  })

  it('tolerates a single-char typo on tokens of length >= 4', async () => {
    await create({id: 'a', aliases: ['Apples']})

    expect(await labelsOf({query: 'appls'})).toEqual(['Apples'])
  })

  it('carries the block type ids that back the dropdown type hint', async () => {
    await create({id: 'person', aliases: ['Ada Lovelace'], types: ['page', 'person']})
    await create({id: 'plain', aliases: ['Ada notes'], types: ['page']})

    const out = await searchAliasLabels(env.repo, {workspaceId: WS, query: 'ada'})
    const byLabel = new Map(out.map(row => [row.label, [...row.typeIds].sort()]))
    expect(byLabel.get('Ada Lovelace')).toEqual(['page', 'person'])
    expect(byLabel.get('Ada notes')).toEqual(['page'])
  })

  it('reports no types for an untyped page rather than dropping the row', async () => {
    await create({id: 'bare', aliases: ['Bare page']})

    const out = await searchAliasLabels(env.repo, {workspaceId: WS, query: 'bare'})
    expect(out).toEqual([{label: 'Bare page', typeIds: []}])
  })

  it('reads types on the empty-query MRU path too', async () => {
    await create({id: 'recent', aliases: ['Recent person'], types: ['page', 'person']})

    const out = await searchAliasLabels(env.repo, {
      workspaceId: WS,
      query: '',
      recentBlockIds: ['recent'],
    })
    expect(out).toEqual([{label: 'Recent person', typeIds: ['page', 'person']}])
  })

  it('does not leak types from a same-id block in another workspace', async () => {
    await create({id: 'here', aliases: ['Shared name'], types: ['page']})
    // Same block id is impossible, but a stale cross-workspace row in
    // block_types is not — the query is workspace-scoped so it must not
    // pick one up.
    await env.h.db.execute(
      `INSERT INTO block_types (block_id, workspace_id, type) VALUES (?, ?, ?)`,
      ['here', 'ws-other', 'person'],
    )

    const out = await searchAliasLabels(env.repo, {workspaceId: WS, query: 'shared'})
    expect(out).toEqual([{label: 'Shared name', typeIds: ['page']}])
  })

  /** Raw insert, bypassing `repo.tx` — a malformed `types` value cannot be
   *  written through the typed path, and going raw also keeps the row out
   *  of the block cache so the MRU read actually parses what is on disk. */
  const insertRaw = async (id: string, properties: Record<string, unknown>) => {
    await env.h.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
        references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
       VALUES (?, ?, NULL, ?, '', ?, '[]', 1, 1, 1, 'u', 'u', 0)`,
      [id, WS, `key-${id}`, JSON.stringify(properties)],
    )
  }

  it('survives a malformed types value on the MRU path', async () => {
    // The `types` column's on-disk contract is "ignore malformed
    // entries" — the maintenance trigger filters on
    // `typeof(je.value)='text'` and the invalidation rule filters
    // non-strings. A raw properties-bag write (agent-runtime
    // `updateBlock`, the MCP verb, an importer, a sync-applied row) can
    // land a non-array here. Running the string-list codec instead
    // throws a CodecError that rejects out through `getAliases` — which
    // has no try/catch above it — emptying the ENTIRE `[[` dropdown,
    // relative-date completions included.
    await insertRaw('bad', {alias: ['Malformed page'], types: 'person'})
    const {repo} = createTestRepo({db: env.h.db, user: {id: 'user-1'}})

    await expect(searchAliasLabels(repo, {
      workspaceId: WS,
      query: '',
      recentBlockIds: ['bad'],
    })).resolves.toEqual([{label: 'Malformed page', typeIds: []}])
  })

  it('keeps the good entries of a partly-malformed types list, matching the trigger', async () => {
    // Per-entry filtering, not all-or-nothing: the `block_types` trigger
    // behind the search path keeps `page`/`person` out of this list, so
    // the MRU path has to agree or the hint would flip between the
    // zero-input and typed states.
    await insertRaw('badlist', {alias: ['Malformed list'], types: ['page', null, 'person']})
    const {repo} = createTestRepo({db: env.h.db, user: {id: 'user-1'}})

    await expect(searchAliasLabels(repo, {
      workspaceId: WS,
      query: '',
      recentBlockIds: ['badlist'],
    })).resolves.toEqual([{label: 'Malformed list', typeIds: ['page', 'person']}])
  })

  it('reports types in authored order on BOTH paths, so the hint cannot flip', async () => {
    // `completionTypeHint` shows the FIRST display-worthy type, so the
    // two paths have to agree on order. Reading `block_types` returns
    // PK order (type-ascending), which would show "Author" for a typed
    // query and "Person" for the zero-input MRU list — the hint visibly
    // changing as you type the first character.
    await create({id: 'ada', aliases: ['Ada Lovelace'], types: ['person', 'author']})

    const typed = await searchAliasLabels(env.repo, {workspaceId: WS, query: 'ada'})
    const mru = await searchAliasLabels(env.repo, {
      workspaceId: WS,
      query: '',
      recentBlockIds: ['ada'],
    })

    expect(typed[0].typeIds).toEqual(['person', 'author'])
    expect(mru[0].typeIds).toEqual(['person', 'author'])
  })

  it('suppresses the hint when several live blocks claim the same alias', async () => {
    // The dropdown inserts an alias STRING; `core.aliasLookup` later
    // resolves it to the OLDEST claimant. Ranking can put a younger,
    // recently-opened claimant first, so showing that row's type would
    // advertise a type belonging to a different destination. Co-claims
    // are a documented latent state: the alias-uniqueness trigger is
    // skipped for sync-applied rows, which is what the raw insert below
    // imitates (it maintains block_aliases but fires no processor).
    await create({id: 'older', aliases: ['Ada'], types: ['page', 'location']})
    await env.h.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
        references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
       VALUES ('newer', ?, NULL, 'key-newer', '', ?, '[]', 9, 9, 9, 'u', 'u', 0)`,
      [WS, JSON.stringify({alias: ['Ada'], types: ['page', 'person']})],
    )

    const claimants = await env.h.db.getAll<{c: number}>(
      `SELECT count(*) AS c FROM block_aliases WHERE workspace_id = ? AND alias = 'Ada'`,
      [WS],
    )
    expect(claimants[0].c).toBe(2)

    const out = await searchAliasLabels(env.repo, {
      workspaceId: WS,
      query: 'ada',
      recentBlockIds: ['newer'],
    })
    expect(out).toEqual([{label: 'Ada', typeIds: []}])
  })

  describe('word-prefix-chain matching through the REAL SQL pipeline', () => {
    // fuzzyRank's chain tier is only ever offered candidates the SQL
    // pre-filter returned, and that pre-filter ANDs `alias_lower LIKE
    // '%<first 3 chars of each token>%'`. So a chain survives end-to-end
    // only when its FIRST chunk is at least 3 characters — which the
    // unit tests on `scoreCandidate` cannot see, because they never go
    // through SQL. These pin the difference.
    beforeEach(async () => {
      await create({id: 'meet', aliases: ['Meeting Notes']})
      await create({id: 'prod', aliases: ['Product Requirements Document']})
      await create({id: 'stren', aliases: ['Strength Training Program']})
      await create({id: 'sanfr', aliases: ['San Francisco']})
    })

    it('finds run-together word prefixes', async () => {
      expect(await labelsOf({query: 'meetnotes'})).toContain('Meeting Notes')
      expect(await labelsOf({query: 'prodreq'})).toContain('Product Requirements Document')
      expect(await labelsOf({query: 'strtrain'})).toContain('Strength Training Program')
    })

    it('does NOT find initialisms — the 3-char pre-filter drops them before ranking', async () => {
      // `scoreCandidate('Product Requirements Document', 'prd', ['prd'])`
      // scores these fine; `aliasMatchesFuzzy` requires a contiguous
      // "prd" in the alias and returns nothing to rank. Serving them
      // needs a pre-filter change, not a ranker change — see the note on
      // `matchesWordPrefixChain`.
      expect(await labelsOf({query: 'prd'})).not.toContain('Product Requirements Document')
      expect(await labelsOf({query: 'stp'})).not.toContain('Strength Training Program')
      expect(await labelsOf({query: 'sf'})).not.toContain('San Francisco')
    })
  })

  it('ignores a non-array types value on the SEARCH path too, matching the MRU path', async () => {
    // json_each happily walks a scalar and yields its text value, so
    // without an array guard a block storing `types: "person"` shows
    // "Person" for a typed query and nothing at `[[` — the two paths
    // disagreeing on exactly the malformed input the tolerance exists
    // for.
    await insertRaw('scalar', {alias: ['Scalar page'], types: 'person'})

    await expect(searchAliasLabels(env.repo, {workspaceId: WS, query: 'scalar'}))
      .resolves.toEqual([{label: 'Scalar page', typeIds: []}])
  })

  it('suppresses the hint for a co-claimed alias that ranking truncated', async () => {
    // Co-claim detection cannot run on the already-sliced ranked rows:
    // if the MRU-boosted claimant lands inside the display limit and the
    // canonical (oldest) one falls below the cutoff, the survivor list
    // shows a single claimant and the hint describes the wrong block.
    await create({id: 'older', aliases: ['Ada'], types: ['page', 'location']})
    await env.h.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
        references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
       VALUES ('newer', ?, NULL, 'key-newer', '', ?, '[]', 9, 9, 9, 'u', 'u', 0)`,
      [WS, JSON.stringify({alias: ['Ada'], types: ['page', 'person']})],
    )

    // limit=1 keeps only the MRU-boosted 'newer' row, which is the
    // straddling-the-cutoff shape without needing 50 decoys.
    await expect(searchAliasLabels(env.repo, {
      workspaceId: WS,
      query: 'ada',
      recentBlockIds: ['newer'],
      limit: 1,
    })).resolves.toEqual([{label: 'Ada', typeIds: []}])
  })

  it('boosts recently-opened pages ahead of older matches', async () => {
    await create({id: 'older', aliases: ['Apple Tarte']})
    await create({id: 'recent', aliases: ['Apple Strudel']})

    expect(await labelsOf({query: 'apple', recentBlockIds: ['recent']}))
      .toEqual(['Apple Strudel', 'Apple Tarte'])
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
    // 32 alias-bearing creates make this the one write-heavy test in the file
    // (~0.8s idle); the rest are far under. Contention pushes it at the 5s
    // default.
  }, 20_000)

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
  // A contributed source has no reason to know that some blocks' content is
  // not prose, so the merge point owns the guarantee rather than the
  // contract asking every source to remember.
  it('filters opaque blocks returned by a CONTRIBUTED source', async () => {
    await create({id: 'ext', content: 'dating source', types: ['extension']})
    await create({id: 'note', content: 'dating notes'})
    const rogue: SearchSourceContribution = {
      id: 'test.rogue',
      search: async (r) => [
        {block: (await r.load('ext'))!, score: 100},
        {block: (await r.load('note'))!, score: 1},
      ],
    }
    // kernelDataExtension included deliberately: it is what contributes
    // EXTENSION_TYPE to the opaque facet, and without it the set is empty
    // and this passes for the wrong reason.
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      searchSourcesFacet.of(rogue, {source: 'test'}),
    ]))

    const results = await searchBlocksAcrossSources(env.repo, {
      workspaceId: WS, query: 'dating', limit: 10,
    })

    expect(results.map(block => block.id)).toEqual(['note'])
  })

  // `freshestCandidatePayload` exists because a source may return a stale
  // index snapshot — so the authoritative check cannot trust the payload's
  // own `properties`. Here the source hands back a pre-tag copy of a block
  // that is opaque in the DB.
  it('filters on LIVE types, not the candidate payload\'s own properties', async () => {
    await create({id: 'ext', content: 'dating source'})
    const stalePayload = (await env.repo.load('ext'))!   // captured as prose
    await env.repo.tx(
      tx => tx.setProperty('ext', typesProp, ['extension']),
      {scope: ChangeScope.BlockDefault},
    )
    const stale: SearchSourceContribution = {
      id: 'test.stale-index',
      search: async () => [{block: stalePayload, score: 100}],
    }
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      searchSourcesFacet.of(stale, {source: 'test'}),
    ]))

    const results = await searchBlocksAcrossSources(env.repo, {
      workspaceId: WS, query: 'dating', limit: 10,
    })

    expect(results).toEqual([])
  })

  // `core.blockTypesByIds` caps its id array at 200 and REJECTS past that,
  // so the merge point's live-type lookup has to chunk: the agent search
  // command forwards an unbounded limit, and an unchunked call turns a
  // large search into a thrown validation error.
  it('survives a merged candidate set larger than the block-types id cap', async () => {
    for (let i = 0; i < 205; i++) {
      await create({id: `b-${String(i).padStart(3, '0')}`, content: `dating ${i}`})
    }

    const results = await searchBlocksAcrossSources(env.repo, {
      workspaceId: WS, query: 'dating', limit: 205,
    })

    expect(results.length).toBeGreaterThan(200)
  }, 20_000)

  // The recovery window must always EXCEED the fetch that came up short.
  // A fixed ceiling satisfies that only below the ceiling: `fetchLimit`
  // floors at `limit`, so at limit 201 the old ceiling-valued window was
  // smaller than the fetch and the recovery could never help. Asserted as
  // arithmetic rather than through the query — reproducing it end-to-end
  // needs 200+ seeded rows, and a smaller setup never fills the window, so
  // the behavioural test passes with the bug present.
  it.each([12, 48, 200, 201, 1000])('widens past a fetch window of %d', (fetchLimit) => {
    expect(widenedFetchLimit(fetchLimit)).toBeGreaterThan(fetchLimit)
  })

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

  // This source backs quick-find, block-ref completion and the agent search
  // command, so a bundle showing up here is pickable as a reference target.
  it('omits opaque-content blocks from content search', async () => {
    await create({id: 'note', content: 'dating notes'})
    await create({id: 'ext', content: 'const dating = 1', types: ['extension']})

    const results = await searchBlocksAcrossSources(env.repo, {
      workspaceId: WS,
      query: 'dating',
      limit: 10,
    })

    expect(results.map(block => block.id)).toEqual(['note'])
  })

  // `fetchLimit` for limit:1 is 4, so a handful of opaque hits ranked above
  // the note would otherwise return nothing at all.
  //
  // The note must rank BELOW the whole window or this proves nothing. The
  // SQL orders by match bucket (exact / prefix / other) and only then by
  // recency — and a fast test stamps every row in the same millisecond, so
  // recency is not a usable lever. The bucket is: the opaque rows are
  // PREFIX matches, the note only a substring one.
  it('widens the fetch when opaque rows crowd out the candidate window', async () => {
    for (let i = 0; i < 8; i++) {
      await create({id: `ext-${i}`, content: `dating ${i}`, types: ['extension']})
    }
    await create({id: 'note', content: 'my dating notes'})

    const results = await searchBlocksAcrossSources(env.repo, {
      workspaceId: WS,
      query: 'dating',
      limit: 1,
    })

    expect(results.map(block => block.id)).toEqual(['note'])
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

  // The ceiling used to cap the TOTAL, so any `limit >= ALIAS_CANDIDATE_CEILING`
  // asked sources for exactly `limit` — zero headroom, leaving the opaque
  // filter at the merge point nothing spare to drop. Same shape as the
  // widening bug that ceiling already caused once.
  it('asks contributed sources for headroom proportional to the limit', async () => {
    const seen: number[] = []
    const probe: SearchSourceContribution = {
      id: 'test.probe',
      search: async (_repo, sourceArgs) => { seen.push(sourceArgs.limit); return [] },
    }
    env.repo.setRuntimeContributions(searchSourcesFacet, 'test:probe', [probe])

    await searchBlocksAcrossSources(env.repo, {workspaceId: WS, query: 'sync', limit: 5})
    await searchBlocksAcrossSources(env.repo, {workspaceId: WS, query: 'sync', limit: 500})

    expect(seen).toEqual([20, 2000])
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
