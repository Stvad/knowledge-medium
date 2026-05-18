// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type BlockReference,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { typesProp } from '@/data/properties'
import { propertySchemasFacet } from '../facets'
import { kernelDataExtension } from '../kernelDataExtension'
import { Repo } from '../repo'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

const statusProp = defineProperty<string>('status', {
  codec: codecs.string,
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
})

const doneProp = defineProperty<boolean>('done', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

const priorityProp = defineProperty<number>('priority', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

const dueProp = defineProperty<Date | undefined>('due', {
  codec: codecs.date,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const weirdNameProp = defineProperty<string>('weird:name.with-dot-hyphen', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

const labelsProp = defineProperty<readonly string[]>('labels', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

const reviewerProp = defineProperty<string>('reviewer', {
  codec: codecs.ref(),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

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
    propertySchemasFacet.of(statusProp, {source: 'test'}),
    propertySchemasFacet.of(doneProp, {source: 'test'}),
    propertySchemasFacet.of(priorityProp, {source: 'test'}),
    propertySchemasFacet.of(dueProp, {source: 'test'}),
    propertySchemasFacet.of(weirdNameProp, {source: 'test'}),
    propertySchemasFacet.of(labelsProp, {source: 'test'}),
    propertySchemasFacet.of(reviewerProp, {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

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
  it('filters by any matching type and scalar where values without duplicate rows', async () => {
    await create({id: 'todo-open', types: ['todo'], properties: {status: 'open'}})
    await create({id: 'todo-done', types: ['todo'], properties: {status: 'done'}})
    await create({id: 'task-open', types: ['task', 'todo'], properties: {status: 'open'}})
    await create({id: 'other-open', types: ['project'], properties: {status: 'open'}})

    const out = await env.repo.queryBlocks({
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

    await expect(env.repo.queryBlocks({
      where: {[weirdNameProp.name]: 'yes'},
    })).resolves.toMatchObject([{id: 'hit'}])
  })

  it('matches null filters against missing and explicit-null properties', async () => {
    await create({id: 'missing', types: ['todo']})
    await create({id: 'nullish', types: ['todo'], properties: {status: null}})
    await create({id: 'set', types: ['todo'], properties: {status: 'open'}})

    const out = await env.repo.queryBlocks({where: {status: null}})

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

      const lt = await env.repo.queryBlocks({where: {priority: {lt: 3}}})
      expect(ids(lt).sort()).toEqual(['p1', 'p2'])

      const lte = await env.repo.queryBlocks({where: {priority: {lte: 2}}})
      expect(ids(lte).sort()).toEqual(['p1', 'p2'])

      const gt = await env.repo.queryBlocks({where: {priority: {gt: 1}}})
      expect(ids(gt).sort()).toEqual(['p2', 'p3'])

      const gte = await env.repo.queryBlocks({where: {priority: {gte: 2}}})
      expect(ids(gte).sort()).toEqual(['p2', 'p3'])

      const eq = await env.repo.queryBlocks({where: {priority: {eq: 2}}})
      expect(ids(eq)).toEqual(['p2'])
    })

    it('comparator operators on a date property', async () => {
      await create({id: 'past', properties: {[dueProp.name]: encodeDate('2026-01-01')}})
      await create({id: 'today', properties: {[dueProp.name]: encodeDate('2026-05-18')}})
      await create({id: 'future', properties: {[dueProp.name]: encodeDate('2026-12-31')}})

      const before = await env.repo.queryBlocks({
        where: {due: {lt: new Date('2026-05-18T00:00:00.000Z')}},
      })
      expect(ids(before)).toEqual(['past'])

      const onOrAfter = await env.repo.queryBlocks({
        where: {due: {gte: new Date('2026-05-18T00:00:00.000Z')}},
      })
      expect(ids(onOrAfter).sort()).toEqual(['future', 'today'])
    })

    it('between is inclusive on both ends', async () => {
      await create({id: 'p1', properties: {[priorityProp.name]: priorityProp.codec.encode(1)}})
      await create({id: 'p2', properties: {[priorityProp.name]: priorityProp.codec.encode(2)}})
      await create({id: 'p3', properties: {[priorityProp.name]: priorityProp.codec.encode(3)}})
      await create({id: 'p5', properties: {[priorityProp.name]: priorityProp.codec.encode(5)}})

      const out = await env.repo.queryBlocks({where: {priority: {between: [2, 3]}}})
      expect(ids(out).sort()).toEqual(['p2', 'p3'])
    })

    it('exists: true matches set, exists: false matches unset', async () => {
      await create({id: 'set', properties: {status: 'open'}})
      await create({id: 'missing', properties: {}})
      await create({id: 'nullish', properties: {status: null}})

      const set = await env.repo.queryBlocks({where: {status: {exists: true}}})
      expect(ids(set)).toEqual(['set'])

      const unset = await env.repo.queryBlocks({where: {status: {exists: false}}})
      expect(ids(unset).sort()).toEqual(['missing', 'nullish'])
    })

    it('rejects malformed operator objects with a clear message', async () => {
      await expect(env.repo.queryBlocks({where: {priority: {lt: 1, gt: 0}}}))
        .rejects.toThrow('operator object must have exactly one key')
      await expect(env.repo.queryBlocks({where: {priority: {bogus: 1}}}))
        .rejects.toThrow('unknown operator')
      await expect(env.repo.queryBlocks({where: {priority: {between: [1]}}}))
        .rejects.toThrow('between must be a [lo, hi] tuple')
      await expect(env.repo.queryBlocks({where: {status: {exists: 'yes'}}}))
        .rejects.toThrow('exists must be a boolean')
    })

    it('rejects comparator operators on non-where-queryable codecs', async () => {
      await expect(env.repo.queryBlocks({where: {reviewer: {eq: 'target'}}}))
        .rejects.toThrow('is not where-queryable')
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

    expect(ids(await env.repo.queryBlocks({referencedBy: {id: 'target'}})))
      .toEqual(['content-source', 'field-source'])
    expect(ids(await env.repo.queryBlocks({referencedBy: {id: 'target', sourceField: 'reviewer'}})))
      .toEqual(['field-source'])
    expect(ids(await env.repo.queryBlocks({referencedBy: {id: 'target', sourceField: ''}})))
      .toEqual(['content-source'])
  })

  it('defaults to the active workspace and ignores other workspaces', async () => {
    await create({id: 'local', types: ['todo']})
    await create({id: 'remote', workspaceId: OTHER_WS, types: ['todo']})

    expect(ids(await env.repo.queryBlocks({types: ['todo']}))).toEqual(['local'])
  })

  it('rejects unsupported where filters clearly', async () => {
    await expect(env.repo.queryBlocks({where: {missing: 'x'}}))
      .rejects.toThrow('has no registered PropertySchema')
    await expect(env.repo.queryBlocks({where: {labels: ['x']}}))
      .rejects.toThrow('is not where-queryable')
    await expect(env.repo.queryBlocks({where: {reviewer: 'target'}}))
      .rejects.toThrow('is not where-queryable')
    await expect(env.repo.queryBlocks({where: {status: undefined}}))
      .rejects.toThrow('is undefined')
  })

  it('does not alias invalid undefined where filters to a cached empty where handle', async () => {
    await create({id: 'todo-open', types: ['todo'], properties: {status: 'open'}})

    await expect(env.repo.queryBlocks({where: {}}))
      .resolves.toMatchObject([{id: 'todo-open'}])
    await expect(env.repo.queryBlocks({where: {status: undefined}}))
      .rejects.toThrow('is undefined')
  })

  it('rejects ancestor-scope predicates without a candidate-narrowing filter', async () => {
    // No referencedBy, no types, no top-level where, no narrowing
    // self-scope match → would chain-walk every block in the ws.
    await expect(env.repo.queryBlocks({
      match: [{scope: 'ancestor', where: {status: 'done'}}],
    })).rejects.toThrow('require at least one candidate filter')
  })

  it('null-only where does not pass the ancestor gate', async () => {
    // Top-level where: {status: null} matches every row that doesn't
    // have status set — does not narrow the candidate set in any
    // meaningful way for the recursive walk.
    await expect(env.repo.queryBlocks({
      where: {status: null},
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
    const out = await env.repo.queryBlocks({
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

    const out = await env.repo.queryBlocks({
      where: {status: 'open'},
      match: [{scope: 'ancestor', id: 'parent'}],
    })
    expect(ids(out)).toEqual(['open-child'])
  })
})

describe('repo.subscribeBlocks', () => {
  it('updates when local writes change type membership', async () => {
    const fired: string[][] = []
    const off = env.repo.subscribeBlocks({types: ['todo']}, rows => {
      fired.push(ids(rows))
    })

    await vi.waitFor(() => expect(fired).toEqual([[]]))
    await create({id: 'todo', types: ['todo']})

    await vi.waitFor(() => expect(fired).toEqual([[], ['todo']]))
    off()
  })

  it('updates when sync-applied rows change type membership', async () => {
    const fired: string[][] = []
    const off = env.repo.subscribeBlocks({types: ['todo']}, rows => {
      fired.push(ids(rows))
    })
    await vi.waitFor(() => expect(fired).toEqual([[]]))

    env.repo.startRowEventsTail({initialLastId: 0, throttleMs: 0})
    await env.h.db.execute(
      `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
    )
    await env.h.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                            properties_json, references_json, created_at,
                            updated_at, created_by, updated_by, deleted)
       VALUES (?, ?, NULL, 'a0', '', ?, '[]', 0, 0, 'remote', 'remote', 0)`,
      ['remote-todo', WS, JSON.stringify({[typesProp.name]: ['todo']})],
    )

    await env.repo.flushRowEventsTail()
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
