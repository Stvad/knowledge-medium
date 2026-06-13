import {act, renderHook, waitFor} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {ToggleNode} from '@/facets/discoverToggleTree.js'
import {systemToggle} from '@/facets/togglable.js'
import {useToggleTree} from '../useToggleTree.ts'

const mockState = vi.hoisted(() => ({
  repo: {activeWorkspaceId: 'ws-initial'},
  runtime: {context: {safeMode: false}},
  overridesResult: {
    overrides: new Map<string, boolean>(),
    generation: 'initial-load',
  },
  discoverToggleTree: vi.fn<
    (tree: unknown, context: unknown) => Promise<readonly ToggleNode[]>
  >(() =>
    Promise.resolve([] as readonly ToggleNode[]),
  ),
  dynamicExtensionsExtension: vi.fn<(args: unknown) => () => Promise<never[]>>(
    () => async () => [],
  ),
  staticAppExtensions: vi.fn<(args: unknown) => never[]>(() => []),
}))

vi.mock('@/context/repo.js', () => ({
  useRepo: () => mockState.repo,
}))

vi.mock('@/extensions/runtimeContext.js', () => ({
  useAppRuntime: () => mockState.runtime,
}))

vi.mock('@/extensions/useOverrides.js', () => ({
  useOverrides: () => mockState.overridesResult,
}))

vi.mock('@/extensions/staticAppExtensions.js', () => ({
  staticAppExtensions: (args: unknown) => mockState.staticAppExtensions(args),
}))

vi.mock('@/extensions/dynamicExtensions.js', () => ({
  dynamicExtensionsExtension: (args: unknown) => mockState.dynamicExtensionsExtension(args),
}))

vi.mock('@/facets/discoverToggleTree.js', () => ({
  discoverToggleTree: (tree: unknown, context: unknown) =>
    mockState.discoverToggleTree(tree, context),
}))

const node = (id: string, name: string): ToggleNode => ({
  handle: systemToggle({id, name}),
  children: [],
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

describe('useToggleTree', () => {
  beforeEach(() => {
    mockState.repo = {activeWorkspaceId: `ws-${crypto.randomUUID()}`}
    mockState.runtime = {context: {safeMode: false}}
    mockState.overridesResult = {
      overrides: new Map<string, boolean>(),
      generation: 'initial-load',
    }
    mockState.discoverToggleTree.mockReset()
    mockState.dynamicExtensionsExtension.mockClear()
    mockState.staticAppExtensions.mockClear()
  })

  it('keeps showing the last resolved tree for the workspace while rediscovery is pending after remount', async () => {
    const firstTree = [node('system:first', 'First')]
    const secondTree = [node('system:second', 'Second')]
    const firstDiscovery = deferred<readonly ToggleNode[]>()
    mockState.discoverToggleTree.mockReturnValueOnce(firstDiscovery.promise)

    const first = renderHook(() => useToggleTree())
    expect(first.result.current.loading).toBe(true)
    expect(first.result.current.tree).toEqual([])

    await act(async () => {
      firstDiscovery.resolve(firstTree)
      await firstDiscovery.promise
    })

    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
      expect(first.result.current.tree).toBe(firstTree)
    })
    first.unmount()

    const secondDiscovery = deferred<readonly ToggleNode[]>()
    mockState.discoverToggleTree.mockReturnValueOnce(secondDiscovery.promise)

    const second = renderHook(() => useToggleTree())

    expect(second.result.current.loading).toBe(false)
    expect(second.result.current.tree).toBe(firstTree)

    await act(async () => {
      secondDiscovery.resolve(secondTree)
      await secondDiscovery.promise
    })

    await waitFor(() => {
      expect(second.result.current.loading).toBe(false)
      expect(second.result.current.tree).toBe(secondTree)
    })
  })

  it('does not show a previous workspace tree while an uncached workspace discovery is pending', async () => {
    const firstTree = [node('system:first-workspace', 'First workspace')]
    const secondTree = [node('system:second-workspace', 'Second workspace')]
    const firstDiscovery = deferred<readonly ToggleNode[]>()
    mockState.discoverToggleTree.mockReturnValueOnce(firstDiscovery.promise)

    const hook = renderHook(() => useToggleTree())

    await act(async () => {
      firstDiscovery.resolve(firstTree)
      await firstDiscovery.promise
    })

    await waitFor(() => {
      expect(hook.result.current.loading).toBe(false)
      expect(hook.result.current.tree).toBe(firstTree)
    })

    const secondDiscovery = deferred<readonly ToggleNode[]>()
    mockState.discoverToggleTree.mockReturnValueOnce(secondDiscovery.promise)
    mockState.repo = {activeWorkspaceId: `ws-${crypto.randomUUID()}`}

    hook.rerender()

    expect(hook.result.current.loading).toBe(true)
    expect(hook.result.current.tree).toEqual([])

    await act(async () => {
      secondDiscovery.resolve(secondTree)
      await secondDiscovery.promise
    })

    await waitFor(() => {
      expect(hook.result.current.loading).toBe(false)
      expect(hook.result.current.tree).toBe(secondTree)
    })
  })
})
