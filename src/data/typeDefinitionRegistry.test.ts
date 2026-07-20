import {describe, expect, it, vi} from 'vitest'
import {ChangeScope, type AnyPropertySchema} from '@/data/api'
import {typeDefinitionBlockId} from '@/data/definitionSeeds'
import type {TypeDefinitionMetadata} from '@/data/typeDefinitionMetadata'
import {seedProperty} from '@/data/propertySeeds'
import {seedType} from '@/data/typeSeeds'
import {
  buildTypeDefinitionRegistry,
  harvestNestedPropertySeeds,
  materializingTypeSeeds,
  type ProjectedTypeDefinition,
} from '@/data/typeDefinitionRegistry'

const WS = 'ws-type-registry'

const projected = (
  over: Partial<TypeDefinitionMetadata> & {blockId: string},
  properties: readonly AnyPropertySchema[] = [],
): ProjectedTypeDefinition => ({
  metadata: {
    typeId: over.typeId ?? over.blockId,
    blockId: over.blockId,
    workspaceId: over.workspaceId ?? WS,
    createdAt: over.createdAt ?? 100,
    label: over.label ?? 'Label',
    hideFromCompletion: over.hideFromCompletion ?? false,
    hideFromBlockDisplay: over.hideFromBlockDisplay ?? false,
    ...(over.description !== undefined ? {description: over.description} : {}),
    ...(over.color !== undefined ? {color: over.color} : {}),
    ...(over.seedKey !== undefined ? {seedKey: over.seedKey} : {}),
  },
  properties,
})

const asMap = (defs: readonly ProjectedTypeDefinition[]) =>
  new Map(defs.map(d => [d.metadata.blockId, d]))

const PAGE_KEY = 'system:kernel-data/type/page'

