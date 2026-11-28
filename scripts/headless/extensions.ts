import {resolve} from 'node:path'
import {readExtensionImportManifest} from '../../vite-plugins/extensionImportManifest'
import {AppRuntimeController, type AppRuntimeContext} from '@/extensions/appRuntimeController.js'
import {createCompileCache, setExtensionCompilePlatform} from '@/extensions/compileExtensionModule.js'
import {appEffectsFacet, type AppEffect} from '@/extensions/core.js'
import {isExtensionContribution} from '@/extensions/dynamicExtensions.js'
import {ExtensionImportError} from '@/extensions/extensionImportPolicy.js'
import {normalizeExtensionSource} from '@/extensions/normalizeExtensionSource.js'
import type {AppExtension, FacetContribution, FacetRuntime} from '@/facets/facet.js'
import {declaresExtensionType} from '@/data/blockTypes.js'
import type {BlockData} from '@/types'
import type {HeadlessConfig} from './config'
import {prepareExtensionApprovals, type ApprovalRefusal} from './extensionApprovals'
import {instantiateHostExtension} from './extensionVm'

type Refusal = ApprovalRefusal | 'not-writable' | 'missing-block' | 'load-error'
type ExtensionState = {state: 'running' | 'update-available'} | {state: 'refused', reason: Refusal}

const batch = {beginBatch() {}, commitBatch() {}, abandonBatch() {}}

export async function prepareHostExtensions(
  config: HeadlessConfig, context: AppRuntimeContext, baseExtensions: readonly AppExtension[],
  baseRuntime: FacetRuntime, onRuntime: (runtime: FacetRuntime) => void,
  signal: AbortSignal,
) {
  const blocks = config.extensions?.map(({block}) => block) ?? []
  if (!blocks.length) return
  const manifest = readExtensionImportManifest(resolve(import.meta.dirname, '../..'))
  const {persistent, refusals} = await prepareExtensionApprovals(config, manifest)
  const overrides = new Map(blocks.map(block => [block, true] as const))
  const controller = new AppRuntimeController()
  const states = new Map<string, ExtensionState>()
  const effectIds = new Map<string, string[]>()
  const subscriptions: Array<() => void> = []
  let admission: AbortController | undefined
  let mounted = false

  for (const [block, reason] of refusals) console.warn('Headless extension refused', block, reason)
  const restorePlatform = setExtensionCompilePlatform({
    allowUnpinnedLive: false,
    instantiate(record, block) {
      const current = admission
      const check = () => {
        signal.throwIfAborted()
        if (!current) throw new Error('Extension evaluation requires writable admission')
        current.signal.throwIfAborted()
      }
      return instantiateHostExtension(block, record, manifest, specifier => import(/* @vite-ignore */ specifier), check)
    },
  })

  const ownerOf = (contribution: FacetContribution<AppEffect>) =>
    blocks.find(block => isExtensionContribution(contribution.source, block))

  function trackDrift(block: string, source: string) {
    const {repo, workspaceId} = context
    const handle = repo.block(block)
    const compare = (live: BlockData | null) => {
      if (!live || live.workspaceId !== workspaceId || !declaresExtensionType(live)) return
      const state = normalizeExtensionSource(live.content) === source ? 'running' : 'update-available'
      if (state === 'update-available' && states.get(block)?.state !== state) {
        console.warn('Headless extension update-available', block)
      }
      states.set(block, {state})
    }
    subscriptions.push(handle.subscribe(compare))
    compare(handle.peek() ?? null)
  }

  function suspend() {
    admission?.abort()
    admission = undefined
    for (const off of subscriptions.splice(0)) off()
    controller.dispose()
    states.clear()
    effectIds.clear()
    if (mounted) {
      mounted = false
      onRuntime(baseRuntime)
      context.repo.setFacetRuntime(baseRuntime)
    }
  }

  return {
    setWritableAdmission(open: boolean, refreshAdmission: () => Promise<unknown>) {
      if (!open) {
        suspend()
        return
      }
      if (signal.aborted) return
      const attempt = new AbortController()
      admission = attempt
      const loaded = new Set<string>()
      const failed = new Map<string, Refusal>()
      void controller.resolve({
        baseExtensions, context, overrides, persistent, cache: createCompileCache(),
        signal: attempt.signal, evaluationSignal: attempt.signal,
        onRuntime(runtime) {
          mounted = true
          onRuntime(runtime)
        },
        errorStore: {...batch, reportError(block, error) {
          failed.set(block, error instanceof ExtensionImportError ? error.reason : 'load-error')
        }},
        approvalStore: {...batch, report() {}},
        logLoadError(block, error) {
          console.warn('Headless extension refused', block, error instanceof ExtensionImportError ? error.reason : 'load-error')
        },
        onBlockLoaded: block => loaded.add(block),
        async beforePublish() {
          if (!attempt.signal.aborted) await refreshAdmission()
          if (signal.aborted) attempt.abort()
        },
      }).then(async runtime => {
        if (!runtime || attempt.signal.aborted || signal.aborted) return
        for (const block of blocks) {
          const approval = await persistent.read(block)
          if (attempt.signal.aborted || signal.aborted) return
          const refusal = refusals.get(block) ?? failed.get(block)
          if (refusal) states.set(block, {state: 'refused', reason: refusal})
          else if (!approval || !loaded.has(block)) states.set(block, {state: 'refused', reason: 'missing-block'})
          else {
            states.set(block, {state: 'running'})
            trackDrift(block, approval.approvedSource)
          }
        }
        for (const contribution of runtime.contributions(appEffectsFacet)) {
          const owner = ownerOf(contribution)
          if (owner === undefined) continue
          const ids = effectIds.get(owner) ?? []
          if (!ids.includes(contribution.value.id)) ids.push(contribution.value.id)
          effectIds.set(owner, ids)
        }
        controller.reconcile(runtime, context, contribution => ownerOf(contribution) !== undefined)
      }).catch(() => console.warn('Headless extension runtime load-error'))
    },
    health() {
      return blocks.map(block => ({
        block, effectIds: effectIds.get(block) ?? [],
        ...(states.get(block) ?? {state: 'refused', reason: refusals.get(block) ?? 'not-writable'}),
      }))
    },
    stop() {
      suspend()
      restorePlatform()
    },
  }
}
