import { FacetRuntime } from '@/facets/facet.js'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { Repo } from '@/data/repo'
import {
  describeAuthoringCatalog,
  type AuthoringCatalog,
} from './authoringCatalog.ts'
import { DATA_MODEL_GUIDE } from './dataModelGuide.ts'

/** Guide id that surfaces the data-model orientation through
 *  `describe-runtime --guide data-model`. Kept separate from the
 *  extension-authoring guides in the authoring catalog — different
 *  audience (reading/querying user data vs authoring extensions). */
export const DATA_MODEL_GUIDE_ID = 'data-model'
import {
  getCommandMeta,
  type KnownCommandType,
} from '@knowledge-medium/agent-cli/protocol'

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
    acceptedKeys: ['uiStateBlock', 'block', 'renderScopeId'],
    cliInputKeys: ['uiStateBlockId', 'blockId'],
    runnableFromCli: true,
    notes: 'renderScopeId is a rendered UI concept and is not accepted by the CLI bridge',
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
  /** Source of the facet's `validate` predicate, if it has one. Tells
   *  agent authors what shape a contribution must have — e.g. that
   *  `headerItemsFacet` requires `region: 'start'|'end'` and a
   *  `component: function`. Truncated to keep output readable. */
  validate?: string
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
  /** The data-model guide markdown, present only when the caller asked
   *  for it via `--guide data-model`. (Its own home is `yarn agent
   *  data-model`; this is the discoverable describe-runtime touch-point.) */
  dataModel?: string
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
    /** Storage decision tree, surfaced inline because picking the
     *  wrong shape (e.g. localStorage for non-credential config) is
     *  the single most common extension-authoring mistake and the
     *  fix is a one-line rule, not a multi-step pattern lookup.
     *  Agents should consult this *before* writing any new
     *  storage-touching extension code. */
    storage: {
      principles: string[]
      patterns: Array<{
        id: string
        when: string
      }>
    }
  }
  more: Array<{
    need: string
    command: string
  }>
}

// Cherry-pick the most useful wire commands per category. Strings come
// from `knownCommandRegistry` so the runtime-summary hints, the CLI
// --help, and any other surface that documents these commands share a
// single source of truth — changing the usage of `sql` in protocol.ts
// updates the hints here automatically.
//
// Local-only CLI commands (`profiles`, `status`, `raw`) aren't part of
// the wire protocol; they stay hard-coded next to the wire-derived
// entries. The `yarn agent` prefix is the monorepo wrapper for
// kmagent — both invoke the same binary.
const wireUsage = (type: KnownCommandType): string =>
  `yarn agent ${getCommandMeta(type).usage.replace(/^kmagent /, '')}`

const runtimeCommandHints = {
  baseline: [
    wireUsage('ping'),
    wireUsage('runtime-summary'),
    `${wireUsage('data-model')}  # orient on blocks/refs/pages/backlinks before querying`,
    'yarn agent profiles',
  ],
  dataAccess: [
    wireUsage('sql'),
    wireUsage('get-block'),
    wireUsage('get-subtree'),
    wireUsage('backlinks'),
    wireUsage('grouped-backlinks'),
    wireUsage('run-action'),
    `${wireUsage('eval')}  # use \`return ...\` to print a value`,
  ],
  diagnostics: [
    'yarn agent status',
    wireUsage('describe-runtime'),
    'yarn agent raw <json>',
  ],
}

const MAX_SUMMARY_LENGTH = 320

const renderSummaryValue = (value: unknown, depth: number): unknown => {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'function') {
    const fn = value as {name?: string}
    return `[Function ${fn.name || 'anonymous'}]`
  }
  if (t !== 'object') return value
  if (depth <= 0) {
    return Array.isArray(value)
      ? `[Array(${value.length})]`
      : `{${Object.keys(value as object).slice(0, 6).join(', ')}}`
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map(item => renderSummaryValue(item, depth - 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === undefined) continue
    out[key] = renderSummaryValue(inner, depth - 1)
  }
  return out
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

  // Render the whole shape so agent authors can see all the keys a
  // contribution carries (region, component, parent, kind, …). Functions
  // are stringified as `[Function name]` so React components stay
  // readable without dumping their source. Cap the total length so a
  // pathological value can't bloat describe-runtime output.
  const rendered = renderSummaryValue(value, 3)
  const json = JSON.stringify(rendered)
  if (json.length <= MAX_SUMMARY_LENGTH) return json
  return `${json.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
}

const summarizeValidate = (
  validate: ((value: unknown) => boolean) | undefined,
): string | undefined => {
  if (!validate) return undefined
  const source = validate.toString().replace(/\s+/g, ' ').trim()
  return source.length <= MAX_SUMMARY_LENGTH
    ? source
    : `${source.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
}

export const describeFacets = (runtime: FacetRuntime): FacetSummary[] => {
  const facetIds = runtime.facetIds().sort()
  return facetIds.map(id => {
    const contributions = runtime.contributionsById(id)
    // The facet object lives on every contribution; pick the first to
    // sniff `validate`. All contributions to the same facet share the
    // same Facet instance.
    const validate = summarizeValidate(contributions[0]?.facet.validate)
    return {
      id,
      contributionCount: contributions.length,
      contributions: contributions.map(c => ({
        source: c.source,
        precedence: c.precedence,
        valueSummary: summarizeContributionValue(c.value),
      })),
      ...(validate ? {validate} : {}),
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
    const api = await import('@/extensions/api.js')
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

  const includeDataModel = (filters.guides ?? []).some(
    guide => guide.trim().toLowerCase() === DATA_MODEL_GUIDE_ID,
  )

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
    ...(includeDataModel ? {dataModel: DATA_MODEL_GUIDE} : {}),
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
      storage: {
        principles: authoring.storage.principles,
        patterns: authoring.storage.patterns.map(pattern => ({
          id: pattern.id,
          when: pattern.when,
        })),
      },
    },
    more: [
      {
        need: "Understand the data model (blocks, references, pages vs daily-notes, backlinks vs grouped-backlinks, source_field, done-status, deep-links) before reading or writing a user's data",
        command: 'yarn agent data-model',
      },
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
        need: 'Install compiled declarations for extension authoring, or inspect one module declaration',
        command: 'yarn agent types agent-extensions/kernel-types  # or: yarn agent types --module "@/extensions/api.js"',
      },
      {
        need: 'Bridge clients and pending command queue',
        command: 'yarn agent status',
      },
      {
        need: 'Targeted in-app inspection using the runtime context — but NOT for "what is registered". For actions/facets/renderers/contributions, prefer `describe-runtime`; reaching into `facetRuntime.staticContributionsByFacet` from eval is reading an internal cache with a different shape and will mislead you. Inside the code, `repo`, `db`, `runtime`, `sql`, `block`, `getBlock`, `getSubtree`, `createBlock`, `updateBlock`, `installExtension`, `setExtensionEnabled`, `uninstallExtension`, `actions`, `renderers`, `refreshAppRuntime`, `React`, `ReactDOM`, `window`, `document` are already bound — do not dig into `window.__omniliner`. For structured input, pass `--data <path>` (or `--data-json <inline>`) and read it as `data`.',
        command: 'yarn agent eval <code>  # use `return ...` to print a value; --data <path> binds JSON as `data`',
      },
      {
        need: 'Raw protocol access for uncommon runtime commands',
        command: 'yarn agent raw <json>',
      },
    ],
  }
}
