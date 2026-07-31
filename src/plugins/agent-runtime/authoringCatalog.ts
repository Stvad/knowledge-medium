import { extensionApiCatalog } from '@/extensions/apiCatalog.js'

// Worked examples are REAL SOURCE FILES under ./examples, inlined here as text
// at build time. They used to be arrays of string literals, which nothing
// compiled: nine rounds of review on one PR turned up seven separate bugs
// living inside them (a racy load-then-create upsert, a pinned-id `tx.create`
// that throws on the second sync, a `tx.create` with no `orderKey`, an unused
// import, a facet contribution at module scope that reached no default export,
// top-level calls that ran before the seeds they depend on were registered).
// As files they are in the app tsconfig and the eslint scope, so `pnpm run
// check` fails on a broken example instead of shipping it as guidance.
//
// The whole file text is the example — no slicing, no markers. What the agent
// reads is exactly what compiled.
import userPrefsConfigSource from './examples/userPrefsConfig.ts?raw'
import pluginRootSingletonSource from './examples/pluginRootSingleton.ts?raw'
import settingsPropertyEditorSource from './examples/settingsPropertyEditor.tsx?raw'
import txMutationPrimitivesSource from './examples/txMutationPrimitives.ts?raw'
import localStorageCredentialsSource from './examples/localStorageCredentials.ts?raw'
import settingsDialogSource from './examples/settingsDialog.tsx?raw'
import openDialogPromptSource from './examples/openDialogPrompt.tsx?raw'
import recordGrainSource from './examples/recordGrain.ts?raw'

export type AuthoringCatalogSource =
  | 'curated-api'
  | 'generated-module-glob'
  | 'html-importmap'
  | 'html-preload'
  | 'html-entry'

