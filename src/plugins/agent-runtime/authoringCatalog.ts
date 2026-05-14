export type AuthoringCatalogSource = 'curated' | 'html-importmap' | 'html-preload' | 'html-entry'

export interface AuthoringModuleSummary {
  importPath: string
  category: string
  description: string
  exports?: string[]
  source: AuthoringCatalogSource
  safeForExtensions?: boolean
}

export interface AuthoringComponentSummary {
  name: string
  importPath: string
  category: string
  description: string
  exports: string[]
  source: AuthoringCatalogSource
}

export interface AuthoringStoragePattern {
  id: string
  when: string
  use: string
  modules: string[]
}

export interface AuthoringStorageGuide {
  principles: string[]
  patterns: AuthoringStoragePattern[]
  credentials: {
    rule: string
    currentAffordance: string
  }
}

export interface AuthoringGuide {
  id: string
  title: string
  when: string[]
  principles: string[]
  steps: string[]
  preferredModules: string[]
  relatedFacets: string[]
  commands: string[]
}

export interface AuthoringCatalog {
  guides: AuthoringGuide[]
  storage: AuthoringStorageGuide
  modules: AuthoringModuleSummary[]
  components: AuthoringComponentSummary[]
}

export interface AuthoringCatalogFilters {
  guides?: string[]
  modules?: string[]
  components?: string[]
}

interface ApiSurfaceLike {
  module: string
  exports: string[]
}

const curatedModules = (apiSurface: ApiSurfaceLike): AuthoringModuleSummary[] => [
  {
    importPath: '@/extensions/api.js',
    category: 'public-api',
    description: 'Curated extension authoring barrel for facets, actions, data primitives, codecs, block types, and user preference helpers.',
    exports: apiSurface.exports,
    source: 'curated',
    safeForExtensions: true,
  },
  {
    importPath: '@/components/ui/dialog.js',
    category: 'ui-component',
    description: 'Dialog primitives for setup/configuration flows. Prefer this over prompt/alert for plugin setup.',
    exports: [
      'Dialog',
      'DialogContent',
      'DialogDescription',
      'DialogFooter',
      'DialogHeader',
      'DialogTitle',
      'DialogTrigger',
      'DialogClose',
    ],
    source: 'curated',
    safeForExtensions: true,
  },
  {
    importPath: '@/components/ui/button.js',
    category: 'ui-component',
    description: 'System button component for command and dialog actions.',
    exports: ['Button'],
    source: 'curated',
    safeForExtensions: true,
  },
  {
    importPath: '@/components/ui/input.js',
    category: 'ui-component',
    description: 'System input component for short form fields such as tokens, URLs, and labels.',
    exports: ['Input'],
    source: 'curated',
    safeForExtensions: true,
  },
  {
    importPath: '@/components/ui/label.js',
    category: 'ui-component',
    description: 'System label component for accessible form fields.',
    exports: ['Label'],
    source: 'curated',
    safeForExtensions: true,
  },
  {
    importPath: '@/components/ui/checkbox.js',
    category: 'ui-component',
    description: 'System checkbox component for boolean settings.',
    exports: ['Checkbox'],
    source: 'curated',
    safeForExtensions: true,
  },
  {
    importPath: '@/components/ui/textarea.js',
    category: 'ui-component',
    description: 'System textarea component for longer configuration fields.',
    exports: ['Textarea'],
    source: 'curated',
    safeForExtensions: true,
  },
  {
    importPath: '@/data/globalState.js',
    category: 'storage',
    description: 'Block-backed per-user state helpers. Use getUserPrefsBlock for synced user preferences and plugin config pointers.',
    exports: ['getUserBlock', 'getUserPrefsBlock', 'getLayoutSessionBlock'],
    source: 'curated',
    safeForExtensions: true,
  },
  {
    importPath: '@/data/properties.js',
    category: 'storage',
    description: 'Kernel property descriptors such as aliases, types, renderer, and extension lifecycle properties.',
    exports: ['aliasesProp', 'typesProp', 'rendererProp', 'extensionDisabledProp'],
    source: 'curated',
    safeForExtensions: true,
  },
  {
    importPath: '@/components/renderer/DefaultBlockRenderer.js',
    category: 'renderer',
    description: 'Default block chrome. Import directly when a renderer should preserve bullets, children, properties, and edit affordances.',
    exports: ['DefaultBlockRenderer'],
    source: 'curated',
    safeForExtensions: true,
  },
]

