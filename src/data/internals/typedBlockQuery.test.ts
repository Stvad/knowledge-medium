// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  ChangeScope,
  seedProperty,
  seedType,
  type BlockReference,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { typesProp } from '@/data/properties'
import { definitionSeedsFacet, typeSeedsFacet } from '../facets'
import { kernelDataExtension } from '../kernelDataExtension'
import { Repo } from '../repo'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

// Test property fixtures — code-owned seeds so they resolve by name in the
// property registry (the type-lift that used to surface a type's embedded
// schemas is gone; a property must be a seed to be queryable/resolvable).
const statusProp = seedProperty({
  seedKey: 'test/property/status', revision: 1, name: 'status',
  preset: 'string', defaultValue: 'open', changeScope: ChangeScope.BlockDefault,
})

const doneProp = seedProperty({
  seedKey: 'test/property/done', revision: 1, name: 'done',
  preset: 'boolean', defaultValue: false, changeScope: ChangeScope.BlockDefault,
})

const priorityProp = seedProperty({
  seedKey: 'test/property/priority', revision: 1, name: 'priority',
  preset: 'number', defaultValue: 0, changeScope: ChangeScope.BlockDefault,
})

const dueProp = seedProperty({
  seedKey: 'test/property/due', revision: 1, name: 'due',
  preset: 'date', defaultValue: undefined, changeScope: ChangeScope.BlockDefault,
})

const weirdNameProp = seedProperty({
  seedKey: 'test/property/weird-name', revision: 1, name: 'weird:name.with-dot-hyphen',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})

const labelsProp = seedProperty({
  seedKey: 'test/property/labels', revision: 1, name: 'labels',
  preset: 'string-list', defaultValue: [], changeScope: ChangeScope.BlockDefault,
})

const reviewerProp = seedProperty({
  seedKey: 'test/property/reviewer', revision: 1, name: 'reviewer',
  preset: 'ref', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})

