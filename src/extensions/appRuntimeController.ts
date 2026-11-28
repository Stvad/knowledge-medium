import type {Repo} from '@/data/repo'
import type {BatchableKeyedStore} from '@/extensions/batchableKeyedStore.js'
import {appEffectsFacet, type AppEffect} from '@/extensions/core.js'
import {
  dynamicExtensionsExtension,
  type DynamicExtensionsOptions,
  type ExtensionApprovalStatusReporter,
  type ExtensionLoadErrorReporter,
} from '@/extensions/dynamicExtensions.js'
import {EffectReconciler} from '@/extensions/liveRuntime.js'
import {
  combineFacetContributions,
  type AppExtension,
  type FacetContribution,
  type FacetResolveContext,
  type FacetRuntime,
} from '@/facets/facet.js'
import {resolveAppRuntime} from '@/facets/resolveAppRuntime.js'
import type {Overrides} from '@/facets/togglable.js'

export interface AppRuntimeContext extends FacetResolveContext {
  repo: Repo
  workspaceId: string | null
  safeMode: boolean
}

type EffectContext = Pick<AppRuntimeContext, 'repo' | 'workspaceId' | 'safeMode'>
type ReportBatch = Pick<BatchableKeyedStore<unknown>, 'beginBatch' | 'commitBatch' | 'abandonBatch'>
/** Hands the runtime to the host before Repo installation. Reconcile after installation. */
type RuntimeListener = (runtime: FacetRuntime) => void

interface RuntimeResolutionOptions extends Pick<DynamicExtensionsOptions, 'cache' | 'persistent' | 'logLoadError' | 'evaluationSignal' | 'onBlockLoaded'> {
  baseExtensions: readonly AppExtension[]
  context: AppRuntimeContext
  overrides: Overrides
  errorStore: ReportBatch & {reportError: ExtensionLoadErrorReporter}
  approvalStore: ReportBatch & {report: ExtensionApprovalStatusReporter}
  /** Abort a previous resolution before starting another with the same stores. */
  signal: AbortSignal
  beforePublish?: () => Promise<void>
  onRuntime?: RuntimeListener
  onLoadError?: ExtensionLoadErrorReporter
}

export class AppRuntimeController {
  private readonly effects = new EffectReconciler()

  /** On a warm reload keep the merged runtime and its registries live while resolving. */
  publishBaseIfCold(runtime: FacetRuntime, context: EffectContext, onRuntime?: RuntimeListener): void {
    const {repo, workspaceId, safeMode} = context
    if (!this.effects.isColdFor(repo, workspaceId, safeMode)) return
    this.publish(repo, runtime, onRuntime)
  }

  async resolve({
    baseExtensions, context, overrides, cache, persistent, errorStore, approvalStore,
    signal, beforePublish, onRuntime, onLoadError, logLoadError, evaluationSignal, onBlockLoaded,
  }: RuntimeResolutionOptions): Promise<FacetRuntime | undefined> {
    if (signal.aborted) return

    const {repo, workspaceId, safeMode} = context
    errorStore.beginBatch()
    approvalStore.beginBatch()

    if (!workspaceId) {
      errorStore.abandonBatch()
      approvalStore.abandonBatch()
      return
    }

    try {
      const runtime = await resolveAppRuntime([
        baseExtensions,
        dynamicExtensionsExtension({
          repo, workspaceId, safeMode, overrides, cache, persistent,
          logLoadError, evaluationSignal, onBlockLoaded,
          errorReporter: (blockId, error) => {
            if (signal.aborted) return
            errorStore.reportError(blockId, error)
            onLoadError?.(blockId, error)
          },
          approvalStatusReporter: (blockId, status) => {
            if (signal.aborted) return
            approvalStore.report(blockId, status)
          },
        }),
      ], {overrides, safeMode, context})

      if (beforePublish) await beforePublish()
      if (signal.aborted) return

      errorStore.commitBatch()
      approvalStore.commitBatch()
      this.publish(repo, runtime, onRuntime)
      return runtime
    } catch (error) {
      console.error('Failed to resolve app runtime', error)
      // A superseded resolution no longer owns the stores' batches.
      if (!signal.aborted) {
        errorStore.abandonBatch()
        approvalStore.abandonBatch()
      }
    }
  }

  /** Reconcile after the host adopts the published runtime. Eligibility can change on the same runtime. */
  reconcile(
    runtime: FacetRuntime,
    {repo, workspaceId, safeMode}: EffectContext,
    // The headless host filters eligible effects by contribution provenance.
    filter?: (contribution: FacetContribution<AppEffect>) => boolean,
  ): void {
    if (!workspaceId) {
      this.dispose()
      return
    }

    const effects = filter
      ? combineFacetContributions(appEffectsFacet, runtime.contributions(appEffectsFacet).filter(filter), runtime.context)
      : runtime.read(appEffectsFacet)
    this.effects.reconcile(repo, runtime, workspaceId, safeMode, effects)
  }

  /** The host must abort any in-flight resolution before disposing effects. */
  dispose(): void {
    this.effects.dispose()
  }

  private publish(repo: Repo, runtime: FacetRuntime, onRuntime?: RuntimeListener): void {
    onRuntime?.(runtime)
    repo.setFacetRuntime(runtime)
  }
}
