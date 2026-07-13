// @vitest-environment node
import {describe, expect, it, vi} from 'vitest'
import {definitionBlockProjectorFacet} from '@/data/facets'
import {ProjectorRuntime, type DefinitionBlockProjector} from '@/data/projectorRuntime'
import type {BlockData} from '@/data/api'
import type {Repo} from '@/data/repo'
import {defineFacet, resolveFacetRuntimeSync} from '@/facets/facet'

interface Projected {readonly id: string; readonly label: string}

const projectedFacet = defineFacet<Projected>({id: 'test.projector-runtime'})
const descriptor: DefinitionBlockProjector<BlockData, Projected> = {
  id: 'test-projector',
  metaType: 'test-meta',
  targetFacet: projectedFacet,
  sourceId: 'user-data',
  project: row => ({id: row.id, label: row.content}),
  keyOf: contribution => contribution.label,
}

const row = (workspaceId: string, id: string, content: string): BlockData => ({
  id,
  workspaceId,
  parentId: null,
  orderKey: 'a0',
  content,
  properties: {},
  references: [],
  createdAt: 1,
  updatedAt: 1,
  userUpdatedAt: 1,
  createdBy: 'user',
  updatedBy: 'user',
  deleted: false,
})

describe('ProjectorRuntime workspace pin and readiness', () => {
  it('starts at the Repo pin and resolves readiness only from that generation first tick', async () => {
    const callbacks: Array<(rows: readonly BlockData[]) => void> = []
    const setRuntimeContributions = vi.fn()
    const facetRuntime = resolveFacetRuntimeSync([
      definitionBlockProjectorFacet.of(descriptor),
    ])
    const repo = {
      facetRuntime,
      subscribeBlocks: vi.fn((_query, callback) => {
        callbacks.push(callback)
        return vi.fn()
      }),
      setRuntimeContributions,
    } as unknown as Repo
    const projectors = new ProjectorRuntime(repo)

    projectors.pinWorkspace('ws-1')
    const firstGeneration = projectors.generationToken
    expect(firstGeneration).not.toBeNull()
    let firstSettled = false
    const firstPrime = projectors.whenPrimed('ws-1').then(() => { firstSettled = true })
    await Promise.resolve()
    expect(firstSettled).toBe(false)

    callbacks[0]!([row('ws-1', 'w1-row', 'one')])
    await firstPrime
    expect(projectors.isPrimed('ws-1')).toBe(true)
    expect(setRuntimeContributions).toHaveBeenLastCalledWith(
      projectedFacet,
      'user-data',
      [{id: 'w1-row', label: 'one'}],
      {workspaceId: 'ws-1'},
    )

    const outgoingCallback = callbacks[0]!
    projectors.pinWorkspace('ws-2')
    expect(projectors.generationToken).not.toBe(firstGeneration)
    const callsAfterSwitch = setRuntimeContributions.mock.calls.length
    outgoingCallback([row('ws-1', 'late-w1', 'late')])
    expect(setRuntimeContributions).toHaveBeenCalledTimes(callsAfterSwitch)
    expect(projectors.isPrimed('ws-2')).toBe(false)

    callbacks[1]!([row('ws-2', 'w2-row', 'two')])
    await projectors.whenPrimed('ws-2')
    expect(projectors.isPrimed('ws-2')).toBe(true)
  })

  it('cancels an outgoing workspace waiter instead of resolving it from the next generation', async () => {
    const callbacks: Array<(rows: readonly BlockData[]) => void> = []
    const repo = {
      facetRuntime: resolveFacetRuntimeSync([definitionBlockProjectorFacet.of(descriptor)]),
      subscribeBlocks: vi.fn((_query, callback) => {
        callbacks.push(callback)
        return vi.fn()
      }),
      setRuntimeContributions: vi.fn(),
    } as unknown as Repo
    const projectors = new ProjectorRuntime(repo)

    projectors.pinWorkspace('ws-1')
    const outgoing = projectors.whenPrimed('ws-1')
    projectors.pinWorkspace('ws-2')
    await expect(outgoing).rejects.toThrow('ws-1 projector readiness cancelled')

    const incoming = projectors.whenPrimed('ws-2')
    callbacks[1]!([])
    await expect(incoming).resolves.toBeUndefined()
  })

  it('cleans a partial start, restores the outgoing workspace, and permits retry', async () => {
    const callbacks: Array<(rows: readonly BlockData[]) => void> = []
    const primaryDisposers: ReturnType<typeof vi.fn>[] = []
    let startingWorkspace = ''
    let failWs2 = true
    const throwingDescriptor: DefinitionBlockProjector<BlockData, Projected> = {
      ...descriptor,
      id: 'throwing-projector',
      secondarySignal: () => {
        if (startingWorkspace === 'ws-2' && failWs2) throw new Error('secondary start failed')
        return vi.fn()
      },
    }
    const repo = {
      facetRuntime: resolveFacetRuntimeSync([
        definitionBlockProjectorFacet.of(throwingDescriptor),
      ]),
      subscribeBlocks: vi.fn((query: {workspaceId: string}, callback) => {
        startingWorkspace = query.workspaceId
        callbacks.push(callback)
        const dispose = vi.fn()
        primaryDisposers.push(dispose)
        return dispose
      }),
      setRuntimeContributions: vi.fn(),
    } as unknown as Repo
    const projectors = new ProjectorRuntime(repo)

    projectors.pinWorkspace('ws-1')
    expect(() => projectors.pinWorkspace('ws-2')).toThrow('secondary start failed')
    // W1 outgoing primary and the partially-started W2 primary both cleaned;
    // a fresh W1 generation was then restored.
    expect(primaryDisposers[0]).toHaveBeenCalledTimes(1)
    expect(primaryDisposers[1]).toHaveBeenCalledTimes(1)
    expect(primaryDisposers).toHaveLength(3)
    expect(projectors.isPrimed('ws-1')).toBe(false)
    callbacks[2]!([])
    await expect(projectors.whenPrimed('ws-1')).resolves.toBeUndefined()

    failWs2 = false
    expect(() => projectors.pinWorkspace('ws-2')).not.toThrow()
    callbacks[3]!([])
    await expect(projectors.whenPrimed('ws-2')).resolves.toBeUndefined()
  })

  it('rejects readiness when the fresh initial query fails', async () => {
    let failInitial: ((error: unknown) => void) | undefined
    const repo = {
      facetRuntime: resolveFacetRuntimeSync([definitionBlockProjectorFacet.of(descriptor)]),
      subscribeBlocks: vi.fn((_query, _callback, options) => {
        failInitial = options?.onInitialError
        return vi.fn()
      }),
      setRuntimeContributions: vi.fn(),
    } as unknown as Repo
    const projectors = new ProjectorRuntime(repo)

    projectors.pinWorkspace('ws-1')
    const readiness = projectors.whenPrimed('ws-1')
    failInitial?.(new Error('initial schema query failed'))

    await expect(readiness).rejects.toThrow('initial schema query failed')
    expect(projectors.isPrimed('ws-1')).toBe(false)
  })

  it('does not settle an incoming generation switched during synchronous publish', async () => {
    const callbacks: Array<(rows: readonly BlockData[]) => void> = []
    let switched = false
    let reentrantReadiness: Promise<void> | undefined
    const repo = {
      facetRuntime: resolveFacetRuntimeSync([definitionBlockProjectorFacet.of(descriptor)]),
      subscribeBlocks: vi.fn((_query, callback) => {
        callbacks.push(callback)
        return vi.fn()
      }),
      setRuntimeContributions: vi.fn((_facet, _source, contributions) => {
        if (!switched && contributions.length > 0) {
          switched = true
          reentrantReadiness = projectors.whenPrimed('ws-1')
          projectors.pinWorkspace('ws-2')
        }
      }),
    } as unknown as Repo
    const projectors = new ProjectorRuntime(repo)

    projectors.pinWorkspace('ws-1')
    const outgoing = projectors.whenPrimed('ws-1')
    callbacks[0]!([row('ws-1', 'w1-row', 'one')])
    await expect(outgoing).rejects.toThrow('ws-1 projector readiness cancelled')
    await expect(reentrantReadiness).rejects.toThrow('ws-1 projector readiness cancelled')

    let incomingSettled = false
    const incoming = projectors.whenPrimed('ws-2').then(() => { incomingSettled = true })
    await Promise.resolve()
    expect(incomingSettled).toBe(false)
    callbacks[1]!([])
    await incoming
    expect(projectors.isPrimed('ws-2')).toBe(true)
  })

  it('stops exposing a handle after its descriptor is removed', () => {
    let facetRuntime = resolveFacetRuntimeSync([
      definitionBlockProjectorFacet.of(descriptor),
    ])
    const repo = {
      get facetRuntime() { return facetRuntime },
      subscribeBlocks: vi.fn(() => vi.fn()),
      setRuntimeContributions: vi.fn(),
    } as unknown as Repo
    const projectors = new ProjectorRuntime(repo)

    projectors.pinWorkspace('ws-1')
    expect(projectors.handle(descriptor.id)).toBeDefined()

    facetRuntime = resolveFacetRuntimeSync([])
    projectors.pinWorkspace('ws-1')
    expect(projectors.handle(descriptor.id)).toBeUndefined()
  })

  it('rejects duplicate projector ids instead of silently selecting one', () => {
    const duplicate = {...descriptor, metaType: 'other-meta'}
    const repo = {
      facetRuntime: resolveFacetRuntimeSync([
        definitionBlockProjectorFacet.of(descriptor),
        definitionBlockProjectorFacet.of(duplicate),
      ]),
      subscribeBlocks: vi.fn(() => vi.fn()),
      setRuntimeContributions: vi.fn(),
    } as unknown as Repo
    const projectors = new ProjectorRuntime(repo)

    expect(() => projectors.pinWorkspace('ws-1'))
      .toThrow('[ProjectorRuntime] duplicate projector id test-projector')
    expect(repo.subscribeBlocks).not.toHaveBeenCalled()
  })
})
