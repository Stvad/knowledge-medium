import { FacetRuntime } from '@/extensions/facet.ts'
import {
  scheduledTasksFacet,
  type ScheduledTaskContribution,
  type ScheduledTaskSchedule,
} from '@/extensions/core.ts'
import { ActionConfig } from '@/shortcuts/types.ts'
import { Repo } from '@/data/repo'
import {
  describeAuthoringCatalog,
  type AuthoringCatalog,
} from './authoringCatalog.ts'

export interface DescribeRuntimeContext {
  repo: Repo
  runtime: FacetRuntime
  safeMode: boolean
  actions: readonly ActionConfig[]
  renderers: Record<string, unknown>
  document?: Document
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
  authoring: AuthoringCatalog
  scheduledTasks: ScheduledTaskSummary[]
}

export interface RuntimeDescriptionFilters {
  actions?: string[]
  facets?: string[]
  guides?: string[]
  modules?: string[]
  components?: string[]
  scheduledTasks?: string[]
  storage?: boolean
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
    authoring: {
      guideCount: number
      moduleCount: number
      componentCount: number
      guides: string[]
    }
    scheduledTasks: {
      count: number
      examples: Array<{
        id: string
        description: string
        schedule: string
      }>
    }
  }
  more: Array<{
    need: string
    command: string
  }>
}

export interface ScheduledTaskSummary {
  id: string
  description: string
  schedule: string
  concurrency: NonNullable<ScheduledTaskContribution['concurrency']>
}

const runtimeCommandHints = {
  baseline: [
    'yarn agent ping',
    'yarn agent runtime-summary',
    'yarn agent profiles',
  ],
  dataAccess: [
    'yarn agent sql <all|get|optional|execute> <sql> [paramsJson]',
    'yarn agent get-block <id>',
    'yarn agent subtree <rootId> [--include-root]',
    'yarn agent run-action <id> [depsJson]',
    'yarn agent eval <code>  # use `return ...` to print a value',
  ],
  diagnostics: [
    'yarn agent status',
    'yarn agent describe-runtime [--actions <text>] [--facets <text>] [--guide <id>] [--modules <text>] [--components <text>] [--storage] [--scheduled-tasks [text]]',
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

const normalizedFilters = (filters: string[] | undefined) =>
  (filters ?? [])
    .map(filter => filter.trim().toLowerCase())
    .filter(Boolean)

const matchesAnyFilter = (
  filters: string[] | undefined,
  ...values: Array<string | undefined>
) => {
  const normalized = normalizedFilters(filters)
  if (normalized.length === 0) return true

  const haystack = values
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.toLowerCase())

  return normalized.some(filter =>
    haystack.some(value => value === filter || value.includes(filter)),
  )
}

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

const summarizeSchedule = (schedule: ScheduledTaskSchedule): string => {
  if (schedule.type === 'interval') {
    return `interval every ${schedule.everyMs}ms${schedule.runOnStart ? ' with runOnStart' : ''}`
  }
  if (schedule.type === 'daily') {
    return `daily at ${schedule.time}${schedule.timezone ? ` ${schedule.timezone}` : ''}`
  }
  return `cron ${schedule.expression}${schedule.timezone ? ` ${schedule.timezone}` : ''}`
}

export const describeScheduledTasks = (
  runtime: FacetRuntime,
  filters?: string[],
): ScheduledTaskSummary[] =>
  runtime.read(scheduledTasksFacet)
    .filter(task => matchesAnyFilter(filters, task.id, task.description, summarizeSchedule(task.schedule)))
    .map(task => ({
      id: task.id,
      description: task.description,
      schedule: summarizeSchedule(task.schedule),
      concurrency: task.concurrency ?? 'skip',
    }))

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
  filters: RuntimeDescriptionFilters = {},
): Promise<RuntimeDescription> => {
  const apiSurface = await getApiSurface()

  return {
    activeWorkspaceId: context.repo.activeWorkspaceId,
    currentUser: context.repo.user,
    safeMode: context.safeMode,
    actions: context.actions
      .filter(action => matchesAnyFilter(filters.actions, action.id, action.description, action.context))
      .map(action => ({
        id: action.id,
        description: action.description,
        context: action.context,
        hasDefaultBinding: Boolean(action.defaultBinding),
      })),
    renderers: Object.keys(context.renderers),
    facets: describeFacets(context.runtime)
      .filter(facet => matchesAnyFilter(filters.facets, facet.id)),
    apiSurface,
    authoring: describeAuthoringCatalog(apiSurface, {
      guides: filters.guides,
      modules: filters.modules,
      components: filters.components,
    }, context.document),
    scheduledTasks: describeScheduledTasks(context.runtime, filters.scheduledTasks),
  }
}

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
  const authoring = describeAuthoringCatalog(apiSurface, {}, context.document)
  const scheduledTasks = describeScheduledTasks(context.runtime)

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
      authoring: {
        guideCount: authoring.guides.length,
        moduleCount: authoring.modules.length,
        componentCount: authoring.components.length,
        guides: authoring.guides.map(guide => guide.id),
      },
      scheduledTasks: {
        count: scheduledTasks.length,
        examples: scheduledTasks.slice(0, 5).map(task => ({
          id: task.id,
          description: task.description,
          schedule: task.schedule,
        })),
      },
    },
    more: [
      {
        need: 'Full runtime diagnostic dump with action, facet, renderer, and API export details',
        command: 'yarn agent describe-runtime [--actions <text>] [--facets <text>]',
      },
      {
        need: 'Guided extension authoring paths for sync plugins, dialogs, block-backed config, and scheduled tasks',
        command: 'yarn agent describe-runtime --guide external-sync-plugin --storage',
      },
      {
        need: 'Discover extension-safe modules and UI components',
        command: 'yarn agent describe-runtime --modules dialog --components dialog,input,button',
      },
      {
        need: 'Scheduled task contributions currently active in the app runtime',
        command: 'yarn agent describe-runtime --scheduled-tasks',
      },
      {
        need: 'Bridge clients and pending command queue',
        command: 'yarn agent status',
      },
      {
        need: 'Targeted in-app inspection using the runtime context',
        command: 'yarn agent eval <code>  # use `return ...` to print a value',
      },
      {
        need: 'Raw protocol access for uncommon runtime commands',
        command: 'yarn agent raw <json>',
      },
    ],
  }
}