const queryProps = [statusProp, doneProp, priorityProp, dueProp, weirdNameProp, labelsProp, reviewerProp]

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
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
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    ...queryProps.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
    typeSeedsFacet.of(seedType({
      seedKey: 'test/type/typed-block-query-props',
      revision: 1,
      id: 'test:typed-block-query-props',
      label: 'Typed block query props',
      properties: queryProps,
    }), {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
// Dispose the per-test Repo's sync observer (some tests start it explicitly)
// so its db.onChange subscription doesn't leak onto the shared DB.
afterEach(() => { env.repo.stopSyncObserver() })

const create = async (args: {
  id: string
  workspaceId?: string
  types?: readonly string[]
  properties?: Record<string, unknown>
  references?: BlockReference[]
}) => {
  const properties = {...(args.properties ?? {})}
  if (args.types !== undefined) {
    properties[typesProp.name] = typesProp.codec.encode(args.types)
  }
  await env.repo.tx(tx => tx.create({
    id: args.id,
    workspaceId: args.workspaceId ?? WS,
    parentId: null,
    orderKey: `k-${args.id}`,
    properties,
    references: args.references ?? [],
  }), {scope: ChangeScope.BlockDefault})
}

const ids = (rows: readonly {id: string}[]) => rows.map(row => row.id)

describe('repo.queryBlocks', () => {
  it('rejects calls that omit workspaceId at the type level', () => {
    // PR #47 follow-up: TypedBlockQuery.workspaceId is required so
    // background flows / import runs can't silently fall back to
    // activeWorkspaceId. The `@ts-expect-error` lines below FAIL the
    // build if the field becomes optional again.
    //
    // We don't actually invoke the call (no `await`) — the type check
    // alone is the assertion. The `void` cast prevents the unused-
    // expression lint rule from firing.
    void (() => {
      // @ts-expect-error workspaceId is required on TypedBlockQuery
      env.repo.queryBlocks({types: ['todo']})
      // @ts-expect-error workspaceId is required on TypedBlockQuery
      env.repo.subscribeBlocks({types: ['todo']}, () => {})
      // queryActiveWorkspace / subscribeActiveWorkspace accept the
      // workspaceId-free shape — these must compile.
      env.repo.queryActiveWorkspace({types: ['todo']})
      env.repo.subscribeActiveWorkspace({types: ['todo']}, () => {})
    })
  })

  it('filters by any matching type and scalar where values without duplicate rows', async () => {
    await create({id: 'todo-open', types: ['todo'], properties: {status: 'open'}})
    await create({id: 'todo-done', types: ['todo'], properties: {status: 'done'}})
    await create({id: 'task-open', types: ['task', 'todo'], properties: {status: 'open'}})
    await create({id: 'other-open', types: ['project'], properties: {status: 'open'}})

    const out = await env.repo.queryBlocks({workspaceId: WS, 
      types: ['todo', 'task'],
      where: {status: 'open'},
    })

    expect(ids(out)).toEqual(['todo-open', 'task-open'])
  })

  it('quotes property names in JSON paths', async () => {
    await create({
      id: 'hit',
      types: ['todo'],
      properties: {[weirdNameProp.name]: 'yes'},
    })
    await create({
      id: 'miss',
      types: ['todo'],
      properties: {[weirdNameProp.name]: 'no'},
    })

    await expect(env.repo.queryBlocks({workspaceId: WS, 
      where: {[weirdNameProp.name]: 'yes'},
    })).resolves.toMatchObject([{id: 'hit'}])
  })

  it('matches null filters against missing and explicit-null properties', async () => {
    await create({id: 'missing', types: ['todo']})
    await create({id: 'nullish', types: ['todo'], properties: {status: null}})
    await create({id: 'set', types: ['todo'], properties: {status: 'open'}})

    const out = await env.repo.queryBlocks({workspaceId: WS, where: {status: null}})

    expect(ids(out)).toEqual(['missing', 'nullish'])
  })

  describe('where operators', () => {
    /** `dueProp.codec.date` encodes Date instances to ISO strings.
     *  Lexicographic comparison on ISO 8601 matches chronological order,
     *  so SQL `<` / `BETWEEN` work directly on the encoded form. */
    const encodeDate = (iso: string): unknown =>
      dueProp.codec.encode(new Date(`${iso}T00:00:00.000Z`))

    it('comparator operators on a numeric property', async () => {
      await create({id: 'p1', properties: {[priorityProp.name]: priorityProp.codec.encode(1)}})
      await create({id: 'p2', properties: {[priorityProp.name]: priorityProp.codec.encode(2)}})
      await create({id: 'p3', properties: {[priorityProp.name]: priorityProp.codec.encode(3)}})

      const lt = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {lt: 3}}})
      expect(ids(lt).sort()).toEqual(['p1', 'p2'])

      const lte = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {lte: 2}}})
      expect(ids(lte).sort()).toEqual(['p1', 'p2'])

      const gt = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {gt: 1}}})
      expect(ids(gt).sort()).toEqual(['p2', 'p3'])

      const gte = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {gte: 2}}})
      expect(ids(gte).sort()).toEqual(['p2', 'p3'])

      const eq = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {eq: 2}}})
      expect(ids(eq)).toEqual(['p2'])
    })

    it('comparator operators on a date property', async () => {
      await create({id: 'past', properties: {[dueProp.name]: encodeDate('2026-01-01')}})
      await create({id: 'today', properties: {[dueProp.name]: encodeDate('2026-05-18')}})
      await create({id: 'future', properties: {[dueProp.name]: encodeDate('2026-12-31')}})

      const before = await env.repo.queryBlocks({workspaceId: WS, 
        where: {due: {lt: new Date('2026-05-18T00:00:00.000Z')}},
      })
      expect(ids(before)).toEqual(['past'])

      const onOrAfter = await env.repo.queryBlocks({workspaceId: WS, 
        where: {due: {gte: new Date('2026-05-18T00:00:00.000Z')}},
      })
      expect(ids(onOrAfter).sort()).toEqual(['future', 'today'])
    })

    it('accepts JSON-revived date operands (Date → ISO string after persist)', async () => {
      // Persisted predicates (e.g. backlinks:predicates) round-trip
      // through JSON, which turns Date instances into ISO strings.
      // The compiler re-runs where.encode on the rehydrated value;
      // it must accept the string form so saved date-range filters
      // still work after reload.
      await create({id: 'past', properties: {[dueProp.name]: encodeDate('2026-01-01')}})
      await create({id: 'future', properties: {[dueProp.name]: encodeDate('2026-12-31')}})

      const original = {due: {lt: new Date('2026-05-18T00:00:00.000Z')}}
      const persisted = JSON.parse(JSON.stringify(original)) as Record<string, unknown>
      const out = await env.repo.queryBlocks({workspaceId: WS, where: persisted})
      expect(ids(out)).toEqual(['past'])
    })

    it('between is inclusive on both ends', async () => {
      await create({id: 'p1', properties: {[priorityProp.name]: priorityProp.codec.encode(1)}})
      await create({id: 'p2', properties: {[priorityProp.name]: priorityProp.codec.encode(2)}})
      await create({id: 'p3', properties: {[priorityProp.name]: priorityProp.codec.encode(3)}})
      await create({id: 'p5', properties: {[priorityProp.name]: priorityProp.codec.encode(5)}})

      const out = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {between: [2, 3]}}})
      expect(ids(out).sort()).toEqual(['p2', 'p3'])
    })

    it('exists: true matches set, exists: false matches unset', async () => {
      await create({id: 'set', properties: {status: 'open'}})
      await create({id: 'missing', properties: {}})
      await create({id: 'nullish', properties: {status: null}})

      const set = await env.repo.queryBlocks({workspaceId: WS, where: {status: {exists: true}}})
      expect(ids(set)).toEqual(['set'])

      const unset = await env.repo.queryBlocks({workspaceId: WS, where: {status: {exists: false}}})
      expect(ids(unset).sort()).toEqual(['missing', 'nullish'])
    })

    it('rejects malformed operator objects with a clear message', async () => {
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {priority: {lt: 1, gt: 0}}}))
        .rejects.toThrow('operator object must have exactly one key')
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {priority: {bogus: 1}}}))
        .rejects.toThrow('unknown operator')
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {priority: {between: [1]}}}))
        .rejects.toThrow('between must be a [lo, hi] tuple')
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {status: {exists: 'yes'}}}))
        .rejects.toThrow('exists must be a boolean')
    })

    it('rejects comparator operators on non-where-queryable codecs', async () => {
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {reviewer: {eq: 'target'}}}))
        .rejects.toThrow('is not where-queryable')
    })

    it('traverses ref-typed properties via the target operator', async () => {
      // Realistic shape: a ref-typed property points at a "target"
      // block that carries its own queryable properties (the daily-
      // notes plugin's date property is the motivating case, but the
      // compiler is plugin-agnostic — anything with a where-queryable
      // codec on the target works).
      await create({
        id: 'past-target',
        properties: {[dueProp.name]: encodeDate('2026-01-01')},
      })
      await create({
        id: 'future-target',
        properties: {[dueProp.name]: encodeDate('2026-12-31')},
      })
      await create({id: 'unrelated-target'})
      await create({
        id: 'source-past',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('past-target')},
        references: [{id: 'past-target', alias: 'past-target', sourceField: 'reviewer'}],
      })
      await create({
        id: 'source-future',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('future-target')},
        references: [{id: 'future-target', alias: 'future-target', sourceField: 'reviewer'}],
      })
      await create({
        id: 'source-unrelated',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('unrelated-target')},
        references: [{id: 'unrelated-target', alias: 'unrelated-target', sourceField: 'reviewer'}],
      })

      const past = await env.repo.queryBlocks({workspaceId: WS, 
        where: {
          [reviewerProp.name]: {
            target: {[dueProp.name]: {lt: new Date('2026-06-01T00:00:00.000Z')}},
          },
        },
      })
      expect(ids(past)).toEqual(['source-past'])

      // Empty target predicate = "ref points at a live block".
      // Excludes the dangling case (no row at the ref id) and the
      // soft-deleted case via the JOIN's `d.deleted = 0` clause.
      const anyTarget = await env.repo.queryBlocks({workspaceId: WS, 
        where: {[reviewerProp.name]: {target: {}}},
      })
      expect(ids(anyTarget).sort()).toEqual(['source-future', 'source-past', 'source-unrelated'])
    })

    it('rejects the target operator on non-ref properties', async () => {
      await expect(env.repo.queryBlocks({workspaceId: WS, 
        where: {status: {target: {priority: {gt: 0}}}},
      })).rejects.toThrow('only valid on ref / refList properties')
    })

    it('rejects malformed target operand', async () => {
      await expect(env.repo.queryBlocks({workspaceId: WS, 
        where: {[reviewerProp.name]: {target: 'not-an-object'}},
      })).rejects.toThrow('target must be a where-map object')
    })
  })

  it('filters by references with optional sourceField', async () => {
    await create({id: 'target'})
    await create({
      id: 'content-source',
      references: [{id: 'target', alias: 'Target'}],
    })
    await create({
      id: 'field-source',
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    })

    expect(ids(await env.repo.queryBlocks({workspaceId: WS, referencedBy: {id: 'target'}})))
      .toEqual(['content-source', 'field-source'])
    expect(ids(await env.repo.queryBlocks({workspaceId: WS, referencedBy: {id: 'target', sourceField: 'reviewer'}})))
      .toEqual(['field-source'])
    expect(ids(await env.repo.queryBlocks({workspaceId: WS, referencedBy: {id: 'target', sourceField: ''}})))
      .toEqual(['content-source'])
  })

  it('scopes to the explicit workspace and ignores other workspaces', async () => {
    await create({id: 'local', types: ['todo']})
    await create({id: 'remote', workspaceId: OTHER_WS, types: ['todo']})

    expect(ids(await env.repo.queryBlocks({workspaceId: WS, types: ['todo']}))).toEqual(['local'])
    expect(ids(await env.repo.queryBlocks({workspaceId: OTHER_WS, types: ['todo']}))).toEqual(['remote'])
  })

  it('queryActiveWorkspace resolves to the active workspace at call time', async () => {
    await create({id: 'local', types: ['todo']})
    await create({id: 'remote', workspaceId: OTHER_WS, types: ['todo']})

    // setActiveWorkspaceId(WS) ran in setup
    expect(ids(await env.repo.queryActiveWorkspace({types: ['todo']}))).toEqual(['local'])

    env.repo.setActiveWorkspaceId(OTHER_WS)
    expect(ids(await env.repo.queryActiveWorkspace({types: ['todo']}))).toEqual(['remote'])

    env.repo.setActiveWorkspaceId(null)
    expect(await env.repo.queryActiveWorkspace({types: ['todo']})).toEqual([])
  })

  it('rejects unsupported where filters clearly', async () => {
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {missing: 'x'}}))
      .rejects.toThrow('has no registered PropertySchema')
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {labels: ['x']}}))
      .rejects.toThrow('is not where-queryable')
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {reviewer: 'target'}}))
      .rejects.toThrow('is not where-queryable')
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {status: undefined}}))
      .rejects.toThrow('is undefined')
  })

  it('does not alias invalid undefined where filters to a cached empty where handle', async () => {
    await create({id: 'todo-open', types: ['todo'], properties: {status: 'open'}})

    await expect(env.repo.queryBlocks({workspaceId: WS, where: {}}))
      .resolves.toMatchObject([{id: 'todo-open'}])
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {status: undefined}}))
      .rejects.toThrow('is undefined')
  })

  it('rejects ancestor-scope predicates without a candidate-narrowing filter', async () => {
    // No referencedBy, no types, no top-level where, no narrowing
    // self-scope match → would chain-walk every block in the ws.
    await expect(env.repo.queryBlocks({workspaceId: WS, 
      match: [{scope: 'ancestor', where: {status: 'done'}}],
    })).rejects.toThrow('require at least one candidate filter')
  })

  it('null-only where does not pass the ancestor gate', async () => {
    // Top-level where: {status: null} matches every row that doesn't
    // have status set — does not narrow the candidate set in any
    // meaningful way for the recursive walk.
    await expect(env.repo.queryBlocks({workspaceId: WS, 
      where: {status: null},
      match: [{scope: 'ancestor', where: {status: 'done'}}],
    })).rejects.toThrow('require at least one candidate filter')
  })

  it('exists:false-only where does not pass the ancestor gate either', async () => {
    // `{exists: false}` is semantically identical to `null` (both
    // compile to IS NULL). The selectivity gate must treat them the
    // same, otherwise callers using one shorthand silently bypass
    // the guard the other shorthand triggers.
    await expect(env.repo.queryBlocks({workspaceId: WS, 
      where: {status: {exists: false}},
      match: [{scope: 'ancestor', where: {status: 'done'}}],
    })).rejects.toThrow('require at least one candidate filter')
  })

  it('self-scope match predicate counts as a candidate filter for the gate', async () => {
    // create() hardcodes parentId: null, so use tx.create directly to
    // build a parent-child chain.
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'parent', workspaceId: WS, parentId: null, orderKey: 'a',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo']), status: 'open'},
      })
      await tx.create({
        id: 'child', workspaceId: WS, parentId: 'parent', orderKey: 'b',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo']), status: 'open'},
      })
    }, {scope: ChangeScope.BlockDefault})
    await create({id: 'unrelated', properties: {status: 'open'}})

    // Self-scope `status=open` predicate folds into candidates →
    // the recursive walk only seeds from rows that match it.
    const out = await env.repo.queryBlocks({workspaceId: WS, 
      match: [
        {scope: 'self', where: {status: 'open'}},
        {scope: 'ancestor', id: 'parent'},
      ],
    })
    expect(ids(out).sort()).toEqual(['child', 'parent'])
  })

  it('top-level where folds into candidates and applies before ancestor walk', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'parent', workspaceId: WS, parentId: null, orderKey: 'a',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo'])},
      })
      await tx.create({
        id: 'open-child', workspaceId: WS, parentId: 'parent', orderKey: 'b',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo']), status: 'open'},
      })
      await tx.create({
        id: 'done-child', workspaceId: WS, parentId: 'parent', orderKey: 'c',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo']), status: 'done'},
      })
    }, {scope: ChangeScope.BlockDefault})

    const out = await env.repo.queryBlocks({workspaceId: WS,
      where: {status: 'open'},
      match: [{scope: 'ancestor', id: 'parent'}],
    })
    expect(ids(out)).toEqual(['open-child'])
  })

  it('exclude keeps rows whose filtered property is unset (NULL is not a match)', async () => {
    // Regression: a scalar `exclude` where compiles to
    // `json_extract(...) = ?`, which is NULL when the property is
    // missing. A bare `NOT (NULL)` is NULL — not TRUE — so it used to
    // drop every row that never set the property, the opposite of the
    // documented NOR contract ("exclude iff a predicate matches"; an
    // unknown does not match). This is exactly how SRS due-cards lost
    // every card that had never been archived.
    await create({id: 'unset', types: ['todo']})
    await create({id: 'explicit-false', types: ['todo'], properties: {[doneProp.name]: doneProp.codec.encode(false)}})
    await create({id: 'explicit-true', types: ['todo'], properties: {[doneProp.name]: doneProp.codec.encode(true)}})

    const out = await env.repo.queryBlocks({
      workspaceId: WS,
      types: ['todo'],
      exclude: [{scope: 'self', where: {[doneProp.name]: true}}],
    })
    expect(ids(out).sort()).toEqual(['explicit-false', 'unset'])
  })
})

