// Structured discovery catalog for the extension-authoring API.
//
// This REPLACES the old `@/extensions/api.js` re-export barrel. Extensions
// now import directly from the real module that owns a symbol — the import
// graph stays honest (a plugin that wants `actionsFacet` no longer drags in
// navigation, paste, toast, and order-key code) and the module structure is
// preserved instead of flattened into one giant list.
//
// This module is DATA, not a re-export surface: it lists, per real module,
// which symbols are blessed for extension use plus a one-line purpose. It is
// intentionally cheap — it imports none of the modules it describes, so
// loading the catalog never pulls the whole app surface into memory (the
// barrel had to, just to compute `Object.keys`).
//
// It powers discovery: `describe-runtime` / `runtime-summary` surface it as
// the `apiSurface`, and the authoring catalog folds these entries into its
// module list (real category + description + curated exports). It is also the
// drift-guard anchor:
//   - `apiCatalog.test.ts` loads each `importPath` and asserts every runtime
//     `exports` name actually exists on it.
//   - the example drift guard checks that every `@/…` named import in a
//     catalog/example snippet is a symbol this catalog lists for that path.
//
// IMPORT-PATH CONVENTION (matters — blob extensions resolve `@/…` through the
// page importmap + service worker, which serves EXACT emitted filenames):
//   - single-file module  → `@/dir/name.js`      (e.g. `@/facets/facet.js`)
//   - directory-index      → `@/dir/name/index.js` (e.g. `@/data/api/index.js`)
// `@/data/api` is the data layer's own stable public barrel (a directory), so
// extensions must write its explicit `/index.js` form; every other entry here
// is a single file.

export interface ApiModuleGroup {
  /** Coarse grouping for discovery display (facets, data, ui, navigation, …). */
  category: string
  /** The real, import-resolvable module specifier an extension writes. */
  importPath: string
  /** One-line purpose — the human-readable "what is this for". */
  description: string
  /**
   * Runtime value exports blessed for extension use. Drift-guarded: each name
   * must exist as a runtime key of the module (see `apiCatalog.test.ts`). A
   * curated SUBSET — the module may export more; the catalog lists what
   * extensions are encouraged to rely on.
   */
  exports: string[]
  /**
   * Type-only exports, listed for discovery ("where does `PropertyEditorProps`
   * live?"). Not runtime-checkable via `Object.keys`; authoritative signatures
   * come from `kmagent types --module <importPath>`.
   */
  types: string[]
}