export interface AuthoringModuleSummary {
  importPath: string
  category: string
  description: string
  exports?: string[]
  /** Type-only exports, for curated-API modules. Surfaced for discovery and
   *  searched by the `--modules <term>` filter so a type-name lookup (e.g.
   *  `PropertyEditorProps`) finds the module that owns it. */
  types?: string[]
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

export interface AuthoringExample {
  label: string
  code: string
}

export interface AuthoringStoragePattern {
  id: string
  when: string
  use: string
  modules: string[]
  example?: AuthoringExample
}

export interface AuthoringStorageGuide {
  principles: string[]
  patterns: AuthoringStoragePattern[]
  credentials: {
    rule: string
    currentAffordance: string
    example?: AuthoringExample
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
  /** Worked code snippets that demonstrate the canonical pattern.
   *  Read these before falling back to copying from another extension —
   *  they are kept in sync with the public API surface. */
  examples?: AuthoringExample[]
  /** Notes the agent should act on *after* `install-extension`
   *  returns. Currently used to call out the disabled-by-default
   *  behaviour for user-installed extensions. */
  afterInstall?: string[]
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
  /** When true, omit modules and components entirely. The
   *  guide-only / `--brief` path uses this to keep the response
   *  small — module/component glob dumps are 150KB of paths the
   *  agent doesn't need while reading a guide. */
  omitDiscoverableModules?: boolean
}

type RuntimeModule = Record<string, unknown>

const internalModuleIndex = import.meta.glob([
  '/src/components/**/*.{ts,tsx}',
  '/src/data/**/*.{ts,tsx}',
  '/src/extensions/**/*.{ts,tsx}',
  '/src/hooks/**/*.{ts,tsx}',
  '/src/markdown/**/*.{ts,tsx}',
  '/src/plugins/**/*.{ts,tsx}',
  '/src/shortcuts/**/*.{ts,tsx}',
  '/src/utils/**/*.{ts,tsx}',
  '!/src/**/*.test.{ts,tsx}',
  '!/src/**/test/**/*.{ts,tsx}',
  // The worked examples are guidance TEXT, already surfaced through
  // `guides[].examples` / `storage.patterns[].example`. They are not modules an
  // extension should import, so they stay out of the discoverable module and
  // component lists.
  '!/src/plugins/agent-runtime/examples/**',
])

/** A worked example: the label the catalog shows, plus the verbatim text of
 *  the compiled source file behind it. */
const example = (label: string, source: string): AuthoringExample =>
  ({label, code: source.trimEnd()})

const eagerUiModules = import.meta.glob('/src/components/ui/*.{ts,tsx}', {
  eager: true,
}) as Record<string, RuntimeModule>

const storageGuide: AuthoringStorageGuide = {
  principles: [
    'Store plugin configuration and sync state in system blocks whenever possible.',
    'Use typed properties with ChangeScope.UserPrefs for per-user preferences and ChangeScope.BlockDefault for workspace/content data.',
    'Use `pluginBlockId(workspaceId, NAMESPACE, key)` for plugin-owned singleton blocks so upserts are idempotent across reinstalls.',
    'Use deterministic external-id properties on imported records so sync plugins can upsert instead of duplicating data.',
    'Keep credentials in `window.localStorage`, scoped under a `knowledge-medium:<plugin>:...` key. Never echo token values through bridge output.',
  ],
  patterns: [
    {
      id: 'user-prefs-config',
      when: 'Per-user plugin settings, defaults, and lightweight sync checkpoints.',
      use: 'Define a seeded block type for the plugin via `seedType({seedKey: extensionTypeSeedKey(\'prefs\'), revision: 1, id, label, properties})` and register it through `typeSeedsFacet`. Then read/write the per-plugin sub-block via `getPluginPrefsBlock(repo, workspaceId, user, type)`. Each plugin gets its own row under user-prefs, so unrelated plugins\' settings can\'t clobber each other.',
      modules: ['@/data/api/index.js', '@/data/facets.js', '@/extensions/dynamicExtensionSeeds.js', '@/data/stateBlocks.js'],
      example: example(
        'Define a prefs type and read/write a setting',
        userPrefsConfigSource,
      ),
    },
    {
      id: 'plugin-root-singleton',
      when: 'The plugin needs a stable workspace-scoped root block — e.g. a "Readwise Library" page that all imported books/highlights live under.',
      use: 'Hardcode a UUID v4 once as your plugin\'s namespace constant, then derive every plugin-owned id with `pluginBlockId(workspaceId, NAMESPACE, key)` — same inputs, same id, so a re-install or a fresh device lands on the same block. Same helper for per-record ids, with a key like `book:${externalId}`. Write through `createOrRestoreTargetBlock`; see the example for the two upsert shapes that look right and are not.',
      modules: ['@/data/api/index.js', '@/data/orderKey.js', '@/data/properties.js', '@/data/targets.js', '@/extensions/pluginIds.js'],
      example: example(
        'Deterministic id for a plugin root block',
        pluginRootSingletonSource,
      ),
    },
    {
      id: 'workspace-config-block',
      when: 'Workspace-visible plugin configuration or shared sync state.',
      use: 'Use a deterministic id (see `plugin-root-singleton`) for a config block, then store config as properties and child blocks. Prefer this over user-prefs when the config should sync across all of the user\'s devices and be visible to other workspace members.',
      modules: ['@/data/api/index.js', '@/extensions/pluginIds.js'],
    },
    {
      id: 'settings-via-property-editor-override',
      when: 'Settings / configuration UI for a plugin — what a user sees when they want to change how the plugin behaves. Preferred over a modal dialog: configuration belongs *with* the block whose properties it edits, syncs naturally, and is browsable / scriptable like any other block.',
      use: 'Define a custom property editor with `definePropertyEditorOverride(propHandle, {label, Editor})` (pass the seed handle it presents) and register it via `propertyEditorOverridesFacet`. The Editor receives `PropertyEditorProps<T>` (`value`, `onChange`, `block`, `schema`). To "open settings" from the command palette or a header item, navigate to the prefs block with `navigate(repo, {target: \'new-panel\', blockId: prefsBlock.id, workspaceId})` — the property panel renders your custom Editor inline. Reserve modal dialogs for *interactive* flows (search, picker) — see the settings-dialog guide.',
      modules: [
        '@/extensions/core.js', '@/shortcuts/types.js', '@/data/api/index.js',
        '@/data/facets.js', '@/extensions/dynamicExtensionSeeds.js',
        '@/data/stateBlocks.js', '@/data/properties.js', '@/utils/navigation.js',
      ],
      example: example(
        'Custom settings UI as a property-editor override on the prefs block',
        settingsPropertyEditorSource,
      ),
    },
    {
      id: 'imported-record-blocks',
      when: 'External records such as Readwise books/highlights that should be queryable and editable as blocks.',
      use: 'Declare source-id properties as seeds (`seedProperty` + `definitionSeedsFacet`) — a bare key in the raw `properties` object has no codec and `audit-extension` flags it. Derive each record\'s block id from its external id with `pluginBlockId`, write through `createOrRestoreTargetBlock`, and re-write the source-owned fields on EVERY outcome so a re-sync updates rather than keeping stale data.',
      modules: ['@/data/api/index.js', '@/data/facets.js', '@/data/orderKey.js', '@/data/targets.js', '@/extensions/dynamicExtensionSeeds.js', '@/extensions/pluginIds.js'],
      example: example(
        'Tx mutation primitives — create/read/update inside a transaction',
        txMutationPrimitivesSource,
      ),
    },
  ],
  credentials: {
    rule: 'Store credentials in `window.localStorage` under a `knowledge-medium:<plugin>:token:v1`-style key. Block-backed storage isn\'t appropriate for secrets because PowerSync ships block content to the server.',
    currentAffordance: 'Render a setup Dialog that links to the provider\'s token page, validate the token against the provider\'s auth endpoint before saving, then write it to localStorage. Never include token values in action return payloads or bridge eval output.',
    example: example('localStorage credential read/write', localStorageCredentialsSource),
  },
}

const settingsDialogExample = example(
  'Setup dialog mounted via appMountsFacet; visibility is a typed module store flipped by an action',
  settingsDialogSource,
)

const openDialogExample = example(
  'Simpler alternative: imperative `openDialog` from an action handler',
  openDialogPromptSource,
)

const guides: AuthoringGuide[] = [
  {
    id: 'external-sync-plugin',
    title: 'External Sync Plugin',
    when: ['imports external API data', 'needs setup/config', 'needs manual sync'],
    principles: [
      'Use block-backed config and sync checkpoints.',
      'Use a Dialog mounted through appMountsFacet for setup — never window.prompt/alert/confirm.',
      'Store credentials in window.localStorage; everything else (settings, checkpoints, imported data) lives in blocks.',
      'Use stable external ids on imported records, or derive their block ids deterministically with uuidv5, so re-syncs upsert instead of duplicating.',
    ],
    steps: [
      'Define typed properties for external ids and source metadata via `seedProperty` + `definitionSeedsFacet`. Persist sync checkpoints on a `getPluginPrefsBlock` sub-block, not localStorage.',
      'Render a Dialog component, mount it via `appMountsFacet`, and drive its open/closed state from a small typed module store the component reads with `useSyncExternalStore`. The configure action flips that store directly — never a `window` CustomEvent. Validate credentials against the provider\'s auth endpoint before saving. (For one-shot prompts, `openDialog(Component)` is the simpler imperative alternative — see the settings-dialog guide.)',
      'Add a manual sync action through `actionsFacet`. The handler reads the checkpoint from the prefs block, fetches incremental updates, and runs a single `repo.tx`. Wrap the body in `showProgress(...)` so the user sees per-page / per-book progress and a final summary.',
      'Anchor imported content under a plugin-owned root block whose id is `pluginBlockId(workspaceId, NAMESPACE, "library-root")` — see the `plugin-root-singleton` storage pattern.',
      'Upsert child records the same way: derive the block id from the external id, or look up by an external-id property. Never create a second block for the same external record.',
      'For *background* sync (poll a webhook / poll on an interval) use `appEffectsFacet.of({id, start: ({repo}) => { ... return cleanup })`. Manual sync via an action is enough for most plugins — only reach for an effect when the data source itself pushes. The effect object must be a STABLE reference: define it once at module scope (not inline in a function-valued extension), and export your extension as an array, not a function — a fresh `{id, start}` every resolve reads as "code changed" and silently restarts the effect (dropping its connection / interval) on every unrelated extension toggle.',
    ],
    preferredModules: [
      '@/extensions/core.js',
      '@/shortcuts/types.js',
      // Data primitives the steps require (seedProperty, definitionSeedsFacet,
      // getPluginPrefsBlock, pluginBlockId, extensionPropertySeedKey). In brief
      // mode preferredModules is the ONLY module hint, so these must be here.
      '@/data/api/index.js',
      '@/data/facets.js',
      '@/data/stateBlocks.js',
      '@/extensions/dynamicExtensionSeeds.js',
      '@/extensions/pluginIds.js',
      '@/data/targets.js',
      '@/context/repo.js',
      '@/utils/dialogs.js',
      '@/extensions/dialogAppMount.js',
      '@/utils/toggleStore.js',
      '@/utils/toast.js',
      '@/components/ui/dialog.js',
      '@/components/ui/input.js',
      '@/components/ui/button.js',
      '@/components/ui/label.js',
    ],
    relatedFacets: ['core.actions', 'core.app-mounts', 'core.app-effects', 'data.definition-seeds', 'data.types'],
    commands: [
      'pnpm agent describe-runtime --guide external-sync-plugin --storage',
      'pnpm agent describe-runtime --components dialog,input,button,label',
      // Writes compiled declarations for the app's vendored `@/...`
      // modules, so TS-aware editors resolve extension imports with
      // the same signatures the app build checks.
      'pnpm agent types agent-extensions/kernel-types',
      'pnpm agent types --module "@/data/api/index.js"',
      // Convention: extension source files live under `agent-extensions/`
      // at the repo root. The matrix-chat-client + canvas-layout
      // extensions are there as references.
      'pnpm agent install-extension --verify [--description "<text>"] agent-extensions/<plugin>.js <label>',
      'pnpm agent enable-extension <label>',
      'pnpm agent uninstall-extension <label>',
    ],
    afterInstall: [
      'User-installed extensions are disabled by default (`userExtensionToggle` sets `defaultEnabled: false`). After install, run `pnpm agent enable-extension <label>` (or `<id>`) before its actions show up in `pnpm agent run-action`.',
      'enable-extension does two things (issue #67): it sets the synced "enabled" intent AND grants THIS device a trust approval pinned to the current source hash. A block runs only with both — so enabling on the bridge runs it on the bridge.',
      'After you EDIT an extension (install-extension onto the same block, or hand-edit the source), re-run `pnpm agent enable-extension <label>` to re-pin the new source on this device. Until you do, the device keeps running the PREVIOUSLY approved version and the settings UI shows "Update available" — the live source is never auto-executed.',
      'disable-extension / a source change do NOT stop a running extension by themselves: disable only clears intent (the trust grant persists for a frictionless re-enable), and a drifted source keeps running the pinned version. uninstall-extension deletes the block and revokes the device trust.',
      'Do not retry `install-extension` if the action is "not found" — the install succeeded; the toggle/approval is just off. Run enable-extension.',
      'Pass `--verify` to `install-extension` to see the facets/actions the extension contributed without enabling/approving it (verify compiles the live source in isolation for diagnostics only).',
    ],
    examples: [
      settingsDialogExample,
      openDialogExample,
    ],
  },
  {
    id: 'settings-dialog',
    title: 'Settings Dialog',
    when: ['needs user setup', 'needs explanatory text', 'needs form controls'],
    principles: [
      'For *configuration* UI, prefer the `settings-via-property-editor-override` storage pattern: register a `definePropertyEditorOverride` and navigate to the prefs block. The property panel renders your editor inline — settings live with the block they edit, sync naturally, and are scriptable like any other block. Modal dialogs are right for interactive flows (search, picker, credential setup) — they\'re wrong as the default for "user changes how the plugin behaves".',
      'Two equally-valid dialog shapes: (a) appMountsFacet + a typed module store the component reads via `useSyncExternalStore`, flipped by an action, for a persistent mount that can react to live state; (b) imperative `openDialog(Component, props)` from an action handler when you just need a one-shot prompt that returns a value. Never route dialog open/toggle through a `window` CustomEvent — that bypasses the typed action and dialog channels.',
      'Access the live Repo from inside a Dialog component with `useRepo()`. Action handlers receive it as `uiStateBlock.repo`.',
      'Use system dialog and form components (`Dialog`, `Input`, `Button`, `Label`) — they already match the app theme.',
      'Use `showError` / `showSuccess` / `showProgress` for feedback. Never `window.alert` / `window.confirm` / `window.prompt`.',
      'Validate credentials against the provider\'s auth endpoint before persisting.',
    ],
    steps: [
      'Check first whether this is *configuration*. If so, use the `settings-via-property-editor-override` pattern instead — modal dialog is the wrong shape for configuration.',
      'For a non-configuration flow, pick the shape: (a) appMountsFacet + a typed module store read via `useSyncExternalStore` (flipped by an action) if the dialog will live across the session and react to live state; (b) `openDialog(Component)` from the action handler when "open it, get a value, close it" is all you need.',
      'Build the dialog with `Dialog` + `DialogContent` + form controls. Access repo via `useRepo()` (mount-style) or via the action handler\'s `uiStateBlock.repo` before calling `openDialog`.',
      'Report progress / outcome via `showProgress` / `showSuccess` / `showError`.',
      'Save non-secret values via `getPluginPrefsBlock`; save credentials to `localStorage`.',
    ],
    preferredModules: [
      '@/extensions/core.js',
      '@/shortcuts/types.js',
      // The property-editor-override path + saving non-secret settings need
      // these (definePropertyEditorOverride, propertyEditorOverridesFacet,
      // getPluginPrefsBlock); brief mode surfaces only preferredModules.
      '@/data/api/index.js',
      '@/data/facets.js',
      '@/data/stateBlocks.js',
      '@/context/repo.js',
      '@/utils/dialogs.js',
      '@/extensions/dialogAppMount.js',
      '@/utils/toggleStore.js',
      '@/utils/toast.js',
      '@/components/ui/dialog.js',
      '@/components/ui/input.js',
      '@/components/ui/button.js',
      '@/components/ui/label.js',
    ],
    relatedFacets: ['core.app-mounts', 'core.actions'],
    commands: [
      'pnpm agent describe-runtime --components dialog,input,button,label',
      'pnpm agent describe-runtime --modules components/ui',
      'pnpm agent types agent-extensions/kernel-types',
      'pnpm agent types --module "@/components/ui/dialog.js"',
    ],
    examples: [
      settingsDialogExample,
      openDialogExample,
    ],
  },
  {
    id: 'block-backed-config',
    title: 'Block-Backed Config',
    when: ['stores settings', 'stores sync state', 'stores imported metadata'],
    principles: storageGuide.principles,
    steps: [
      'Choose UserPrefs for per-user settings and BlockDefault for shared workspace/content data.',
      'Define properties with stable seed keys and value presets, then register them through `definitionSeedsFacet`.',
      'For per-plugin sub-blocks under user-prefs, define a seeded block type via `seedType({seedKey: extensionTypeSeedKey(key), revision, id, label, properties})` and read/write via `getPluginPrefsBlock(repo, workspaceId, user, type)`.',
      'For plugin-owned singleton blocks (e.g. import roots), derive the id deterministically via `pluginBlockId(workspaceId, NS, key)` so re-installs land on the same block.',
      'Store large or user-visible imported data as child/content blocks.',
    ],
    preferredModules: [
      '@/data/api/index.js',
      '@/data/facets.js',
      '@/extensions/dynamicExtensionSeeds.js',
      '@/data/stateBlocks.js',
      '@/extensions/pluginIds.js',
    ],
    relatedFacets: ['data.definition-seeds', 'data.types'],
    commands: [
      'pnpm agent describe-runtime --storage',
      'pnpm agent describe-runtime --facets data.definition-seeds',
      'pnpm agent types agent-extensions/kernel-types',
      'pnpm agent types --module "@/data/api/index.js"',
    ],
    examples: [
      storageGuide.patterns.find(p => p.id === 'user-prefs-config')!.example!,
      storageGuide.patterns.find(p => p.id === 'plugin-root-singleton')!.example!,
    ],
  },
  {
    id: 'record-grain',
    title: 'Record Grain — what becomes a block, what becomes a property',
    when: [
      'designs a data model',
      'stores records, entries, logs, or history',
      'points at another block',
      'declares types or properties',
      'wonders whether to reuse an existing type',
    ],
    principles: [
      'A block is the unit of everything this app gives you for free: SQL queries, references and backlinks, undo, sync, hand-editing in the outline, rendering. Anything you would want to see, link to, undo, or edit on its own is its own block — not a row inside a JSON cell.',
      'Properties hold the scalar facts ABOUT a block. A property whose value is a list of records is a cell nothing can see into: not queryable, not referenceable, and clobbered wholesale by a concurrent write.',
      'Anything that points at another block is a `ref` / `optional-ref` / `refList` property with `config: {targetTypes: [...]}` — never a bare id string, never a name. Refs project into real references, so the target\'s backlinks answer "what points at me", and the link survives renaming or moving the target.',
      'Identity is a block id; a name is a label the user will change. Never join records on a name.',
      'Compose before inventing. If a concept already has a type (todo, page, daily note), add that type to your block alongside your own instead of re-declaring its fields.',
      'Type ids and property names are global. Prefix both with your extension (`myext-set`, `myext:weight`); a bare noun collides with whatever else claims it, and the loser silently gets the other schema.',
      'Type the blocks you READ too, not just the ones you write. A typed block in the user\'s own notes gets property editors, and lets your parser read a declaration instead of guessing at prose.',
      'The test for a good record: uninstall the extension, and the data still reads as a sensible outline.',
    ],
    steps: [
      'Sketch the tree first: which block is the parent, what is one record, what hangs off it. One record per block, ordered by `order_key` under its parent.',
      'Declare a namespaced type per record kind (`seedType`) and namespaced properties (`seedProperty`), registered through `typeSeedsFacet` / `definitionSeedsFacet`.',
      'Pick presets by meaning: scalars (`number`, `string`, `date`, `strict-enum`), pointers (`ref` / `optional-ref` / `refList` with `targetTypes`), scalar lists (`string-list`). Reach for `json` only for an opaque config object you will never query into.',
      'Write records with `createTypedChild(repo, tx, {...})` — create, type-tag, and typed properties in one call inside your transaction.',
      'Compose built-ins by listing them in `types`: `[MY_TYPE, TODO_TYPE]` plus the todo `statusProp` gives a real checkbox instead of a private done flag.',
      'Read back with a typed block query over your type id, and let backlinks answer the reverse direction instead of maintaining your own index.',
      'After installing, run `kmagent audit-extension <label>`: it reads the blocks you actually wrote and flags block ids parked in string properties, records buried in JSON, and properties written with no registered schema. (Inside the app repo the same CLI is `pnpm agent …`.)',
    ],
    preferredModules: [
      '@/data/typedRecords.js',
      '@/data/api/index.js',
      '@/data/facets.js',
      '@/extensions/dynamicExtensionSeeds.js',
      '@/plugins/todo/schema.js',
      '@/data/orderKey.js',
    ],
    relatedFacets: ['data.definition-seeds', 'data.types'],
    commands: [
      'kmagent new-extension "<Name>"',
      'kmagent data-model',
      'kmagent describe-runtime --guide record-grain',
      'kmagent audit-extension <label>',
      'kmagent backlinks <blockId>',
    ],
    examples: [
      example(
        'A record per block: typed, composed with todo, linked back to its definition',
        recordGrainSource,
      ),
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

const sourcePriority = (source: AuthoringCatalogSource): number => {
  if (source === 'curated-api') return 4
  if (source === 'generated-module-glob') return 3
  if (source === 'html-entry') return 2
  if (source === 'html-preload') return 1
  return 0
}

const stripExtension = (path: string): string =>
  path.replace(/\.(ts|tsx|js|jsx|mjs)$/, '')

const toImportPath = (path: string): string =>
  stripExtension(path)
    .replace(/^\/src\//, '@/')
    .replace(/^src\//, '@/')
    .replace(/$/, '.js')

const basename = (path: string): string =>
  stripExtension(path).split('/').at(-1) ?? path

const categoryForPath = (importPath: string): string => {
  if (importPath.includes('/components/ui/')) return 'ui-component'
  if (importPath.includes('/components/')) return 'component'
  if (importPath.includes('/extensions/')) return 'extension-system'
  if (importPath.includes('/plugins/')) return 'plugin'
  if (importPath.includes('/data/')) return 'data'
  if (importPath.startsWith('react') || importPath.includes('/node_modules/')) return 'external'
  return 'module'
}

const generatedDescription = (exports: string[] | undefined): string => {
  if (exports && exports.length > 0) {
    return `Generated from the module graph; runtime exports: ${exports.slice(0, 8).join(', ')}.`
  }
  return 'Generated from the module graph; export names are not loaded for this module.'
}

const moduleDescriptionForPath = (source: AuthoringCatalogSource): string => {
  if (source === 'html-importmap') return 'Import-map entry visible to dynamic extension modules.'
  if (source === 'html-entry') return 'Module entry script loaded by the current app document.'
  if (source === 'html-preload') return 'Module preload discovered from the current app document.'
  return 'Generated from the module graph.'
}

const exportNames = (module: RuntimeModule | undefined): string[] | undefined => {
  if (!module) return undefined
  return Object.keys(module).sort()
}

const eagerUiExportMap = (): Map<string, string[]> => {
  const map = new Map<string, string[]>()
  for (const [path, module] of Object.entries(eagerUiModules)) {
    map.set(toImportPath(path), exportNames(module) ?? [])
  }
  return map
}

// The curated public extension API (`apiCatalog.ts`) surfaced as authoring
// modules: real importPath, curated category + description, and the blessed
// runtime export names. These outrank the raw module-glob entries (see
// `sourcePriority`), so where both describe the same path the curated
// description/category wins on merge; curated-only paths (`@/facets/*`,
// `@/context/*`, `@/paste/*`, `@/types.js`) are added outright.
const curatedApiModules = (): AuthoringModuleSummary[] =>
  extensionApiCatalog.map(group => ({
    importPath: group.importPath,
    category: group.category,
    description: group.description,
    ...(group.exports.length > 0 ? {exports: group.exports} : {}),
    ...(group.types.length > 0 ? {types: group.types} : {}),
    source: 'curated-api',
    safeForExtensions: true,
  } satisfies AuthoringModuleSummary))

const generatedModules = (): AuthoringModuleSummary[] => {
  const eagerExports = eagerUiExportMap()
  const globModules = Object.keys(internalModuleIndex).map(path => {
    const importPath = toImportPath(path)
    const exports = eagerExports.get(importPath)
    return {
      importPath,
      category: categoryForPath(importPath),
      description: generatedDescription(exports),
      ...(exports ? {exports} : {}),
      source: 'generated-module-glob',
      safeForExtensions: true,
    } satisfies AuthoringModuleSummary
  })
  return [...globModules, ...curatedApiModules()]
}

const isComponentExport = (name: string): boolean =>
  /^[A-Z]/.test(name)

const generatedComponents = (): AuthoringComponentSummary[] => {
  const out: AuthoringComponentSummary[] = []
  const seen = new Set<string>()

  const push = (component: AuthoringComponentSummary) => {
    const key = `${component.importPath}:${component.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(component)
  }

  for (const [path, module] of Object.entries(eagerUiModules)) {
    const importPath = toImportPath(path)
    for (const name of exportNames(module)?.filter(isComponentExport) ?? []) {
      push({
        name,
        importPath,
        category: categoryForPath(importPath),
        description: `Generated from runtime export ${name}.`,
        exports: [name],
        source: 'generated-module-glob',
      })
    }
  }

  for (const path of Object.keys(internalModuleIndex)) {
    if (!path.endsWith('.tsx')) continue
    const name = basename(path)
    if (!isComponentExport(name)) continue
    const importPath = toImportPath(path)
    push({
      name,
      importPath,
      category: categoryForPath(importPath),
      description: `Inferred from component module ${importPath}.`,
      exports: [name],
      source: 'generated-module-glob',
    })
  }

  return out.sort((a, b) =>
    a.importPath.localeCompare(b.importPath) || a.name.localeCompare(b.name),
  )
}

const normalizeDocumentModulePath = (raw: string, baseURI: string | undefined): string => {
  try {
    const url = new URL(raw, baseURI || 'http://agent-runtime.local/')
    const pathname = url.pathname
    const srcIndex = pathname.indexOf('/src/')
    if (srcIndex >= 0) return `@/${stripExtension(pathname.slice(srcIndex + '/src/'.length))}.js`
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
    if (!existing || sourcePriority(module.source) > sourcePriority(existing.source)) {
      seen.set(module.importPath, module)
    }
  }
  return [...seen.values()].sort((a, b) => a.importPath.localeCompare(b.importPath))
}

export const describeAuthoringCatalog = (
  filters: AuthoringCatalogFilters = {},
  document?: Document,
): AuthoringCatalog => {
  const modules = filters.omitDiscoverableModules
    ? []
    : mergeModules([
      ...generatedModules(),
      ...documentModules(document),
    ]).filter(module =>
      matchesTerms(filters.modules, module.importPath, module.category, module.description, module.exports, module.types),
    )

  const components = filters.omitDiscoverableModules
    ? []
    : generatedComponents().filter(component =>
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
