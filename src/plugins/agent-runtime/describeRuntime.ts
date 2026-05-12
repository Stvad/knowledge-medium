import { FacetRuntime } from '@/extensions/facet.ts'
import { ActionConfig } from '@/shortcuts/types.ts'
import { Repo } from '@/data/repo'

export interface DescribeRuntimeContext {
  repo: Repo
  runtime: FacetRuntime
  safeMode: boolean
  actions: readonly ActionConfig[]
  renderers: Record<string, unknown>
}

export interface FacetContributionSummary {
  source: string | undefined
  precedence: number | undefined
  valueSummary: string
}

export interface FacetSummary {
  id: string
  contributionCount: number
  contributions: FacetContributionSummary[]
}

export interface ApiSurfaceSummary {
  module: string
  exports: string[]
}

export interface RuntimeDescription {
  activeWorkspaceId: string | null
  currentUser: {id: string, name?: string}
  safeMode: boolean
  actions: Array<{
    id: string
    description: string
    context: string
    hasDefaultBinding: boolean
  }>
  renderers: string[]
  facets: FacetSummary[]
  apiSurface: ApiSurfaceSummary
}

export interface RuntimePing {
  ok: true
  activeWorkspaceId: string | null
  currentUser: {id: string, name?: string}
  safeMode: boolean
}

export interface RuntimeSummary {
  activeWorkspaceId: string | null
  currentUser: {id: string, name?: string}
  safeMode: boolean
  commands: {
    baseline: string[]
    dataAccess: string[]
    diagnostics: string[]
  }
  capabilities: {
    actions: {
      count: number
      byContext: Record<string, number>
      examples: Array<{
        id: string
        description: string
        context: string
      }>
    }
    renderers: {
      count: number
      ids: string[]
    }
    facets: {
      count: number
      contributionCount: number
      largest: Array<{
        id: string
        contributionCount: number
      }>
    }
    apiSurface: {
      module: string
      exportCount: number
      examples: string[]
    }
  }
  more: Array<{
    need: string
    command: string
  }>
}

const runtimeCommandHints = {
  baseline: [
    'yarn agent ping',
    'yarn agent runtime-summary',
  ],
  dataAccess: [
    'yarn agent sql <all|get|optional|execute> <sql> [paramsJson]',
    'yarn agent get-block <id>',
    'yarn agent subtree <rootId> [--include-root]',
    'yarn agent eval <code>',
  ],
  diagnostics: [
    'yarn agent status',
    'yarn agent describe-runtime',
    'yarn agent raw <json>',
  ],
}

const summarizeContributionValue = (value: unknown): string => {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const t = typeof value
  if (t === 'function') {
    const fn = value as {name?: string}
    return `[Function ${fn.name || 'anonymous'}]`
  }
  if (t !== 'object') return String(value)

  const obj = value as Record<string, unknown>
  // Common shapes that appear as facet contribution values:
  //   { id, description, context, ... }   (actions)
  //   { id, renderer }                    (renderers)
  //   anything else: drop a few interesting keys
  const interestingKeys = ['id', 'description', 'context', 'name', 'type']
  const summary: Record<string, unknown> = {}
  for (const key of interestingKeys) {
    if (obj[key] !== undefined) summary[key] = obj[key]
  }
  if (Object.keys(summary).length > 0) return JSON.stringify(summary)
  // Last resort: enumerate top-level keys.
  return `{${Object.keys(obj).slice(0, 6).join(', ')}}`
}

export const describeFacets = (runtime: FacetRuntime): FacetSummary[] => {
  const facetIds = runtime.facetIds().sort()
  return facetIds.map(id => {
    const contributions = runtime.contributionsById(id)
    return {
      id,
      contributionCount: contributions.length,
      contributions: contributions.map(c => ({
        source: c.source,
        precedence: c.precedence,
        valueSummary: summarizeContributionValue(c.value),
      })),
    }
  })
}

const countActionsByContext = (actions: readonly ActionConfig[]) =>
  actions.reduce<Record<string, number>>((counts, action) => {
    counts[action.context] = (counts[action.context] ?? 0) + 1
    return counts
  }, {})

const summarizeFacetCounts = (runtime: FacetRuntime) => {
  const facets = runtime.facetIds()
    .sort()
    .map(id => ({
      id,
      contributionCount: runtime.contributionsById(id).length,
    }))
  return {
    count: facets.length,
    contributionCount: facets.reduce((sum, facet) => sum + facet.contributionCount, 0),
    largest: [...facets]
      .sort((a, b) => b.contributionCount - a.contributionCount || a.id.localeCompare(b.id))
      .slice(0, 5),
  }
}

// Curated public surface for extension authors. Memoize once per
// session — `Object.keys` of an ESM module is constant.
let cachedApiSurface: ApiSurfaceSummary | null = null
export const getApiSurface = async (): Promise<ApiSurfaceSummary> => {
  if (!cachedApiSurface) {
    const api = await import('@/extensions/api.ts')
    cachedApiSurface = {
      module: '@/extensions/api',
      exports: Object.keys(api).sort(),
    }
  }
  return cachedApiSurface
}

// Test-only: clears the apiSurface memo so repeat tests start clean.
export const __resetApiSurfaceCacheForTest = () => {
  cachedApiSurface = null
}

export const describeRuntime = async (
  context: DescribeRuntimeContext,
): Promise<RuntimeDescription> => ({
  activeWorkspaceId: context.repo.activeWorkspaceId,
  currentUser: context.repo.user,
  safeMode: context.safeMode,
  actions: context.actions.map(action => ({
    id: action.id,
    description: action.description,
    context: action.context,
    hasDefaultBinding: Boolean(action.defaultBinding),
  })),
  renderers: Object.keys(context.renderers),
  facets: describeFacets(context.runtime),
  apiSurface: await getApiSurface(),
})

export const pingRuntime = (context: DescribeRuntimeContext): RuntimePing => ({
  ok: true,
  activeWorkspaceId: context.repo.activeWorkspaceId,
  currentUser: context.repo.user,
  safeMode: context.safeMode,
})

export const describeRuntimeSummary = async (
  context: DescribeRuntimeContext,
): Promise<RuntimeSummary> => {
  const apiSurface = await getApiSurface()
  const renderers = Object.keys(context.renderers)

  return {
    activeWorkspaceId: context.repo.activeWorkspaceId,
    currentUser: context.repo.user,
    safeMode: context.safeMode,
    commands: runtimeCommandHints,
    capabilities: {
      actions: {
        count: context.actions.length,
        byContext: countActionsByContext(context.actions),
        examples: context.actions.slice(0, 10).map(action => ({
          id: action.id,
          description: action.description,
          context: action.context,
        })),
      },
      renderers: {
        count: renderers.length,
        ids: renderers,
      },
      facets: summarizeFacetCounts(context.runtime),
      apiSurface: {
        module: apiSurface.module,
        exportCount: apiSurface.exports.length,
        examples: apiSurface.exports.slice(0, 10),
      },
    },
    more: [
      {
        need: 'Full runtime diagnostic dump with action, facet, renderer, and API export details',
        command: 'yarn agent describe-runtime',
      },
      {
        need: 'Bridge clients and pending command queue',
        command: 'yarn agent status',
      },
      {
        need: 'Targeted in-app inspection using the runtime context',
        command: 'yarn agent eval <code>',
      },
      {
        need: 'Raw protocol access for uncommon runtime commands',
        command: 'yarn agent raw <json>',
      },
    ],
  }
}