describe('buildTypeDefinitionRegistry', () => {
  it('publishes each user row under its own block id (typeId == blockId)', () => {
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: 'a', label: 'Alpha'}),
        projected({blockId: 'b', label: 'Beta'}),
      ]),
      seeds: [],
    })
    expect(reg.typesById.get('a')).toMatchObject({id: 'a', label: 'Alpha'})
    expect(reg.blockIdByTypeId.get('b')).toBe('b')
    expect(reg.definitionsByBlockId.size).toBe(2)
  })

  it('synthesizes a declared seed even with no materialized row (backing-block-less)', () => {
    // A fresh/read-only client has the code declaration but no backing block yet;
    // the built-in type must still be present. blockIdByTypeId stays UNBOUND
    // until a real mirror materializes — the registry never predictively points
    // it at the deterministic id (which might be occupied by a non-seed block).
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: new Map(),
      seeds: [seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Page'})],
    })
    expect(reg.typesById.get('page')).toMatchObject({id: 'page', label: 'Page'})
    expect(reg.blockIdByTypeId.has('page')).toBe(false)
  })

  it('binds a materialized seed mirror to its declared id, ignoring a drifted stored claim', () => {
    // The row is a valid seed mirror (its seedKey is a live declaration) but its
    // stored block-type:type-id drifted to 'stale' (stale/tampered sync). The
    // declaration owns the membership id; the row only supplies its blockId.
    const blockId = typeDefinitionBlockId(WS, PAGE_KEY)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId, typeId: 'stale', seedKey: PAGE_KEY, label: 'Stale mirror'}),
      ]),
      seeds: [seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Page'})],
    })
    expect(reg.typesById.get('page')).toMatchObject({id: 'page', label: 'Page'})
    expect(reg.typesById.has('stale')).toBe(false)
    expect(reg.blockIdByTypeId.get('page')).toBe(blockId)
    // The row is still retained by its durable id for provenance / read-only gates.
    expect(reg.definitionsByBlockId.get(blockId)?.seedKey).toBe(PAGE_KEY)
  })

  it('publishes the DECLARED contribution for a seed, not the (stale) block mirror', () => {
    // The block mirror is stale (hideFromCompletion cleared, wrong label); a
    // deploy that changed the declaration must win so downstream validation uses
    // the current type shape.
    const blockId = typeDefinitionBlockId(WS, PAGE_KEY)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId, seedKey: PAGE_KEY, label: 'Old Label', hideFromCompletion: false}),
      ]),
      seeds: [seedType({seedKey: PAGE_KEY, revision: 2, id: 'page', label: 'Page', hideFromCompletion: true})],
    })
    expect(reg.typesById.get('page')).toMatchObject({label: 'Page', hideFromCompletion: true})
  })

  it('a forged/retired claim never shadows a LIVE declaration for that id', () => {
    // A forged row sits at the deterministic id for an invented /type/ key and
    // claims 'page' while 'page' is a live declaration. The declaration outranks it
    // (§7): 'page' stays the declared Page, and the impostor is retained for
    // provenance only — never published under 'page' nor under its own block id.
    const forgedKey = 'evil/type/x'
    const blockId = typeDefinitionBlockId(WS, forgedKey)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId, typeId: 'page', seedKey: forgedKey, label: 'Impostor'}),
      ]),
      seeds: [seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Page'})],
    })
    expect(reg.typesById.get('page')).toMatchObject({id: 'page', label: 'Page'})
    expect(reg.typesById.has(blockId)).toBe(false)
    expect(reg.definitionsByBlockId.get(blockId)?.seedKey).toBe(forgedKey)
  })

  it('republishes a retired seed (disabled plugin) under its real id, not its uuid', () => {
    // A plugin type materialized while enabled, then the plugin toggle went off: the
    // seed declaration is gone but the backing block persists at its deterministic id,
    // still claiming 'todo'. It must keep resolving as 'todo' (coherent persistence,
    // schema-unification §5.3) rather than splitting to the backing-block uuid — the
    // regression the demote-to-uuid behavior caused for toggleable seeded types.
    const TODO_KEY = 'system:todo/type/todo'
    const blockId = typeDefinitionBlockId(WS, TODO_KEY)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId, typeId: 'todo', seedKey: TODO_KEY, label: 'Todo'}),
      ]),
      seeds: [], // plugin disabled → declaration absent
    })
    expect(reg.typesById.get('todo')).toMatchObject({id: 'todo', label: 'Todo'})
    expect(reg.typesById.has(blockId)).toBe(false)
    expect(reg.blockIdByTypeId.get('todo')).toBe(blockId)
  })

  it('resolves competing retired rows for one undeclared id by earliest createdAt', () => {
    // Two rows claim 'todo' via different valid /type/ keys with no live declaration
    // (a real retired seed + a later forgery/second client). Earliest createdAt wins
    // — the §7 resolution that bounds §9's forgery residual so an early real seed
    // beats a late forgery.
    const keyEarly = 'system:todo/type/todo'
    const keyLate = 'evil/type/todo'
    const earlyId = typeDefinitionBlockId(WS, keyEarly)
    const lateId = typeDefinitionBlockId(WS, keyLate)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: lateId, typeId: 'todo', seedKey: keyLate, label: 'Forgery', createdAt: 200}),
        projected({blockId: earlyId, typeId: 'todo', seedKey: keyEarly, label: 'Real', createdAt: 100}),
      ]),
      seeds: [],
    })
    expect(reg.typesById.get('todo')).toMatchObject({label: 'Real'})
    expect(reg.blockIdByTypeId.get('todo')).toBe(earlyId)
  })

  it('does not let a retired row overwrite a genuine user row already published under that id', () => {
    // Abnormal but reachable (a deterministic-id caller / import / bridge eval can
    // mint a block-type block with a literal short id, not a fresh uuid): a genuine
    // user row's blockId equals a retired plugin type's claimed id. Step 2 publishes
    // the user row under 'todo'; step 3 must NOT clobber it with the retired row —
    // the user row wins, the retired row stays provenance-only.
    const retiredKey = 'system:todo/type/todo'
    const retiredId = typeDefinitionBlockId(WS, retiredKey)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: 'todo', label: 'My User Todo'}),
        projected({blockId: retiredId, typeId: 'todo', seedKey: retiredKey, label: 'Retired Plugin Todo'}),
      ]),
      seeds: [],
    })
    expect(reg.typesById.get('todo')).toMatchObject({id: 'todo', label: 'My User Todo'})
    expect(reg.blockIdByTypeId.get('todo')).toBe('todo')
    expect(reg.typesById.has(retiredId)).toBe(false)
    expect(reg.definitionsByBlockId.get(retiredId)?.seedKey).toBe(retiredKey)
  })

  it('breaks an equal-createdAt tie between retired rows by lexicographically-lower blockId', () => {
    // Two retired rows claim 'todo' with the SAME createdAt; the stable blockId
    // tiebreak (lexicographically lower wins) keeps resolution deterministic across
    // clients regardless of projected-row iteration order.
    const keyA = 'system:todo/type/todo'
    const keyB = 'evil/type/todo'
    const idA = typeDefinitionBlockId(WS, keyA)
    const idB = typeDefinitionBlockId(WS, keyB)
    const lower = idA < idB ? idA : idB
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: idA, typeId: 'todo', seedKey: keyA, label: 'A', createdAt: 100}),
        projected({blockId: idB, typeId: 'todo', seedKey: keyB, label: 'B', createdAt: 100}),
      ]),
      seeds: [],
    })
    expect(reg.typesById.get('todo')).toMatchObject({label: lower === idA ? 'A' : 'B'})
    expect(reg.blockIdByTypeId.get('todo')).toBe(lower)
  })

  it('excludes rows from a foreign workspace', () => {
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: 'here'}),
        projected({blockId: 'there', workspaceId: 'other-ws'}),
      ]),
      seeds: [],
    })
    expect(reg.definitionsByBlockId.has('here')).toBe(true)
    expect(reg.definitionsByBlockId.has('there')).toBe(false)
    expect(reg.typesById.has('there')).toBe(false)
  })

  it('carries display fields and resolved properties onto a user contribution, omitting falsy ones', () => {
    const schema = {name: 'due'} as unknown as AnyPropertySchema
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected(
          {blockId: 'full', label: 'Task', description: 'A task', color: 'tomato', hideFromCompletion: true},
          [schema],
        ),
        projected({blockId: 'bare', label: 'Bare'}),
      ]),
      seeds: [],
    })
    expect(reg.typesById.get('full')).toEqual({
      id: 'full',
      label: 'Task',
      description: 'A task',
      color: 'tomato',
      hideFromCompletion: true,
      properties: [schema],
    })
    const bare = reg.typesById.get('bare')!
    expect(bare).toEqual({id: 'bare', label: 'Bare', properties: []})
    expect(bare).not.toHaveProperty('description')
  })

  it('fails closed on two seeds claiming one membership id (keeps the first)', () => {
    // A plugin/dynamic seed reusing a built-in id must be observable, not a
    // silent last-wins hijack of the published type shape.
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: new Map(),
      seeds: [
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Real Page'}),
        seedType({seedKey: 'evil/type/page', revision: 1, id: 'page', label: 'Impostor Page'}),
      ],
    })
    expect(reg.typesById.get('page')).toMatchObject({label: 'Real Page'})
  })

  it('retains an inactive (dup-id-loser) seed mirror for provenance only, not as a user type', () => {
    // seed A wins the 'page' id; seed B (different key, same id) is dropped. A
    // materialized mirror of the LOSER must not resurface as a separate
    // user-selectable type — it's code-owned, kept only in definitionsByBlockId.
    const loserKey = 'evil/type/page'
    const loserMirrorId = typeDefinitionBlockId(WS, loserKey)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: loserMirrorId, seedKey: loserKey, label: 'Impostor Page'}),
      ]),
      seeds: [
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Real Page'}),
        seedType({seedKey: loserKey, revision: 1, id: 'page', label: 'Impostor Page'}),
      ],
    })
    expect(reg.typesById.get('page')).toMatchObject({label: 'Real Page'})
    expect(reg.typesById.has(loserMirrorId)).toBe(false)
    expect(reg.definitionsByBlockId.get(loserMirrorId)?.seedKey).toBe(loserKey)
  })

  it('does not bind a seed to a non-seed row squatting its deterministic backing id', () => {
    // A poisoned row sits at the seed's backing id without valid seed provenance.
    // The declared seed stays published, but must not be bound to that row —
    // getTypeBlockId('page') must not resolve to a non-seed block.
    const backingId = typeDefinitionBlockId(WS, PAGE_KEY)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([projected({blockId: backingId, label: 'Poison'})]),
      seeds: [seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Page'})],
    })
    expect(reg.typesById.get('page')).toMatchObject({label: 'Page'})
    expect(reg.blockIdByTypeId.has('page')).toBe(false)
    // The squatter is still published as an ordinary type under its own id.
    expect(reg.typesById.get(backingId)).toMatchObject({id: backingId, label: 'Poison'})
  })

  it('indexes declared seeds by key, keeping the first on a duplicate key and recording it as contested', () => {
    const TODO_KEY = 'system:kernel-data/type/todo'
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: new Map(),
      seeds: [
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Page'}),
        seedType({seedKey: TODO_KEY, revision: 1, id: 'todo', label: 'Todo'}),
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Duplicate'}),
      ],
    })
    expect(reg.seedsByKey.size).toBe(2)
    expect(reg.seedsByKey.get(PAGE_KEY)?.label).toBe('Page')
    // In-memory resolution keeps the first (transient, rebuilt each load)...
    expect(reg.typesById.get('page')).toMatchObject({label: 'Page'})
    // ...but the contested key is flagged so the create/restore-only materializer
    // withholds its order-dependent backing row; the uncontested key is not.
    expect(reg.contestedSeedKeys.has(PAGE_KEY)).toBe(true)
    expect(reg.contestedSeedKeys.has(TODO_KEY)).toBe(false)
  })

  it('refuses getTypeBlockId for an already-mirrored seed whose KEY is now contested', () => {
    // A backing row exists (materialized when the key was uncontested); a later
    // load adds a second contribution with the same key. The materializer can't
    // delete the row, so `getTypeBlockId` must fail closed rather than point at the
    // stale, order-dependent mirror.
    const backingId = typeDefinitionBlockId(WS, PAGE_KEY)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([projected({blockId: backingId, seedKey: PAGE_KEY, label: 'First'})]),
      seeds: [
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'first', label: 'First'}),
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'second', label: 'Second'}),
      ],
    })
    expect(reg.contestedSeedKeys.has(PAGE_KEY)).toBe(true)
    // Provenance is retained (the read-only gate still recognizes the row)...
    expect(reg.definitionsByBlockId.has(backingId)).toBe(true)
    // ...but the block-id binding is refused until the duplicate key is removed.
    expect(reg.blockIdByTypeId.has('first')).toBe(false)
  })

  it('winner-resolves a membership-ID collision to the lowest seed key and binds only its mirror', () => {
    const KEY_B = 'system:kernel-data/type/todo' // sorts after PAGE_KEY ('page' < 'todo')
    const winnerBlockId = typeDefinitionBlockId(WS, PAGE_KEY)
    const loserBlockId = typeDefinitionBlockId(WS, KEY_B)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      // Both installs already materialized a mirror; both carry valid provenance.
      projectedDefinitions: asMap([
        projected({blockId: winnerBlockId, seedKey: PAGE_KEY, label: 'A'}),
        projected({blockId: loserBlockId, seedKey: KEY_B, label: 'B'}),
      ]),
      // Distinct keys, same membership id → winner-resolved (not withheld).
      seeds: [
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'shared', label: 'A'}),
        seedType({seedKey: KEY_B, revision: 1, id: 'shared', label: 'B'}),
      ],
    })
    // The lowest-seed-key seed (PAGE_KEY) wins id 'shared': it publishes and its
    // mirror binds getTypeBlockId, so the type resolves to one stable block instead
    // of failing closed.
    expect(reg.seedKeyById.get('shared')).toBe(PAGE_KEY)
    expect(reg.typesById.get('shared')).toMatchObject({label: 'A'})
    expect(reg.blockIdByTypeId.get('shared')).toBe(winnerBlockId)
    // The loser's mirror stays provenance-only (the read-only gate still recognizes
    // it) but never rebinds 'shared' to its own block.
    expect(reg.definitionsByBlockId.has(loserBlockId)).toBe(true)
    expect(reg.blockIdByTypeId.get('shared')).not.toBe(loserBlockId)
  })

  it('winner-resolution is order-independent (contribution order does not change the winner)', () => {
    const KEY_B = 'system:kernel-data/type/todo'
    const build = (seeds: Parameters<typeof buildTypeDefinitionRegistry>[0]['seeds']) =>
      buildTypeDefinitionRegistry({workspaceId: WS, projectedDefinitions: new Map(), seeds})
    const lowFirst = build([
      seedType({seedKey: PAGE_KEY, revision: 1, id: 'shared', label: 'A'}),
      seedType({seedKey: KEY_B, revision: 1, id: 'shared', label: 'B'}),
    ])
    const highFirst = build([
      seedType({seedKey: KEY_B, revision: 1, id: 'shared', label: 'B'}),
      seedType({seedKey: PAGE_KEY, revision: 1, id: 'shared', label: 'A'}),
    ])
    // Either order picks the lowest seed key — the whole point vs a keep-first pick,
    // whose winner (and materialized backing block) would flip with load order.
    expect(lowFirst.seedKeyById.get('shared')).toBe(PAGE_KEY)
    expect(highFirst.seedKeyById.get('shared')).toBe(PAGE_KEY)
    expect(highFirst.typesById.get('shared')).toMatchObject({label: 'A'})
  })
})

