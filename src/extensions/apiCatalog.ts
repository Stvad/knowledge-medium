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
// DISCOVERY, NOT A FROZEN CONTRACT. Listing a symbol here says "this is what
// an extension should reach for", not "this will never change". Extensions are
// stored in the DB, so no typecheck or repo sweep can find the ones that would
// break — but this project is early and small enough that a break is a fixable
// error while a wrong shape is permanent, so the design wins. `aliases` came
// off `BlockResolveContext` on exactly those grounds after it was found to
// remount the editor on every keystroke (#548 / #553). The obligation that
// comes with it is disclosure, not preservation: say what broke and what an
// extension reading it would see. A warning, not a migration plan — deleting
// is the default. See AGENTS.md ("extension api surface"). None of this
// applies to user DATA.
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
      'blockBulletClassFacet', 'blockBulletHoverFacet', 'blockChildrenFooterFacet',
      'blockClickHandlersFacet',
      'blockContentDecoratorsFacet', 'blockContentRendererFacet', 'blockContentSurfacePropsFacet',
      'blockTextClassFacet',
      'blockHeaderFacet', 'blockLayoutFacet', 'shortcutSurfaceActivationsFacet', 'enterBlockEditMode',
      'getBlockContentRendererSlot', 'isSelectionClick',
    ],
    types: [
      'BlockBulletClassContext', 'BlockBulletClassContribution',
      'BlockBulletHoverContribution', 'BlockChildrenFooterContribution', 'BlockClickContribution',
      'BlockHeaderContribution', 'BlockContentDecorator', 'BlockContentDecoratorContribution',
      'BlockContentRendererContribution', 'BlockContentRendererSlot', 'BlockContentSurfaceContribution',
      'BlockContentSurfaceProps', 'BlockInteractionContext', 'BlockResolveContext', 'BlockLayout',
      'BlockLayoutContribution', 'BlockLayoutSlots', 'BlockShellProps', 'ShortcutActivationContribution',
      'ShortcutSurfaceContext',
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
  {
    category: 'ui',
    importPath: '@/context/backgroundSubtree.js',
    description: 'Mark a subtree BACKGROUND — alive and rendering, but not entitled to claim single-holder app resources (today the keyboard, via declarative shortcut activations). For hosts that keep several layout sessions mounted and show one. NOT a signal to stop working.',
    exports: [
      'BackgroundSubtreeContext', 'BackgroundSubtreeProvider',
      'useIsBackgroundSubtree',
    ],
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
    description: 'System state-block accessors (user, prefs, plugin prefs / UI-state, layout session). layoutSessionBlockIdForKey / layoutSessionsContainerBlockId are the canonical session-key → block-id derivations for out-of-core session hosts — never re-derive the uuid chain.',
    exports: [
      'getLayoutSessionBlock', 'getPluginPrefsBlock', 'getPluginUIStateBlock', 'getUserBlock',
      'getUserPrefsBlock', 'layoutSessionBlockIdForKey', 'layoutSessionsContainerBlockId',
    ],
    types: [],
  },
  {
    category: 'ui',
    importPath: '@/context/layoutWsContext.js',
    description: 'Session-scoped link context. Session hosts MUST wrap each warm session subtree in a LayoutWsContext provider ({workspaceId, wsContext}), or hidden sessions\' anchors carry the active lane.',
    exports: ['LayoutWsContext', 'useAppHashInContext', 'appHashForSession'],
    types: ['LayoutWsContextValue'],
  },
  {
    category: 'data',
    importPath: '@/data/api/index.js',
    description: 'Data-layer public API — property/type authoring (seedType, defineProperty, seedProperty, codecs, ChangeScope). Directory module: import the explicit /index.js.',
    exports: [
      'defineProperty', 'definePropertyEditorOverride', 'seedProperty', 'seedType',
      'codecs', 'ChangeScope', 'INFRASTRUCTURE_TYPE_DISPLAY', 'propertyValue',
    ],
    types: [
      'AnyPropertyAssignment', 'BlockData', 'Codec', 'PropertyAssignment',
      'PropertyEditorOverride', 'PropertyEditorProps', 'PropertyHandle',
      'PropertySeedDeclaration', 'PropertySchema', 'PropertySchemaEntry', 'ResolvedPropertySchema',
      'Tx', 'TypeContribution', 'TypeSeedDeclaration',
    ],
  },
  {
    category: 'data',
    importPath: '@/data/typedRecords.js',
    description: 'createTypedChild — one call per record block (create + type-tag + typed properties inside your tx). The cheap way to keep records as blocks instead of a JSON cell. getOrCreateTypedChild derives the block id from what the record IS, so a create fired by a UI gesture or a bootstrap is idempotent: repeat it and it adopts, and two clients converge on one row instead of leaving a duplicate nobody can reach. It answers `taken` when the id is occupied by something you rejected — a deliberate SECOND record is a lookup plus createTypedChild, never a second derived id. adoptTypedBlock takes the record you found that way, repairing its type tags.',
    // `derivedBlockId` is deliberately absent: it computes an id, which reads
    // like a lookup and isn't — what sits there may be a tombstone, another
    // workspace's row, or a record this caller would reject. Authors get the
    // get-or-create, which tells them which of those it found.
    exports: ['adoptTypedBlock', 'createTypedChild', 'getOrCreateTypedChild'],
    types: ['DerivedChildOutcome', 'DerivedChildSpec', 'DerivedIdentity', 'TypedChildSpec'],
  },
  {
    category: 'data',
    importPath: '@/data/kernelPage.js',
    description: 'getOrCreateKernelPage — the per-workspace singleton PAGE at the workspace root: your plugin\'s "Library" or "Inbox" that everything else files under. One call gets you a deterministic id (so re-installing, or a second device, lands on the same page rather than a duplicate), the alias, the page + marker types, repair when a row has lost one of them, and restore when it was deleted. The marker type is what you query for later — `subscribeBlocks({types: [YOUR_MARKER]})`. Use this for the root; use getOrCreateTypedChild for the records under it. Deriving the id yourself and following it with `repo.load` then `tx.create` is the shape this replaces: the load answers for the moment it ran, so two writers both see nothing and the second one throws.',
    exports: ['getOrCreateKernelPage', 'kernelPageBlockId'],
    types: ['KernelPageSpec'],
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
    description: "Reading a block's types — hasBlockType / getBlockTypes, decoded through the schema rather than off the raw property bag, which is what \"type the blocks you READ too\" needs. Plus system UI-state props (collapsed, show-properties, top-level, focus location) and the atomic focusBlock transition.",
    exports: [
      'hasBlockType', 'getBlockTypes',
      'isCollapsedProp', 'showPropertiesProp', 'topLevelBlockIdProp', 'focusedBlockLocationProp',
      'focusBlock',
    ],
    types: ['FocusedBlockLocation'],
  },
  {
    category: 'data',
    importPath: '@/plugins/todo/schema.js',
    description: 'The built-in todo: type id + its `status` (open|done) property. Compose these onto your own record instead of declaring a private done flag — the block then renders as a checkbox and answers todo queries.',
    exports: ['TODO_TYPE', 'statusProp', 'todoType'],
    types: ['TodoStatus'],
  },
  {
    category: 'data',
    importPath: '@/extensions/pluginIds.js',
    description: 'pluginBlockId — the deterministic id of a plugin-owned block, and ONLY the id. Usually not what you want: an id reads like a lookup and is not, so following it with repo.load + tx.create is exactly the race a derived id exists to remove. Reach for getOrCreateKernelPage (your root page) or getOrCreateTypedChild (the records under it) — they own the create, the adopt and the repair. This is for when you genuinely want the string: checking whether a block is one of yours, or handing a target id to something else.',
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
