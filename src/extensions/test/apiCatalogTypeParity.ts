// Type-side drift guard for `src/extensions/apiCatalog.ts`.
//
// `apiCatalog.test.ts` checks the catalog's RUNTIME `exports` against each
// module at test time (`name in module`). Type-only exports are erased at
// runtime, so that check can't see them — yet the catalog's `types[]` names
// are surfaced by `describe-runtime` / `kmagent` and copied into extension
// examples. Without a guard, renaming/removing a type would leave the catalog
// (and every example) advertising a name that no longer exists, with every
// runtime test still green.
//
// The retired `@/extensions/api.js` barrel got this for free: `export type
// { Facet } from '@/facets/facet.js'` is tsc-checked (TS2305 if the member is
// gone), and the barrel lived in `src/`. This fixture restores exactly that
// guarantee for the type surface — one `export type { … } from '<importPath>'`
// per catalog module that declares types. If a listed type is renamed or
// removed, `tsc -b` (run by `pnpm run check`) fails here. Re-exporting a type
// by name never instantiates it, so this is robust to generic types and is
// fully erased at runtime (zero cost, loads nothing).
//
// The complementary direction — every `types[]` name in the catalog is
// actually covered by THIS file — is asserted in `apiCatalog.test.ts` (it
// reads this file's source and checks each catalog type appears under its
// module). Keep the two in sync: when you add a type to the catalog, add it
// here under the same `importPath`.

export type {
  AppExtension,
  Facet,
  FacetContribution,
  FacetContributionOptions,
  FacetResolveContext,
  FacetRuntime,
  OptionalContributionResult,
} from '@/facets/facet.js'

export type { Togglable } from '@/facets/togglable.js'

export type {
  Variant,
  VariantContribution,
  VariantResolver,
  VariantSelection,
} from '@/facets/variantFacet.js'

export type {
  VerbFacet,
  VerbImpl,
  VerbDecorator,
  VerbBefore,
  VerbAfter,
  VerbOutcome,
} from '@/facets/verbFacet.js'

export type {
  AppEffect,
  AppEffectCleanup,
  AppEffectContext,
  AppMountContribution,
  HeaderItemContribution,
  HeaderItemRegion,
  PanelMountContribution,
  RendererContribution,
} from '@/extensions/core.js'

export type {
  BlockBulletHoverContribution,
  BlockChildrenFooterContribution,
  BlockClickContribution,
  BlockHeaderContribution,
  BlockContentDecorator,
  BlockContentDecoratorContribution,
  BlockContentRendererContribution,
  BlockContentRendererSlot,
  BlockContentSurfaceContribution,
  BlockContentSurfaceProps,
  BlockInteractionContext,
  BlockResolveContext,
  BlockLayout,
  BlockLayoutContribution,
  BlockLayoutSlots,
  BlockShellProps,
  ShortcutActivationContribution,
  ShortcutSurfaceContext,
} from '@/extensions/blockInteraction.js'

export type {
  PasteDecision,
  PasteRequest,
  PasteSurface,
} from '@/paste/decision.js'

export type {
  NavigateInput,
  NavigationDecision,
  ResolvedNavigateInput,
  GlobalCommandNavigateInput,
  NavigationRequest,
  NavigationResult,
  NavigationGesture,
  NavigationRole,
  NavigationViewport,
  BlockOpenerPlainClick,
  BlockOpenerOptions,
  OpenBlockContext,
} from '@/utils/navigation.js'

export type {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  Action,
  ActionTransform,
  ShortcutBinding,
  KeyCombination,
} from '@/shortcuts/types.js'

export type {
  ActionInvocation,
  ActionDispatchDecorator,
  ActionHandlerWrap,
} from '@/shortcuts/actionDispatch.js'

export type {
  BlockData,
  Codec,
  PropertyEditorOverride,
  PropertyEditorProps,
  PropertyHandle,
  PropertySeedDeclaration,
  PropertySchema,
  PropertySchemaEntry,
  ResolvedPropertySchema,
  TypeContribution,
  TypeSeedDeclaration,
} from '@/data/api/index.js'

export type { FocusedBlockLocation } from '@/data/properties.js'

export type {
  BlockRenderer,
  BlockRendererProps,
  BlockContextType,
} from '@/types.js'

export type {
  DiagnosticSnapshot,
  DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'

export type {
  DialogComponent,
  DialogContextProps,
} from '@/utils/dialogs.js'

export type {
  ProgressToast,
  ToastAction,
  ToastOptions,
} from '@/utils/toast.js'