// A minimal own-owned property seed for the given owner (`<owner>/property/<name>`).
const prop = (owner: string, name: string) => seedProperty({
  seedKey: `${owner}/property/${name}`,
  revision: 1,
  name: `${owner}:${name}`,
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const snapshotOf = (seeds: Parameters<typeof buildTypeDefinitionRegistry>[0]['seeds']) =>
  buildTypeDefinitionRegistry({workspaceId: WS, projectedDefinitions: new Map(), seeds})

describe('materializingTypeSeeds', () => {
  it('returns the winners and excludes a contested-KEY seed', () => {
    const DUP = 'system:test/type/dup'
    const clean = seedType({seedKey: 'system:test/type/clean', revision: 1, id: 'clean', label: 'Clean'})
    const snap = snapshotOf([
      seedType({seedKey: DUP, revision: 1, id: 'a', label: 'A'}),
      seedType({seedKey: DUP, revision: 1, id: 'b', label: 'B'}), // same key → contested
      clean,
    ])
    const keys = materializingTypeSeeds(snap).map(s => s.seedKey)
    expect(keys).toContain('system:test/type/clean')
    // The contested key's keep-first winner is order-dependent, so it never materializes.
    expect(keys).not.toContain(DUP)
  })
})

describe('harvestNestedPropertySeeds', () => {
  it('auto-contributes an own-owned inline property that was not seeded separately', () => {
    const color = prop('plugin:demo', 'color')
    const snap = snapshotOf([
      seedType({seedKey: 'plugin:demo/type/widget', revision: 1, id: 'widget', label: 'W', properties: [color]}),
    ])
    const harvested = harvestNestedPropertySeeds(snap, [])
    expect(harvested).toEqual([color])
  })

  it('does NOT re-contribute a property already seeded separately (gap-fill; else the registry throws on a dup key)', () => {
    const color = prop('plugin:demo', 'color')
    const snap = snapshotOf([
      seedType({seedKey: 'plugin:demo/type/widget', revision: 1, id: 'widget', label: 'W', properties: [color]}),
    ])
    expect(harvestNestedPropertySeeds(snap, [color])).toEqual([])
  })

  it('leaves a CROSS-owner reference as a pure ref (a type never materializes another owner’s property)', () => {
    const foreign = prop('plugin:other', 'color') // owner differs from the type
    const snap = snapshotOf([
      seedType({seedKey: 'plugin:demo/type/widget', revision: 1, id: 'widget', label: 'W', properties: [foreign]}),
    ])
    expect(harvestNestedPropertySeeds(snap, [])).toEqual([])
  })

  it('harvests only from the WINNING type seed, never a loser install’s nested property', () => {
    // Two installs collide on id 'widget'; the lower seed key (owner-a) wins.
    const propA = prop('owner-a', 'color')
    const propB = prop('owner-b', 'color')
    const snap = snapshotOf([
      seedType({seedKey: 'owner-a/type/widget', revision: 1, id: 'widget', label: 'A', properties: [propA]}),
      seedType({seedKey: 'owner-b/type/widget', revision: 1, id: 'widget', label: 'B', properties: [propB]}),
    ])
    const harvested = harvestNestedPropertySeeds(snap, [])
    // Only the winner's property is auto-contributed; the loser's would orphan (its
    // type never materializes to reference it).
    expect(harvested).toEqual([propA])
  })

  it('warns on an own-owned STUB ref that is neither a full declaration nor seeded separately', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stubType = seedType({
      seedKey: 'plugin:demo/type/widget',
      revision: 1,
      id: 'widget',
      label: 'W',
      // A bare ref (valid /property/ key, own owner) that carries no preset/codec →
      // nothing to materialize, so its block-type:properties ref will dangle.
      properties: [{seedKey: 'plugin:demo/property/ghost'} as unknown as AnyPropertySchema],
    })
    const harvested = harvestNestedPropertySeeds(snapshotOf([stubType]), [])
    expect(harvested).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plugin:demo/property/ghost'))
    warn.mockRestore()
  })
})
