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
      .rejects.toThrow('uses non-scalar or reference codec')
    await expect(env.repo.queryBlocks({where: {reviewer: 'target'}}))
      .rejects.toThrow('uses non-scalar or reference codec')
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
