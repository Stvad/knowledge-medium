import {resolve} from 'node:path'
import {readExtensionImportManifest} from '../../vite-plugins/extensionImportManifest'
import {AppRuntimeController, type AppRuntimeContext} from '@/extensions/appRuntimeController.js'
import {createCompileCache, setExtensionCompilePlatform} from '@/extensions/compileExtensionModule.js'
import {appEffectsFacet, type AppEffect} from '@/extensions/core.js'
import {isExtensionContribution} from '@/extensions/dynamicExtensions.js'
import {ExtensionImportError} from '@/extensions/extensionImportPolicy.js'
import {normalizeExtensionSource} from '@/extensions/normalizeExtensionSource.js'
import {resolveFacetRuntimeSync, type AppExtension, type FacetContribution, type FacetRuntime} from '@/facets/facet.js'
import {declaresExtensionType} from '@/data/blockTypes.js'
import type {BlockData} from '@/types'
import type {HeadlessConfig} from './config'
import {prepareExtensionApprovals, type ApprovalRefusal} from './extensionApprovals'
import {instantiateHostExtension} from './extensionVm'

type Refusal = ApprovalRefusal | 'not-writable' | 'starting' | 'missing-block' | 'load-error'
type ExtensionState = {state: 'running' | 'update-available'} | {state: 'refused', reason: Refusal}

export async function prepareHostExtensions(
  config: HeadlessConfig, context: AppRuntimeContext, baseExtensions: readonly AppExtension[],
  onRuntime: (runtime: FacetRuntime) => void,
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
  let admission: {abort: AbortController, beforeEvaluate: () => Promise<void>} | undefined
  let mounted = false

  for (const [block, reason] of refusals) console.warn('Headless extension refused', block, reason)
  const restorePlatform = setExtensionCompilePlatform({
    allowUnpinnedLive: false,
    async instantiate(record, block, beforeEvaluate) {
      const checkAdmission = admission?.beforeEvaluate
      const grant = await persistent.read(block)
      if (grant?.sourceHash !== record.sourceHash) throw new Error('Extension record does not match the host grant')
      if (!checkAdmission || (beforeEvaluate && beforeEvaluate !== checkAdmission)) {
        throw new Error('Extension evaluation requires writable admission')
      }
      return instantiateHostExtension(block, grant, manifest, specifier => import(/* @vite-ignore */ specifier), checkAdmission)
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
    admission?.abort.abort()
    admission = undefined
    for (const off of subscriptions.splice(0)) off()
    controller.dispose()
    states.clear()
    effectIds.clear()
    if (mounted) {
      mounted = false
      const runtime = resolveFacetRuntimeSync(baseExtensions, context)
      onRuntime(runtime)
      context.repo.setFacetRuntime(runtime)
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
      const evaluationSignal = AbortSignal.any([signal, attempt.signal])
      const beforeEvaluate = async () => {
        evaluationSignal.throwIfAborted()
        await refreshAdmission()
        evaluationSignal.throwIfAborted()
      }
      admission = {abort: attempt, beforeEvaluate}
      const reportFailure = () => {
        if (evaluationSignal.aborted) return
        console.warn('Headless extension runtime load-error')
        try {
          suspend()
        } catch {
          console.warn('Headless extension runtime restore-error')
        }
        for (const block of blocks) {
          states.set(block, {state: 'refused', reason: refusals.get(block) ?? 'load-error'})
        }
      }
      const loaded = new Set<string>()
      const failed = new Map<string, Refusal>()
      void controller.resolve({
        baseExtensions, context, overrides, persistent, cache: createCompileCache(),
        signal: evaluationSignal, beforeEvaluate, logResolveError: reportFailure,
        onRuntime(runtime) {
          mounted = true
          onRuntime(runtime)
        },
        logLoadError(block, error) {
          const reason = error instanceof ExtensionImportError ? error.reason : 'load-error'
          failed.set(block, reason)
        },
        onBlockLoaded: block => loaded.add(block),
        async beforePublish() {
          if (!evaluationSignal.aborted) await refreshAdmission()
        },
      }).then(async runtime => {
        if (!runtime || evaluationSignal.aborted) return
        for (const block of blocks) {
          const approval = await persistent.read(block)
          if (evaluationSignal.aborted) return
          const refusal = refusals.get(block) ?? failed.get(block)
          if (refusal) {
            if (failed.has(block)) console.warn('Headless extension refused', block, refusal)
            states.set(block, {state: 'refused', reason: refusal})
          } else if (!approval || !loaded.has(block)) {
            states.set(block, {state: 'refused', reason: 'missing-block'})
          } else {
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
      }).catch(reportFailure)
    },
    health() {
      return blocks.map(block => ({
        block, effectIds: effectIds.get(block) ?? [],
        ...(states.get(block) ?? {state: 'refused', reason: refusals.get(block) ?? (admission ? 'starting' : 'not-writable')}),
      }))
    },
    stop() {
      try {
        suspend()
      } finally {
        restorePlatform()
      }
    },
  }
}
