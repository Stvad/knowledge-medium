import { FacetRuntime } from '@/extensions/facet.ts'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.ts'
import { Repo } from '@/data/repo'
import {
  describeAuthoringCatalog,
  type AuthoringCatalog,
} from './authoringCatalog.ts'

interface ContextDependencySchema {
  acceptedKeys: readonly string[]
  cliInputKeys: readonly string[]
  runnableFromCli: boolean
  notes?: string
}

// Keyed on ActionContextTypes; the bridge's run-action handler in
// commands.ts mirrors these expectations when it assembles the
// dependency bag from a CLI payload.
const contextDependencyCatalog: Record<string, ContextDependencySchema> = {
  [ActionContextTypes.GLOBAL]: {
    acceptedKeys: ['uiStateBlock'],
    cliInputKeys: ['uiStateBlockId'],
    runnableFromCli: true,
  },
  [ActionContextTypes.NORMAL_MODE]: {
    acceptedKeys: ['uiStateBlock', 'block', 'visualTargetId'],
    cliInputKeys: ['uiStateBlockId', 'blockId'],
    runnableFromCli: true,
    notes: 'visualTargetId is a transient editor concept and is not accepted by the CLI bridge',
  },
  [ActionContextTypes.MULTI_SELECT_MODE]: {
    acceptedKeys: ['uiStateBlock', 'selectedBlocks', 'anchorBlock'],
    cliInputKeys: ['uiStateBlockId', 'selectedBlockIds', 'anchorBlockId'],
    runnableFromCli: true,
  },
  [ActionContextTypes.EDIT_MODE_CM]: {
    acceptedKeys: ['uiStateBlock', 'block', 'editorView'],
    cliInputKeys: [],
    runnableFromCli: false,
    notes: 'editorView is a live CodeMirror handle that cannot be reconstructed from a JSON payload',
  },
  [ActionContextTypes.PROPERTY_EDITING]: {
    acceptedKeys: ['uiStateBlock', 'block', 'input'],
    cliInputKeys: [],
    runnableFromCli: false,
    notes: 'input is a live HTMLInputElement focused by the user and cannot be reconstructed from JSON',
  },
}

const baseContextDependencySchema: ContextDependencySchema = {
  acceptedKeys: ['uiStateBlock'],
  cliInputKeys: ['uiStateBlockId'],
  runnableFromCli: true,
  notes: 'Unknown context type; assuming the BaseShortcutDependencies shape',
}

const dependencySchemaForContext = (context: string): ContextDependencySchema =>
  contextDependencyCatalog[context] ?? baseContextDependencySchema

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

export interface ActionSummary {
  id: string
  description: string
  context: string
  hasDefaultBinding: boolean
  /** Whether `yarn agent run-action` can dispatch this action. False
   *  for contexts whose dependencies are live UI handles (CodeMirror
   *  view, focused input). */
  runnableFromCli: boolean
  /** Dependency keys the action handler receives at runtime. */
  expectedDependencies: readonly string[]
  /** Keys the CLI `depsJson` payload accepts. Empty when
   *  runnableFromCli is false. */
  cliDependencyKeys: readonly string[]
  /** Extra context about CLI invocability, when worth noting. */
  cliDependencyNotes?: string
}

export interface RuntimeDescription {
  activeWorkspaceId: string | null
  currentUser: {id: string, name?: string}
  safeMode: boolean
  actions: ActionSummary[]
  renderers: string[]
  facets: FacetSummary[]
  apiSurface: ApiSurfaceSummary
  authoring: AuthoringCatalog
}

export interface RuntimeDescriptionFilters {
  actions?: string[]
  facets?: string[]
  guides?: string[]
  modules?: string[]
  components?: string[]
  storage?: boolean
  /** When true, return the authoring sections (guides, storage,
   *  apiSurface) without the bulky runtime introspection sections
   *  (actions, facets, renderers, modules, components). The CLI sets
   *  this implicitly when `--guide` is passed alone, so an agent
   *  fetching extension-authoring guidance doesn't get 350KB of
   *  unrelated runtime detail in the response. */
  brief?: boolean
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
    'yarn agent describe-runtime [--actions <text>] [--facets <text>] [--guide <id>] [--modules <text>] [--components <text>] [--storage]',
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

  // `brief` callers want authoring-only output. Empty the bulky
  // runtime-introspection arrays — actions/facets/renderers are
  // ~150KB combined and irrelevant if you're reading a guide.
  const briefMode = filters.brief === true

  const actions = briefMode
    ? []
    : context.actions
      .filter(action => matchesAnyFilter(filters.actions, action.id, action.description, action.context))
      .map(action => {
        const schema = dependencySchemaForContext(action.context)
        return {
          id: action.id,
          description: action.description,
          context: action.context,
          hasDefaultBinding: Boolean(action.defaultBinding),
          runnableFromCli: schema.runnableFromCli,
          expectedDependencies: schema.acceptedKeys,
          cliDependencyKeys: schema.cliInputKeys,
          ...(schema.notes ? {cliDependencyNotes: schema.notes} : {}),
        }
      })

  return {
    activeWorkspaceId: context.repo.activeWorkspaceId,
    currentUser: context.repo.user,
    safeMode: context.safeMode,
    actions,
    renderers: briefMode ? [] : Object.keys(context.renderers),
    facets: briefMode
      ? []
      : describeFacets(context.runtime)
        .filter(facet => matchesAnyFilter(filters.facets, facet.id)),
    apiSurface,
    authoring: describeAuthoringCatalog(apiSurface, {
      guides: filters.guides,
      modules: filters.modules,
      components: filters.components,
      // In brief mode, suppress the module/component glob dumps —
      // they're 150KB of internal paths the agent doesn't need while
      // reading a guide. The guide's `preferredModules` field already
      // names what matters.
      omitDiscoverableModules: briefMode,
    }, context.document),
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
    },
    more: [
      {
        need: 'Full runtime diagnostic dump with action, facet, renderer, and API export details',
        command: 'yarn agent describe-runtime [--actions <text>] [--facets <text>]',
      },
      {
        need: 'Guided extension authoring paths for sync plugins, dialogs, and block-backed config',
        command: 'yarn agent describe-runtime --guide external-sync-plugin --storage',
      },
      {
        need: 'Discover extension-safe modules and UI components',
        command: 'yarn agent describe-runtime --modules dialog --components dialog,input,button',
      },
      {
        need: 'Bridge clients and pending command queue',
        command: 'yarn agent status',
      },
      {
        need: 'Targeted in-app inspection using the runtime context — but NOT for "what is registered". For actions/facets/renderers/contributions, prefer `describe-runtime`; reaching into `facetRuntime.staticContributionsByFacet` or `repo.runtimeContributionBuckets` from eval is reading internal caches with different shapes and will mislead you.',
        command: 'yarn agent eval <code>  # use `return ...` to print a value',
      },
      {
        need: 'Raw protocol access for uncommon runtime commands',
        command: 'yarn agent raw <json>',
      },
    ],
  }
}