export const extensionApiCatalog: ApiModuleGroup[] = [
  // --- Facet primitives -----------------------------------------------------
  {
    category: 'facets',
    importPath: '@/facets/facet.js',
    description: 'Facet primitives — define a contribution point and resolve contributions.',
    exports: ['defineFacet', 'isFunction', 'combineLastContributionResult', 'resolveLastContributionResult'],
    types: [
      'AppExtension', 'Facet', 'FacetContribution', 'FacetContributionOptions',
      'FacetResolveContext', 'FacetRuntime', 'OptionalContributionResult',
    ],
  },
  {
    category: 'facets',
    importPath: '@/facets/togglable.js',
    description: 'Runtime toggle type used by variant facets (full surface lives in this module).',
    exports: [],
    types: ['Togglable'],
  },
  {
    category: 'facets',
    importPath: '@/facets/variantFacet.js',
    description: 'Variant facet helper — runtime-selectable facet variants.',
    exports: ['defineVariantFacet', 'defineVariant'],
    types: ['Variant', 'VariantContribution', 'VariantResolver', 'VariantSelection'],
  },
  {
    category: 'facets',
    importPath: '@/facets/verbFacet.js',
    description: 'Verb facet helper — observe / wrap / replace a single typed verb.',
    exports: ['defineVerbFacet'],
    types: ['VerbFacet', 'VerbImpl', 'VerbDecorator', 'VerbBefore', 'VerbAfter', 'VerbOutcome'],
  },

  // --- Blessed core facets --------------------------------------------------
  {
    category: 'core-facets',
    importPath: '@/extensions/core.js',
    description: 'Blessed core facets — actions, effects, mounts, renderers, header/panel items.',
    exports: [
      'actionTransformsFacet', 'actionsFacet', 'actionContextsFacet', 'appEffectsFacet',
      'appMountsFacet', 'blockRenderersFacet', 'createRendererRegistry', 'headerItemsFacet',
      'panelMountsFacet',
    ],
    types: [
      'AppEffect', 'AppEffectCleanup', 'AppEffectContext', 'AppMountContribution',
      'HeaderItemContribution', 'HeaderItemRegion', 'PanelMountContribution', 'RendererContribution',
    ],
  },
  {
    category: 'block-interaction',
    importPath: '@/extensions/blockInteraction.js',
    description: 'Block-interaction facets — click handlers, content/layout renderers, shortcut activations.',
    exports: [
      'blockChildrenFooterFacet', 'blockClickHandlersFacet', 'blockContentDecoratorsFacet',
      'blockContentRendererFacet', 'blockContentSurfacePropsFacet', 'blockHeaderFacet',
      'blockLayoutFacet', 'shortcutSurfaceActivationsFacet', 'enterBlockEditMode',
      'getBlockContentRendererSlot', 'isSelectionClick',
    ],
    types: [
      'BlockChildrenFooterContribution', 'BlockClickContribution', 'BlockHeaderContribution',
      'BlockContentDecorator', 'BlockContentDecoratorContribution', 'BlockContentRendererContribution',
      'BlockContentRendererSlot', 'BlockContentSurfaceContribution', 'BlockContentSurfaceProps',
      'BlockInteractionContext', 'BlockResolveContext', 'BlockLayout', 'BlockLayoutContribution',
      'BlockLayoutSlots', 'BlockShellProps', 'ShortcutActivationContribution', 'ShortcutSurfaceContext',
    ],
  },

  // --- Markdown -------------------------------------------------------------
  {
    category: 'markdown',
    importPath: '@/markdown/extensions.js',
    description: 'Markdown rendering pipeline facet.',
    exports: ['markdownExtensionsFacet'],
    types: [],
  },

  // --- Paste seam -----------------------------------------------------------
  {
    category: 'paste',
    importPath: '@/paste/decision.js',
    description: 'Paste decision seam — override how clipboard content lands (outline vs single block).',
    exports: ['pasteDecisionVerb', 'defaultPasteDecision'],
    types: ['PasteDecision', 'PasteRequest', 'PasteSurface'],
  },

  // --- Navigation seams -----------------------------------------------------
  {
    category: 'navigation',
    importPath: '@/utils/navigation.js',
    description: 'Navigation seams — intent policy + execution, plus the hooks/helpers to open blocks.',
    exports: [
      'navigationVerb', 'navigationIntentVerb', 'defaultNavigationIntent', 'goTo', 'PASSTHROUGH',
      'SUPPRESS', 'mapNavigate', 'navigate', 'useNavigate', 'navigateFromGesture',
      'navigateFromGlobalCommand', 'useNavigateFromGlobalCommand', 'useOpenBlock', 'useBlockOpener',
      'applyNavigationDecision',
    ],
    types: [
      'NavigateInput', 'NavigationDecision', 'ResolvedNavigateInput', 'GlobalCommandNavigateInput',
      'NavigationRequest', 'NavigationResult', 'NavigationGesture', 'NavigationRole',
      'NavigationViewport', 'BlockOpenerPlainClick', 'BlockOpenerOptions', 'OpenBlockContext',
    ],
  },

  // --- Actions / shortcuts --------------------------------------------------
  {
    category: 'actions',
    importPath: '@/shortcuts/types.js',
    description: 'Action / shortcut type surface and context-type constants.',
    exports: ['ActionContextTypes'],
    types: [
      'ActionConfig', 'ActionContextConfig', 'ActionContextType', 'Action', 'ActionTransform',
      'ShortcutBinding', 'KeyCombination',
    ],
  },
  {
    category: 'actions',
    importPath: '@/shortcuts/effectiveActions.js',
    description: 'Resolve the effective / active actions at runtime.',
    exports: ['actionRuntimeKey', 'getActiveActionById', 'getEffectiveActions'],
    types: [],
  },
  {
    category: 'actions',
    importPath: '@/shortcuts/actionDispatch.js',
    description: 'Action-dispatch seam — middleware around action invocation (observe / guard / wrap / redirect).',
    exports: ['actionDispatchVerb', 'actionDispatchWrap', 'invokeAction'],
    types: ['ActionInvocation', 'ActionDispatchDecorator', 'ActionHandlerWrap'],
  },
  {
    category: 'actions',
    importPath: '@/shortcuts/blockActions.js',
    description: 'Shared block-action builders and selection helpers.',
    exports: ['bindBlockActionContext', 'createSharedBlockActions', 'extendSelectionDown', 'extendSelectionUp'],
    types: [],
  },

  // --- Data / block primitives ----------------------------------------------
  {
    category: 'data',
    importPath: '@/data/block.js',
    description: 'The Block handle.',
    exports: ['Block'],
    types: [],
  },
  {
    category: 'data',
    importPath: '@/data/repo.js',
    description: 'The Repo — query / tx / mutate over blocks.',
    exports: ['Repo'],
    types: [],
  },
  {
    category: 'data',
    importPath: '@/data/stateBlocks.js',
    description: 'System state-block accessors (user, prefs, plugin prefs / UI-state, layout session).',
    exports: [
      'getLayoutSessionBlock', 'getPluginPrefsBlock', 'getPluginUIStateBlock', 'getUserBlock',
      'getUserPrefsBlock',
    ],
    types: [],
  },
  {
    category: 'data',
    importPath: '@/data/api/index.js',
    description: 'Data-layer public API — property/type authoring (seedType, defineProperty, seedProperty, codecs, ChangeScope). Directory module: import the explicit /index.js.',
    exports: [
      'defineProperty', 'definePropertyEditorOverride', 'seedProperty', 'seedType',
      'codecs', 'ChangeScope', 'INFRASTRUCTURE_TYPE_DISPLAY',
    ],
    types: [
      'BlockData', 'Codec', 'PropertyEditorOverride', 'PropertyEditorProps', 'PropertyHandle',
      'PropertySeedDeclaration', 'PropertySchema', 'PropertySchemaEntry', 'ResolvedPropertySchema',
      'TypeContribution', 'TypeSeedDeclaration',
    ],
  },
  {
    category: 'data',
    importPath: '@/data/facets.js',
    description: 'Data-layer facets — definition seeds, property-editor overrides, block-type seeds.',
    exports: ['definitionSeedsFacet', 'propertyEditorOverridesFacet', 'typeSeedsFacet'],
    types: [],
  },
  {
    category: 'data',
    importPath: '@/extensions/dynamicExtensionSeeds.js',
    description: 'Block-owned seed keys for extension-defined properties (extensionPropertySeedKey) and block types (extensionTypeSeedKey).',
    exports: ['extensionPropertySeedKey', 'extensionTypeSeedKey'],
    types: [],
  },
  {
    category: 'data',
    importPath: '@/data/properties.js',
    description: 'System UI-state props (collapsed, show-properties, top-level, focus location) + the atomic focusBlock transition.',
    exports: [
      'isCollapsedProp', 'showPropertiesProp', 'topLevelBlockIdProp', 'focusedBlockLocationProp',
      'focusBlock',
    ],
    types: ['FocusedBlockLocation'],
  },
  {
    category: 'data',
    importPath: '@/extensions/pluginIds.js',
    description: 'pluginBlockId — deterministic (uuidv5) plugin-owned block ids for idempotent upserts.',
    exports: ['pluginBlockId'],
    types: [],
  },
  {
    category: 'data',
    importPath: '@/data/orderKey.js',
    description: 'Fractional-index order keys for inserting blocks at deterministic positions among siblings.',
    exports: ['keyAtEnd', 'keyAtStart', 'keyBetween', 'keysBetween'],
    types: [],
  },

  // --- Renderer types -------------------------------------------------------
  {
    category: 'renderer',
    importPath: '@/types.js',
    description: 'Block renderer types.',
    exports: [],
    types: ['BlockRenderer', 'BlockRendererProps', 'BlockContextType'],
  },

  // --- Diagnostics ----------------------------------------------------------
  {
    category: 'diagnostics',
    importPath: '@/plugins/diagnostics/facet.js',
    description: 'Diagnostics seam — contribute structured health snapshots to the system-status chip.',
    exports: ['diagnosticsFacet'],
    types: ['DiagnosticSnapshot', 'DiagnosticSourceContribution'],
  },

  // --- React / UI primitives ------------------------------------------------
  {
    category: 'react',
    importPath: '@/context/repo.js',
    description: 'useRepo hook — the live Repo from inside a mounted (appMountsFacet) component.',
    exports: ['useRepo'],
    types: [],
  },
  {
    category: 'ui',
    importPath: '@/utils/dialogs.js',
    description: 'openDialog — imperative dialog primitive; the promise resolves with the user\'s choice (or null on cancel).',
    exports: ['openDialog'],
    types: ['DialogComponent', 'DialogContextProps'],
  },
  {
    category: 'ui',
    importPath: '@/utils/toast.js',
    description: 'Toast / user-feedback primitives — prefer over window.alert / confirm. showProgress returns an updatable handle.',
    exports: ['showError', 'showInfo', 'showSuccess', 'showProgress', 'showCustom', 'dismissToast'],
    types: ['ProgressToast', 'ToastAction', 'ToastOptions'],
  },
]

/** Flattened runtime export names across the whole catalog (used for the
 *  `exportCount` in runtime-summary and for quick membership checks). */
export const extensionApiRuntimeExports = (): string[] =>
  extensionApiCatalog.flatMap(group => group.exports)
