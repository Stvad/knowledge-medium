import {describe, expect, it, vi} from 'vitest'
import type {Repo} from '@/data/repo'
import {makeBlockData} from '@/data/test/factories.js'
import {AppRuntimeController, type AppRuntimeContext} from '@/extensions/appRuntimeController.js'
import {
  __setCompileImplForTest,
  COMPILER_VERSION,
  createCompileCache,
  hashExtensionSource,
} from '@/extensions/compileExtensionModule.js'
import {InMemoryCompiledModuleCache} from '@/extensions/compiledModuleCache.js'
import {appEffectsFacet} from '@/extensions/core.js'
import {isExtensionContribution} from '@/extensions/dynamicExtensions.js'
import {ExtensionApprovalStatusStore} from '@/extensions/extensionApprovalStatus.js'
import {ExtensionLoadErrorStore} from '@/extensions/extensionLoadErrors.js'
import {defineFacet, type FacetRuntime} from '@/facets/facet.js'
import {resolveAppRuntimeSync} from '@/facets/resolveAppRuntime.js'
import {systemToggle} from '@/facets/togglable.js'
import type {BlockData} from '@/types.js'

const labels = defineFacet<string>({id: 'test.runtime-controller.labels'})

const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return {promise, release}
}

const approveBlock = async (persistent: InMemoryCompiledModuleCache, block: BlockData) => {
  await persistent.write(block.id, {
    sourceHash: await hashExtensionSource(block.content),
    approvedSource: block.content,
    compiled: block.content,
    compilerVersion: COMPILER_VERSION,
    approvedAt: 0,
  })
}

const makeHost = (blocks: BlockData[] = []) => {
  const errorStore = new ExtensionLoadErrorStore()
  const approvalStore = new ExtensionApprovalStatusStore()
  const setFacetRuntime = vi.fn<(runtime: FacetRuntime) => void>()
  const repo = {
    setFacetRuntime,
    query: {findExtensionBlocks: () => ({load: async () => blocks})},
  } as unknown as Repo
  const context: AppRuntimeContext = {repo, workspaceId: 'ws', safeMode: false}
  return {context, setFacetRuntime, errorStore, approvalStore}
}