describe('repo.subscribeBlocks', () => {
  it('updates when local writes change type membership', async () => {
    const fired: string[][] = []
    const off = env.repo.subscribeBlocks({workspaceId: WS, types: ['todo']}, rows => {
      fired.push(ids(rows))
    })

    await vi.waitFor(() => expect(fired).toEqual([[]]))
    await create({id: 'todo', types: ['todo']})

    await vi.waitFor(() => expect(fired).toEqual([[], ['todo']]))
    off()
  })

  it('updates when a target row appears with the inner-null property unset', async () => {
    // `target: { status: null }` matches rows whose status is unset.
    // A freshly-inserted target row with no `status` property doesn't
    // fire the status property channel — same shape as the top-level
    // "where with only null predicates" case. Without a live-channel
    // sub on this branch the subscriber would stay stale.
    await env.repo.tx(tx => tx.create({
      id: 'source', workspaceId: WS, parentId: null, orderKey: 'a',
      properties: {[reviewerProp.name]: reviewerProp.codec.encode('target')},
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    }), {scope: ChangeScope.BlockDefault})

    const fired: string[][] = []
    const off = env.repo.subscribeBlocks(
      {workspaceId: WS, where: {[reviewerProp.name]: {target: {status: null}}}},
      rows => fired.push(ids(rows)),
    )
    await vi.waitFor(() => expect(fired).toEqual([[]]))

    await env.repo.tx(tx => tx.create({
      id: 'target', workspaceId: WS, parentId: null, orderKey: 'b',
    }), {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => expect(fired).toEqual([[], ['source']]))
    off()
  })

  it('updates when a target operator inner property changes on the referenced row', async () => {
    // Regression: the `target` traversal makes membership depend on
    // the REFERENCED row's properties. Without dep wiring on the
    // inner property channel, a target-side update wouldn't wake
    // the subscriber.
    await env.repo.tx(tx => tx.create({
      id: 'target', workspaceId: WS, parentId: null, orderKey: 'a',
    }), {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.create({
      id: 'source', workspaceId: WS, parentId: null, orderKey: 'b',
      properties: {[reviewerProp.name]: reviewerProp.codec.encode('target')},
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    }), {scope: ChangeScope.BlockDefault})

    const fired: string[][] = []
    const off = env.repo.subscribeBlocks(
      {workspaceId: WS, where: {[reviewerProp.name]: {target: {status: 'done'}}}},
      rows => fired.push(ids(rows)),
    )
    await vi.waitFor(() => expect(fired).toEqual([[]]))

    // Update the *target* row's status. The subscription's filter
    // doesn't reference the target id directly — only an inner
    // property predicate — so this hits the dep wiring that
    // `collectWhereDeps` adds for traversals.
    await env.repo.tx(tx => tx.setProperty('target', statusProp, 'done'),
      {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => expect(fired).toEqual([[], ['source']]))
    off()
  })

  it('updates when sync-applied rows change type membership', async () => {
    const fired: string[][] = []
    const off = env.repo.subscribeBlocks({workspaceId: WS, types: ['todo']}, rows => {
      fired.push(ids(rows))
    })
    await vi.waitFor(() => expect(fired).toEqual([[]]))

    env.repo.startSyncObserver({throttleMs: 0})
    // A brand-new typed block arrives via the sync path: staged into
    // blocks_synced, materialized by the observer. New id ⇒ no prior local
    // row, so no pending-upload gate to clear.
    await env.h.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
      id: 'remote-todo', workspaceId: WS, parentId: null, orderKey: 'a0',
      content: '', properties: {[typesProp.name]: ['todo']}, references: [],
      createdAt: 0, updatedAt: 0, userUpdatedAt: 0, createdBy: 'remote', updatedBy: 'remote', deleted: false,
    }))

    await env.repo.flushSyncObserver()
    await vi.waitFor(() => expect(fired).toEqual([[], ['remote-todo']]))
    off()
  })
})