const curatedComponents: AuthoringComponentSummary[] = [
  {
    name: 'Dialog setup form',
    importPath: '@/components/ui/dialog.js',
    category: 'dialog',
    description: 'Use Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, and DialogFooter for guided setup flows.',
    exports: ['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'DialogFooter', 'DialogClose'],
    source: 'curated',
  },
  {
    name: 'Token input',
    importPath: '@/components/ui/input.js',
    category: 'form',
    description: 'Use Input with Label inside a dialog for credential setup. Do not ask for tokens through prompt().',
    exports: ['Input'],
    source: 'curated',
  },
  {
    name: 'Action button',
    importPath: '@/components/ui/button.js',
    category: 'form',
    description: 'Use Button for setup, save, cancel, and sync-now actions.',
    exports: ['Button'],
    source: 'curated',
  },
  {
    name: 'Boolean setting',
    importPath: '@/components/ui/checkbox.js',
    category: 'form',
    description: 'Use Checkbox for enabled/disabled flags and binary sync settings.',
    exports: ['Checkbox'],
    source: 'curated',
  },
]

const storageGuide: AuthoringStorageGuide = {
  principles: [
    'Store plugin configuration and sync state in system blocks whenever possible.',
    'Use typed properties with ChangeScope.UserPrefs for per-user preferences and ChangeScope.BlockDefault for workspace/content data.',
    'Use deterministic aliases, types, or external-id properties so sync plugins can upsert instead of duplicating imported data.',
    'Credentials are the exception: keep secrets out of ordinary block content and avoid printing them through bridge results.',
  ],
  patterns: [
    {
      id: 'user-prefs-config',
      when: 'Per-user plugin settings, defaults, and lightweight sync checkpoints.',
      use: 'Import getUserPrefsBlock and define typed properties. Read/write them on the user prefs block with ChangeScope.UserPrefs.',
      modules: ['@/extensions/api.js', '@/data/globalState.js'],
    },
    {
      id: 'workspace-config-block',
      when: 'Workspace-visible plugin configuration or shared sync state.',
      use: 'Create or find a deterministic config block, usually by alias/type, then store config as properties and child blocks.',
      modules: ['@/extensions/api.js'],
    },
    {
      id: 'imported-record-blocks',
      when: 'External records such as Readwise books/highlights that should be queryable and editable as blocks.',
      use: 'Define source-id properties and upsert blocks by source id. Keep imported records idempotent across repeated syncs.',
      modules: ['@/extensions/api.js'],
    },
  ],
  credentials: {
    rule: 'Credential values may be stored outside ordinary blocks until a generic credential store exists; non-secret metadata and checkpoints should still be block-backed.',
    currentAffordance: 'Use a setup dialog to explain where to get the token, then store only non-secret settings/checkpoints in blocks. Do not expose token values in bridge output.',
  },
}

const guides: AuthoringGuide[] = [
  {
    id: 'external-sync-plugin',
    title: 'External Sync Plugin',
    when: ['imports external API data', 'needs setup/config', 'needs manual or scheduled sync'],
    principles: [
      'Use block-backed config and sync checkpoints.',
      'Use a setup dialog instead of prompt/alert.',
      'Keep credentials out of ordinary block content.',
      'Upsert imported content by stable external ids.',
    ],
    steps: [
      'Define typed properties for external ids, source metadata, and sync checkpoints.',
      'Add a setup dialog mounted through appMountsFacet when required configuration is missing.',
      'Add a manual sync action through actionsFacet.',
      'Store non-secret settings and checkpoints on a user prefs or workspace config block.',
      'Upsert imported records as blocks and update existing blocks when the external id is already present.',
      'If background sync is desired, contribute to scheduledTasksFacet and keep runtime state block-backed.',
    ],
    preferredModules: [
      '@/extensions/api.js',
      '@/components/ui/dialog.js',
      '@/components/ui/input.js',
      '@/components/ui/button.js',
      '@/components/ui/label.js',
      '@/data/globalState.js',
    ],
    relatedFacets: ['core.actions', 'core.app-mounts', 'core.scheduled-tasks', 'data.propertySchemas'],
    commands: [
      'yarn agent describe-runtime --guide external-sync-plugin',
      'yarn agent describe-runtime --components dialog,input,button,label',
      'yarn agent describe-runtime --storage',
      'yarn agent install-extension --reload --verify <file> <label>',
    ],
  },
  {
    id: 'settings-dialog',
    title: 'Settings Dialog',
    when: ['needs user setup', 'needs explanatory text', 'needs form controls'],
    principles: [
      'Render setup UI through appMountsFacet or an existing app mount.',
      'Use system dialog and form components.',
      'Persist saved values through block-backed config properties.',
    ],
    steps: [
      'Contribute an app mount that owns open/close state.',
      'Render DialogContent with a clear title, description, fields, and action buttons.',
      'Save values to a user prefs or workspace config block.',
      'Trigger the dialog from an action or when required config is missing.',
    ],
    preferredModules: [
      '@/extensions/api.js',
      '@/components/ui/dialog.js',
      '@/components/ui/input.js',
      '@/components/ui/button.js',
      '@/components/ui/label.js',
    ],
    relatedFacets: ['core.app-mounts', 'core.actions'],
    commands: [
      'yarn agent describe-runtime --components dialog,input,button,label',
      'yarn agent describe-runtime --modules components/ui',
    ],
  },
  {
    id: 'block-backed-config',
    title: 'Block-Backed Config',
    when: ['stores settings', 'stores sync state', 'stores imported metadata'],
    principles: storageGuide.principles,
    steps: [
      'Choose UserPrefs for per-user settings and BlockDefault for shared workspace/content data.',
      'Define properties with explicit codecs.',
      'Store config on a deterministic block or user prefs block.',
      'Store large or user-visible imported data as child/content blocks.',
    ],
    preferredModules: ['@/extensions/api.js', '@/data/globalState.js', '@/data/properties.js'],
    relatedFacets: ['data.propertySchemas', 'data.types'],
    commands: [
      'yarn agent describe-runtime --storage',
      'yarn agent describe-runtime --facets data.propertySchemas',
    ],
  },
  {
    id: 'scheduled-task',
    title: 'Scheduled Task Contribution',
    when: ['background sync', 'periodic refresh', 'cron-like plugin work'],
    principles: [
      'Use scheduledTasksFacet to declare task intent.',
      'Store task enabled state, lastRunAt, cursors, and errors in blocks.',
      'Make the task idempotent because the app may reload while work is pending.',
    ],
    steps: [
      'Contribute a ScheduledTaskContribution with id, description, schedule, and run handler.',
      'Expose a manual action for the same work so users and agents can run it directly.',
      'Record sync checkpoints in block-backed config after successful runs.',
    ],
    preferredModules: ['@/extensions/api.js', '@/data/globalState.js'],
    relatedFacets: ['core.scheduled-tasks', 'core.actions'],
    commands: [
      'yarn agent describe-runtime --scheduled-tasks',
      'yarn agent describe-runtime --facets core.scheduled-tasks',
    ],
  },
]

const normalizeTerms = (filters: string[] | undefined): string[] =>
  (filters ?? [])
    .flatMap(filter => filter.split(','))
    .map(filter => filter.trim().toLowerCase())
    .filter(Boolean)

const matchesTerms = (
  filters: string[] | undefined,
  ...values: Array<string | string[] | undefined>
): boolean => {
  const terms = normalizeTerms(filters)
  if (terms.length === 0) return true

  const haystack = values
    .flatMap(value => Array.isArray(value) ? value : value ? [value] : [])
    .map(value => value.toLowerCase())

  return terms.some(term =>
    haystack.some(value => value === term || value.includes(term)),
  )
}

const categoryForPath = (importPath: string): string => {
  if (importPath.includes('/components/ui/')) return 'ui-component'
  if (importPath.includes('/components/')) return 'component'
  if (importPath.includes('/extensions/')) return 'extension-system'
  if (importPath.includes('/plugins/')) return 'plugin'
  if (importPath.includes('/data/')) return 'data'
  if (importPath.startsWith('react') || importPath.includes('/node_modules/')) return 'external'
  return 'module'
}

const moduleDescriptionForPath = (source: AuthoringCatalogSource): string => {
  if (source === 'html-importmap') return 'Import-map entry visible to dynamic extension modules.'
  if (source === 'html-entry') return 'Module entry script loaded by the current app document.'
  if (source === 'html-preload') return 'Module preload discovered from the current app document.'
  return 'Curated extension authoring module.'
}

const normalizeDocumentModulePath = (raw: string, baseURI: string | undefined): string => {
  try {
    const url = new URL(raw, baseURI || 'http://agent-runtime.local/')
    const pathname = url.pathname
    const srcIndex = pathname.indexOf('/src/')
    if (srcIndex >= 0) return `@/${pathname.slice(srcIndex + '/src/'.length)}`
    const nodeIndex = pathname.indexOf('/node_modules/')
    if (nodeIndex >= 0) return pathname.slice(nodeIndex + 1)
    return pathname || raw
  } catch {
    return raw
  }
}

const importMapModules = (document: Document): AuthoringModuleSummary[] => {
  const modules: AuthoringModuleSummary[] = []
  const scripts = Array.from(document.querySelectorAll('script[type="importmap"]'))

  for (const script of scripts) {
    const text = script.textContent?.trim()
    if (!text) continue

    try {
      const parsed = JSON.parse(text) as {imports?: Record<string, string>}
      for (const [key, value] of Object.entries(parsed.imports ?? {})) {
        modules.push({
          importPath: key,
          category: key.startsWith('@/') || key === '@/' ? 'extension-import-prefix' : 'external',
          description: `${moduleDescriptionForPath('html-importmap')} Target: ${value}`,
          source: 'html-importmap',
          safeForExtensions: key === '@/' || key.startsWith('react'),
        })
      }
    } catch {
      modules.push({
        importPath: '<invalid importmap>',
        category: 'diagnostic',
        description: 'The current document has an importmap script that could not be parsed as JSON.',
        source: 'html-importmap',
      })
    }
  }

  return modules
}

const linkedModules = (
  document: Document,
  selector: string,
  source: AuthoringCatalogSource,
): AuthoringModuleSummary[] =>
  Array.from(document.querySelectorAll(selector))
    .map(element => element.getAttribute('href') ?? element.getAttribute('src') ?? '')
    .filter(Boolean)
    .map(raw => {
      const importPath = normalizeDocumentModulePath(raw, document.baseURI)
      return {
        importPath,
        category: categoryForPath(importPath),
        description: moduleDescriptionForPath(source),
        source,
        safeForExtensions: importPath.startsWith('@/'),
      }
    })

const documentModules = (document: Document | undefined): AuthoringModuleSummary[] => {
  if (!document) return []
  return [
    ...importMapModules(document),
    ...linkedModules(document, 'link[rel="modulepreload"][href]', 'html-preload'),
    ...linkedModules(document, 'script[type="module"][src]', 'html-entry'),
  ]
}

const mergeModules = (modules: AuthoringModuleSummary[]): AuthoringModuleSummary[] => {
  const seen = new Map<string, AuthoringModuleSummary>()
  for (const module of modules) {
    const existing = seen.get(module.importPath)
    if (!existing || existing.source !== 'curated') {
      seen.set(module.importPath, module)
    }
  }
  return [...seen.values()].sort((a, b) => a.importPath.localeCompare(b.importPath))
}

export const describeAuthoringCatalog = (
  apiSurface: ApiSurfaceLike,
  filters: AuthoringCatalogFilters = {},
  document?: Document,
): AuthoringCatalog => {
  const modules = mergeModules([
    ...curatedModules(apiSurface),
    ...documentModules(document),
  ]).filter(module =>
    matchesTerms(filters.modules, module.importPath, module.category, module.description, module.exports),
  )

  const components = curatedComponents.filter(component =>
    matchesTerms(filters.components, component.name, component.importPath, component.category, component.description, component.exports),
  )

  return {
    guides: guides.filter(guide =>
      matchesTerms(filters.guides, guide.id, guide.title, guide.when, guide.relatedFacets),
    ),
    storage: storageGuide,
    modules,
    components,
  }
}