describe('AppRuntimeController', () => {
  it('resolves and waits for host readiness before publishing reports, then the host runtime, then the Repo', async () => {
    const approved = makeBlockData({id: 'approved', workspaceId: 'ws', content: 'fixture'})
    const pending = makeBlockData({id: 'pending', workspaceId: 'ws'})
    const host = makeHost([approved, pending])
    const {context, errorStore, approvalStore, setFacetRuntime} = host
    const persistent = new InMemoryCompiledModuleCache()
    await approveBlock(persistent, approved)
    const disabled = systemToggle({id: 'system:disabled', name: 'Disabled'})
    const overrides = new Map([[approved.id, true], [pending.id, true], [disabled.id, false]])
    const order: string[] = []
    const failure = new Error('Extension factory failed')
    const onLoadError = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restore = __setCompileImplForTest(async () => ({
      default: [
        labels.of('extension', {enables: labels.of('enabled child')}),
        () => { throw failure },
      ],
    }))
    errorStore.reportError('previous', new Error('previous load'))
    const unsubscribeErrors = errorStore.subscribe(() => order.push('errors'))
    const unsubscribeApprovals = approvalStore.subscribe(() => order.push('approvals'))
    setFacetRuntime.mockImplementation(() => { order.push('repo') })
    let ready!: () => void
    const readiness = new Promise<void>(resolve => { ready = resolve })

    try {
      const result = new AppRuntimeController().resolve({
        ...host,
        baseExtensions: [labels.of('static'), disabled.of([labels.of('hidden')])],
        overrides,
        persistent,
        cache: createCompileCache(),
        signal: new AbortController().signal,
        beforePublish: () => {
          order.push('ready')
          return readiness
        },
        onRuntime: () => { order.push('host') },
        onLoadError,
      })

      await vi.waitFor(() => expect(order).toContain('ready'))
      expect(order).toEqual(['ready'])
      expect(approvalStore.getSnapshot().size).toBe(0)
      expect(errorStore.getSnapshot().has('previous')).toBe(true)
      expect(onLoadError).toHaveBeenCalledExactlyOnceWith(approved.id, failure)

      ready()
      const runtime = await result
      expect(runtime?.context).toBe(context)
      expect(runtime?.read(labels)).toEqual(['static', 'extension', 'enabled child'])
      expect(approvalStore.getSnapshot().get(pending.id)?.kind).toBe('needs-approval')
      expect([...errorStore.getSnapshot()]).toEqual([[approved.id, failure]])
      expect(order).toEqual(['ready', 'errors', 'approvals', 'host', 'repo'])
      expect(setFacetRuntime).toHaveBeenCalledWith(runtime)
    } finally {
      ready()
      unsubscribeErrors()
      unsubscribeApprovals()
      restore()
      log.mockRestore()
    }
  })

  it('filters effect contributions before choosing a winner and rechecks eligibility on the same runtime', () => {
    const {context} = makeHost()
    const controller = new AppRuntimeController()
    const cleanup = vi.fn()
    const allowedStart = vi.fn(() => cleanup)
    const blockedStart = vi.fn()
    const firstStart = vi.fn()
    const runtime = resolveAppRuntimeSync([
      appEffectsFacet.of({id: 'shared', start: allowedStart}, {source: 'block:allowed/helper'}),
      appEffectsFacet.of({id: 'shared', start: blockedStart}, {source: 'static', precedence: 10}),
      appEffectsFacet.of({id: 'first', start: firstStart}, {source: 'block:allowed', precedence: -10}),
    ], {overrides: new Map(), context})
    let writable = true
    const eligible = ({source}: {source?: string}) => writable && isExtensionContribution(source, 'allowed')

    try {
      controller.reconcile(runtime, context, eligible)
      expect(allowedStart).toHaveBeenCalledTimes(1)
      expect(firstStart).toHaveBeenCalledBefore(allowedStart)
      expect(blockedStart).not.toHaveBeenCalled()
      expect(runtime.read(appEffectsFacet).map(effect => effect.start)).toEqual([firstStart, allowedStart, blockedStart])

      writable = false
      controller.reconcile(runtime, context, eligible)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(allowedStart).toHaveBeenCalledTimes(1)
      expect(blockedStart).not.toHaveBeenCalled()
    } finally {
      controller.dispose()
    }
  })

  it('ignores reports and publication from a cancelled load while the next batch is open', async () => {
    const oldBlock = makeBlockData({id: 'old', workspaceId: 'ws'})
    const newBlock = makeBlockData({id: 'new', workspaceId: 'ws'})
    const blocks = [newBlock]
    const host = makeHost(blocks)
    const controller = new AppRuntimeController()
    const oldLoad = new AbortController()
    const options = {
      ...host,
      overrides: new Map([[oldBlock.id, true], [newBlock.id, true]]),
      persistent: new InMemoryCompiledModuleCache(),
    }
    let releaseOld!: () => void
    const oldReady = new Promise<void>(resolve => { releaseOld = resolve })
    let releaseNew!: () => void
    const newReady = new Promise<void>(resolve => { releaseNew = resolve })
    const loadingOld = controller.resolve({
      ...options,
      baseExtensions: [async () => {
        await oldReady
        return null
      }],
      signal: oldLoad.signal,
    })
    oldLoad.abort()
    const newResolved = vi.fn(() => newReady)
    const loadingNew = controller.resolve({
      ...options,
      baseExtensions: [labels.of('new')],
      signal: new AbortController().signal,
      beforePublish: newResolved,
    })

    try {
      await vi.waitFor(() => expect(newResolved).toHaveBeenCalledTimes(1))
      blocks.splice(0, blocks.length, oldBlock)
      releaseOld()
      expect(await loadingOld).toBeUndefined()
      expect(host.setFacetRuntime).not.toHaveBeenCalled()

      releaseNew()
      const runtime = await loadingNew
      expect(runtime?.read(labels)).toEqual(['new'])
      expect([...host.approvalStore.getSnapshot().keys()]).toEqual([newBlock.id])
      expect(host.setFacetRuntime.mock.calls).toEqual([[runtime]])
    } finally {
      releaseOld()
      releaseNew()
    }
  })

  it('does no resolution work and leaves an open batch intact when the signal is already aborted', async () => {
    const host = makeHost()
    const failure = new Error('Active load error')
    host.errorStore.beginBatch()
    host.errorStore.reportError('active', failure)
    host.approvalStore.beginBatch()
    host.approvalStore.report('active', {kind: 'needs-approval', name: 'Active', liveSource: 'fixture', liveHash: 'hash'})
    const extension = vi.fn(() => null)

    const runtime = await new AppRuntimeController().resolve({
      ...host,
      baseExtensions: [extension],
      overrides: new Map(),
      signal: AbortSignal.abort(),
    })

    expect(runtime).toBeUndefined()
    expect(extension).not.toHaveBeenCalled()
    host.errorStore.commitBatch()
    expect(host.errorStore.getSnapshot().get('active')).toBe(failure)
    host.approvalStore.commitBatch()
    expect(host.approvalStore.getSnapshot().get('active')?.kind).toBe('needs-approval')
  })

  it('keeps a superseded compile error out of the current batch and the host callback', async () => {
    const block = makeBlockData({id: 'broken', workspaceId: 'ws', content: 'fixture'})
    const host = makeHost([block])
    const controller = new AppRuntimeController()
    const persistent = new InMemoryCompiledModuleCache()
    await approveBlock(persistent, block)
    const oldSignal = new AbortController()
    const finishCompile = deferred()
    const finishNew = deferred()
    const failure = new Error('Compilation failed')
    const onLoadError = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const compile = vi.fn(async () => {
      await finishCompile.promise
      throw failure
    })
    const restoreCompile = __setCompileImplForTest(compile)
    const newBeforePublish = vi.fn(() => finishNew.promise)
    const options = {...host, baseExtensions: [], cache: createCompileCache(), persistent, onLoadError}
    const oldLoad = controller.resolve({
      ...options, overrides: new Map([[block.id, true]]), signal: oldSignal.signal,
    })

    try {
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1))
      oldSignal.abort()
      const newLoad = controller.resolve({
        ...options,
        overrides: new Map(),
        signal: new AbortController().signal,
        beforePublish: newBeforePublish,
      })
      await vi.waitFor(() => expect(newBeforePublish).toHaveBeenCalledTimes(1))

      finishCompile.release()
      expect(await oldLoad).toBeUndefined()
      expect(log).toHaveBeenCalledWith(`Failed to load extension block ${block.id}`, failure)
      finishNew.release()
      expect(await newLoad).toBeDefined()

      expect([...host.errorStore.getSnapshot()]).toEqual([])
      expect(onLoadError).not.toHaveBeenCalled()
    } finally {
      finishCompile.release()
      finishNew.release()
      await oldLoad
      restoreCompile()
      log.mockRestore()
    }
  })

  it('publishes the new reports when a superseded resolution rejects', async () => {
    const block = makeBlockData({id: 'pending', workspaceId: 'ws'})
    const host = makeHost([block])
    const controller = new AppRuntimeController()
    const oldSignal = new AbortController()
    const finishOld = deferred()
    const finishNew = deferred()
    const failure = new Error('Old host readiness rejected')
    const currentReport = new Error('Current load error')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const options = {...host, baseExtensions: [], persistent: new InMemoryCompiledModuleCache()}
    const oldBeforePublish = vi.fn(async () => {
      await finishOld.promise
      throw failure
    })
    const newBeforePublish = vi.fn(() => {
      host.errorStore.reportError('current', currentReport)
      return finishNew.promise
    })
    const oldLoad = controller.resolve({
      ...options,
      overrides: new Map(),
      signal: oldSignal.signal,
      beforePublish: oldBeforePublish,
    })

    try {
      await vi.waitFor(() => expect(oldBeforePublish).toHaveBeenCalledTimes(1))
      oldSignal.abort()
      const newLoad = controller.resolve({
        ...options,
        overrides: new Map([[block.id, true]]),
        signal: new AbortController().signal,
        beforePublish: newBeforePublish,
      })
      await vi.waitFor(() => expect(newBeforePublish).toHaveBeenCalledTimes(1))
      expect(host.errorStore.getSnapshot().size).toBe(0)
      expect(host.approvalStore.getSnapshot().size).toBe(0)

      finishOld.release()
      expect(await oldLoad).toBeUndefined()
      expect(log).toHaveBeenCalledWith('Failed to resolve app runtime', failure)
      finishNew.release()
      expect(await newLoad).toBeDefined()

      expect([...host.errorStore.getSnapshot()]).toEqual([['current', currentReport]])
      expect(host.approvalStore.getSnapshot().get(block.id)?.kind).toBe('needs-approval')
    } finally {
      finishOld.release()
      finishNew.release()
      await oldLoad
      log.mockRestore()
    }
  })

  it('leaves reporters live after resolving without a workspace', async () => {
    const host = makeHost()
    const extension = vi.fn(() => null)
    const runtime = await new AppRuntimeController().resolve({
      ...host,
      context: {...host.context, workspaceId: null},
      baseExtensions: [extension],
      overrides: new Map(),
      signal: new AbortController().signal,
    })
    expect(runtime).toBeUndefined()
    expect(extension).not.toHaveBeenCalled()
    expect(host.setFacetRuntime).not.toHaveBeenCalled()

    const failure = new Error('Later error')
    const approval = {kind: 'needs-approval', name: 'Later approval', liveSource: 'fixture', liveHash: 'hash'} as const
    host.errorStore.reportError('later', failure)
    host.approvalStore.report('later', approval)
    expect(host.errorStore.getSnapshot().get('later')).toBe(failure)
    expect(host.approvalStore.getSnapshot().get('later')).toEqual(approval)
  })

  it('stops running effects when the workspace is cleared', () => {
    const {context} = makeHost()
    const controller = new AppRuntimeController()
    const cleanup = vi.fn()
    const start = vi.fn(() => cleanup)
    const runtime = resolveAppRuntimeSync([appEffectsFacet.of({id: 'running', start})], {
      overrides: new Map(), context,
    })

    try {
      controller.reconcile(runtime, context)
      expect(start).toHaveBeenCalledTimes(1)

      controller.reconcile(runtime, {...context, workspaceId: null})
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(1)

      controller.reconcile(runtime, context)
      expect(start).toHaveBeenCalledTimes(2)
    } finally {
      controller.dispose()
    }
  })

  it('publishes the base on a cold context and holds the merged runtime on a warm reload', async () => {
    const host = makeHost()
    const controller = new AppRuntimeController()
    const {context, setFacetRuntime} = host
    const cleanup = vi.fn()
    const start = vi.fn(() => cleanup)
    const baseExtensions = [appEffectsFacet.of({id: 'static', start})]
    const overrides = new Map()
    const base = resolveAppRuntimeSync(baseExtensions, {overrides, context})
    const onRuntime = vi.fn()

    try {
      controller.publishBaseIfCold(base, context, onRuntime)
      expect(onRuntime).toHaveBeenCalledWith(base)
      expect(setFacetRuntime).toHaveBeenCalledWith(base)
      controller.reconcile(base, context)

      const merged = await controller.resolve({
        ...host, baseExtensions, overrides, onRuntime, signal: new AbortController().signal,
      })
      if (!merged) throw new Error('Expected the merged runtime to publish')
      controller.reconcile(merged, context)
      expect(setFacetRuntime.mock.calls).toEqual([[base], [merged]])
      expect(start).toHaveBeenCalledTimes(1)
      expect(cleanup).not.toHaveBeenCalled()

      const nextBase = resolveAppRuntimeSync(baseExtensions, {overrides, context})
      controller.publishBaseIfCold(nextBase, context, onRuntime)
      expect(onRuntime.mock.calls).toEqual([[base], [merged]])
      expect(setFacetRuntime.mock.calls).toEqual([[base], [merged]])

      const nextContext = {...context, workspaceId: 'other'}
      const otherBase = resolveAppRuntimeSync(baseExtensions, {overrides, context: nextContext})
      controller.publishBaseIfCold(otherBase, nextContext, onRuntime)
      controller.reconcile(otherBase, nextContext)
      expect(setFacetRuntime.mock.calls).toEqual([[base], [merged], [otherBase]])
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(2)
    } finally {
      controller.dispose()
    }
  })
})