describe('repo.countBlocksUsingProperty', () => {
  it('counts only non-deleted blocks where the property is set', async () => {
    await create({id: 'a', properties: {status: 'open'}})
    await create({id: 'b', properties: {status: 'done'}})
    await create({id: 'c', properties: {}})
    await create({id: 'd', properties: {status: 'open'}})
    await env.repo.tx(tx => tx.delete('d'), {scope: ChangeScope.BlockDefault})

    expect(await env.repo.countBlocksUsingProperty('status')).toBe(2)
    expect(await env.repo.countBlocksUsingProperty('done')).toBe(0)
  })

  it('scopes to the active workspace by default and accepts an explicit one', async () => {
    await create({id: 'local', properties: {status: 'open'}})
    await create({id: 'remote', workspaceId: OTHER_WS, properties: {status: 'open'}})

    expect(await env.repo.countBlocksUsingProperty('status')).toBe(1)
    expect(await env.repo.countBlocksUsingProperty('status', OTHER_WS)).toBe(1)
  })

  it('escapes property names containing quotes and special characters', async () => {
    await create({id: 'hit', properties: {[weirdNameProp.name]: 'yes'}})
    await create({id: 'miss', properties: {status: 'open'}})

    expect(await env.repo.countBlocksUsingProperty(weirdNameProp.name)).toBe(1)
  })
})
