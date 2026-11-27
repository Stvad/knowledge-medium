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
    await persistent.write(approved.id, {
      sourceHash: await hashExtensionSource(approved.content),
      approvedSource: approved.content,
      compiled: approved.content,
      compilerVersion: COMPILER_VERSION,
      approvedAt: 0,
    })
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
    host.approvalStore.report('active', {kind: 'needs-approval', name: 'Active', liveHash: 'hash'})
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
