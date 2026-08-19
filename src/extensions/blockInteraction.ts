import { createElement } from 'react'
import type {
  ClipboardEvent,
  ComponentType,
  FocusEvent,
  HTMLAttributes,
  MouseEvent,
  PointerEvent,
  Ref,
  RefObject,
  ReactNode,
  SVGProps,
} from 'react'
import type { EditorView } from '@codemirror/view'
import { Block } from '../data/block'
import {
  editorSelection,
  focusBlock,
  requestEditorFocus,
} from '@/data/properties.js'
import { resetBlockSelection } from '@/data/stateBlocks.js'
import { Repo } from '../data/repo'
import { combineLastContributionResult, defineFacet, isFunction } from '@/facets/facet.js'
import {
  defineVariantFacet,
  type Variant,
  type VariantRegistration,
  type VariantResolver,
} from '@/facets/variantFacet.js'
import type { ActionContextActivation, BlockPointerDependencies } from '@/shortcuts/types.js'
import type { PointerGestureEvent } from '@/shortcuts/pointerAction.js'
import type { BlockContextType, BlockRenderer } from '@/types.js'

export interface BlockContentRendererSlot {
  id: string
  renderer: BlockRenderer
}

/**
 * What is knowable about a block BEFORE a renderer has been chosen for
 * it — the context `blockRendererFacet` registrations resolve against.
 * Narrower than `BlockResolveContext` by necessity: the richer context
 * is built by the chosen renderer and includes slots derived from it
 * (`contentRenderers`), so it cannot exist before the choice is made.
 */
export interface BlockRendererContext {
  block: Block
  repo: Repo
  /** The block's `types` property. Every per-type renderer gate used to
   *  re-derive this from `block.peek()` with its own null handling. */
  types: readonly string[]
  blockContext?: BlockContextType
}

/**
 * Stable per-block input to facet resolvers. Identity changes only on
 * block swap, panel-context change (panelId/safeMode/etc.), or zoom
 * (topLevelBlockId), or the block's type membership. Crucially does
 * NOT include focus / edit mode / selection — those are reactive UI
 * state, and folding them into the resolver context would re-run every
 * facet resolver and reswap every decorator/layout/slot identity on
 * each focus toggle.
 *
 * "Reswap every slot identity" is not a performance note, it is data
 * loss. `DefaultBlockRenderer` builds each layout slot as a `useMemo`
 * over this object, so a new identity is a new React element TYPE:
 * React unmounts the old subtree and mounts a fresh one. For `Content`
 * and `Shell` that subtree is the live CodeMirror editor, and a remount
 * mid-typing rebuilds it from the last COMMITTED content — dropping the
 * characters typed since, killing an open autocomplete, and moving the
 * caret. So a field belongs here only if it is stable across ordinary
 * editing; anything a keystroke can change does not. `aliases` was on
 * this context for exactly one release and broke page-title editing that
 * way: `alias.sync` mirrors a page's content into its own `alias`
 * property in the same tx, so every debounced commit churned it. It is
 * gone rather than narrowed — page-ness reaches the surfaces that style it
 * through `blockTextClassFacet` / `blockBulletClassFacet`, whose calling
 * hooks feed them `useBlockAliases(block)` reactively, and any other
 * contribution that must FOLLOW naming reads the same hook inside its own
 * rendered component.
 *
 * Contributions that need reactive state read it inside their rendered
 * components via `useInFocus(block.id)` / `useInEditMode(block.id)` /
 * `useIsSelected(block.id)`, or at fire time via snapshot helpers. Facets
 * whose contributions are pure functions (no component to hold a hook)
 * declare their own context type and let the calling HOOK feed the
 * reactive read — see `blockTextClassFacet` / `blockBulletClassFacet`,
 * which is how page-ness reaches the alias plugin's styling.
 */
export interface BlockResolveContext extends BlockRendererContext {
  uiStateBlock: Block
  topLevelBlockId?: string
  /** Root of the visible subtree this mount renders (see
   *  `BlockContextType.scopeRootId`). Equals `topLevelBlockId` on the
   *  main outline; differs in nested surfaces (a backlink entry's shown
   *  block, an embedded block). Structural-edit and navigation handlers
   *  consume this as the surface boundary. */
  scopeRootId?: string
  /** Focal-on-document — `block.id === topLevelBlockId` AND the current
   *  mount is the document surface (not an embed, backlink entry, or
   *  breadcrumb preview). Populated by `useIsFocalRender(block)`; the
   *  pure helper `isFocalRender(ctx)` answers the same question for
   *  facet contributions that receive a `BlockResolveContext`. */
  isTopLevel: boolean
  contentRenderers?: readonly BlockContentRendererSlot[]
}

/**
 * Full interaction context — resolver context plus the reactive UI
 * state. Consumed only by `shortcutSurfaceActivationsFacet`, whose
 * activations legitimately re-evaluate on every reactive change to
 * scope which shortcut contexts are active. Other facets take
 * `BlockResolveContext` and read reactive state inside their rendered
 * components / fire-time handlers via hooks.
 */
export interface BlockInteractionContext extends BlockResolveContext {
  inFocus: boolean
  inEditMode: boolean
  isSelected: boolean
}

export interface EditorActivationSelection {
  x?: number
  y?: number
  start?: number
  end?: number
}

export type BlockMouseHandler = (event: MouseEvent) => void | Promise<void>

export type BlockContentRendererVariant = Variant<BlockRenderer>

// Variant facet — each contribution registers a named alternative
// content renderer. Most contributions self-gate (e.g. plain-outliner's
// edit-mode dispatcher returns its variant only when the primary slot
// is set), and the consumer picks `last` to preserve the legacy "last
// truthy contribution wins" behavior. Adding a user-facing picker
// later means reading a saved id and calling `byId` instead.
export type BlockContentRendererRegistration =
  VariantRegistration<BlockResolveContext, BlockRenderer>

export type BlockContentRendererResolver =
  VariantResolver<BlockResolveContext, BlockRenderer>

export type BlockContentDecorator =
  (innerRenderer: BlockRenderer) => BlockRenderer

/** Build a content decorator that renders `Wrapper` around each inner
 *  renderer. The per-inner cache is correctness, not a perf nicety:
 *  decorators resolve during render, and a fresh component identity on
 *  every pass would remount the block's whole content subtree. */
export const cachedContentDecorator = (
  Wrapper: ComponentType<{block: Block, Inner: BlockRenderer}>,
  displayName: string,
): BlockContentDecorator => {
  const cache = new WeakMap<BlockRenderer, BlockRenderer>()
  return inner => {
    const existing = cache.get(inner)
    if (existing) return existing
    const Decorated: BlockRenderer = ({block}) => createElement(Wrapper, {block, Inner: inner})
    Decorated.displayName = displayName
    cache.set(inner, Decorated)
    return Decorated
  }
}

export type BlockContentDecoratorContribution =
  (context: BlockResolveContext) => BlockContentDecorator | null | undefined | false

export type BlockContentDecoratorResolver =
  (context: BlockResolveContext, inner: BlockRenderer) => BlockRenderer

export type BlockClickContribution =
  (context: BlockResolveContext) => BlockMouseHandler | null | undefined | false

export type BlockClickResolver =
  (context: BlockResolveContext) => BlockMouseHandler | undefined

export type BlockContentSurfaceProps = HTMLAttributes<HTMLDivElement>

export type BlockContentSurfaceContribution =
  (context: BlockResolveContext) => BlockContentSurfaceProps | null | undefined | false

export type BlockContentSurfaceResolver =
  (context: BlockResolveContext) => BlockContentSurfaceProps

// Slot for sections rendered above a block's body — navigation chrome
// such as top-level breadcrumbs lives here. Mirrors
// `blockChildrenFooterFacet` exactly: each contribution returns a
// renderer (or null/undefined/false to opt out for this block); the
// layout renders all returned components in contribution order.
export type BlockHeaderContribution =
  (context: BlockResolveContext) => BlockRenderer | null | undefined | false

export type BlockHeaderResolver =
  (context: BlockResolveContext) => readonly BlockRenderer[]

// Slot for sections rendered after a block's children — Roam-style "Linked
// References" lives here. Each contribution returns a renderer (or null/
// undefined/false to opt out for this block); the DefaultBlockRenderer
// renders all returned components in contribution order.
export type BlockChildrenFooterContribution =
  (context: BlockResolveContext) => BlockRenderer | null | undefined | false

export type BlockChildrenFooterResolver =
  (context: BlockResolveContext) => readonly BlockRenderer[]

// Slot for sections rendered inside a block's bullet hover-card — block
// metadata (created/edited/by, counts, id) lives here. Mirrors
// `blockHeaderFacet`: each contribution returns a renderer (or null/
// undefined/false to opt out for this block); `BlockBullet` shows a
// floating card populated with all returned components in contribution
// order when the bullet is hovered. When NO contribution returns a
// renderer, the bullet attaches no hover listeners and renders no card —
// the feature is pure opt-in and costs nothing on a stock build.
export type BlockBulletHoverContribution =
  (context: BlockResolveContext) => BlockRenderer | null | undefined | false

export type BlockBulletHoverResolver =
  (context: BlockResolveContext) => readonly BlockRenderer[]

// Block layout — owns the entire shape of a block as rendered (the
// outer wrapper, controls placement, collapse behavior, and where the
// content/children/footer slots sit). The default vertical layout lives
// in `DefaultBlockLayout`; plugins contribute alternatives by returning
// a layout component for blocks they want to redress.
//
// Each slot the layout receives is already wrapped in its own
// ErrorBoundary + interaction context boundary, so swapping the layout
// doesn't change shortcut-surface scoping or accidentally nest a child
// block inside the parent's content surface.
//
// Slots are defined by the framework — even when a layout chooses not
// to render one, the slot still exists as a function it can ignore.
// `Properties` is `null` when the block has them hidden; the layout
// uses `{Properties && <Properties/>}` to skip rendering.
//
// Shell concerns the *typical* block wrapper bears (click/paste handler
// dispatch, the canonical `data-block-id` / `data-editing` attributes,
// the focusable tabIndex, plus the shortcut-surface activation and shell
// decorators) are exposed as the `Shell` slot — an opt-in render-prop
// wrapper. A layout that wants the interactive block surface renders
// `<Shell>{shellProps => <wrapper {...shellProps}/>}</Shell>`; the shell's
// machinery (paste/click handlers, shell decorators, `useShortcutSurface-
// Activations`) only runs when the layout actually mounts it. A read-only
// layout (a block reference) simply doesn't render `Shell`, so it pays for
// none of that — the lazy-slot equivalent of "don't allocate what you don't
// use".
/** Marks the element a layout spreads `shellProps` onto as this block's shell —
 *  the outer half of a block's DOM boundary (`.block-content` is the inner
 *  half). Travels with the props rather than with the default layout's class so
 *  a layout that styles its own wrapper still declares the boundary, and any
 *  handler resolving ownership can ask one question of both halves. */
export const BLOCK_SHELL_ATTRIBUTE = 'data-block-shell'

/** Marks a content slot that holds a VIEW — a review backlog, a review deck, a
 *  recents list — rather than the block's own text. Written by the slot, which
 *  is the only place that knows: it resolved the renderer. Callers reasoning
 *  about a row's GEOMETRY need it, because such a row's rect describes
 *  everything it shows rather than the block itself. */
export const BLOCK_CONTENT_VIEW_ATTRIBUTE = 'data-block-content-view'

export interface BlockShellProps {
  'data-block-shell': 'true'
  'data-block-id': string
  'data-render-scope-id'?: string
  'data-editing': 'true' | 'false'
  className?: string
  tabIndex: number
  ref?: Ref<HTMLDivElement>
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onMouseDownCapture?: (event: MouseEvent<HTMLElement>) => void
  onPointerDownCapture?: (event: PointerEvent<HTMLElement>) => void
  onClick?: (event: MouseEvent<HTMLElement>) => void
  onPaste?: (event: ClipboardEvent<HTMLElement>) => void
}

export interface BlockShellState {
  shellProps: BlockShellProps
  shortcutSurfaceOptions: Record<string, unknown>
}

export interface BlockShellDecoratorProps {
  resolveContext: BlockResolveContext
  shellRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  state: BlockShellState
  children: (state: BlockShellState) => ReactNode
}

export type BlockShellDecorator = ComponentType<BlockShellDecoratorProps>

// Hook-safe shell extension point. Contributions return a component
// that wraps the block shell render with a render-prop state transform,
// so plugin hooks can contribute wrapper props / shortcut metadata
// without being called directly by DefaultBlockRenderer.
export type BlockShellDecoratorContribution =
  (context: BlockResolveContext) => BlockShellDecorator | null | undefined | false

export type BlockShellDecoratorResolver =
  (context: BlockResolveContext) => readonly BlockShellDecorator[]

/** Render-prop a layout passes to the `Shell` slot: given the shell props
 *  (after the shell decorators have transformed them), return the focusable
 *  wrapper element the props should land on. */
export type BlockShellRender = (shellProps: BlockShellProps) => ReactNode

export interface BlockShellSlotProps {
  children: BlockShellRender
  /**
   * This layout wants the shell's shortcut surface and decorators but is NOT
   * making an element the block's own surface, so it deliberately ignores
   * `shellProps`. Say so, and the dev-time check that catches an accidental
   * drop stays useful.
   *
   * Legitimate: a layout whose body is a composed pane rather than the block
   * (video-notes puts the block's children in an aside; putting the props on
   * that pane would make the whole thing focusable and click-to-edit). NOT
   * legitimate for a layout that renders the block itself — dropping them
   * there costs the block its identity, and every consumer then resolves to an
   * ancestor.
   */
  shortcutsOnly?: boolean
}

/** Opt-in interactive block surface. Rendering it runs the shell decorators
 *  + `useShortcutSurfaceActivations` and yields the composed `shellProps` to
 *  the layout's render-prop; not rendering it skips all of that. It is an
 *  indivisible bundle — there's no way to get just the focusable data
 *  attributes without the decorators/activations, and a layout should mount it
 *  at most once (two mounts = duplicate shortcut activations + duplicate
 *  `data-block-id`/nav nodes for one block). */
export type BlockShellSlot = ComponentType<BlockShellSlotProps>

export interface BlockLayoutSlots {
  block: Block
  /** Block content surface — content renderer + surface props + error boundary. */
  Content: ComponentType
  /** Read-only, chrome-free inline content — the block's *base read* content
   *  renderer, with no editable `block-content` wrapper, surface props, or
   *  gesture ref. This is the raw content as it appears in an inline citation
   *  (a block reference): it never becomes an editor even when the same block
   *  is being edited at its home location, because it is built from the read
   *  renderer rather than the edit-aware dispatcher. */
  RawContent: ComponentType
  /** Block properties (metadata key/value pairs); `null` when hidden. */
  Properties: ComponentType | null
  /** Block children subtree (raw `BlockChildren`; layout decides whether to wrap in CollapsibleContent). */
  Children: ComponentType
  /** After-children sections contributed via `blockChildrenFooterFacet`. */
  Footer: ComponentType
  /** Bullet + expand-collapse affordances; renders nothing when not appropriate (top-level). */
  Controls: ComponentType
  /** Above-body sections contributed via `blockHeaderFacet` (top-level breadcrumbs by default). */
  Header: ComponentType
  /** Opt-in interactive block surface (shell props + decorators + shortcut
   *  activations). A layout renders `<Shell>{shellProps => <wrapper
   *  {...shellProps}/>}</Shell>` to become a focusable, editable block; a
   *  read-only layout omits it and pays for none of the shell machinery. */
  Shell: BlockShellSlot
}

export type BlockLayout = ComponentType<BlockLayoutSlots>

export type BlockLayoutVariant = Variant<BlockLayout>

// Variant facet — each contribution registers a named alternative
// layout. Plugins typically self-gate by context (e.g. the video
// player layout only contributes for the video block); the consumer
// picks `last` to preserve last-wins behavior.
export type BlockLayoutRegistration =
  VariantRegistration<BlockResolveContext, BlockLayout>

export type BlockLayoutResolver =
  VariantResolver<BlockResolveContext, BlockLayout>

/**
 * The `combine` shared by every "each plugin offers zero or more <things>
 * for this block" facet below — header, children-footer, bullet-hover,
 * context-menu items, shell decorators. Runs each contribution against
 * the context and keeps what it returns, in registration order; a
 * contribution opts out for this block by returning null/undefined/false.
 *
 * A contribution may return one value or a list of them. Distinguishing
 * the two by `Array.isArray` is safe for all five: their payloads are
 * components, decorators and plain item objects, never arrays themselves.
 *
 * Named rather than inlined five times because the loop is where these
 * facets drifted before — same reason `mergeBlockContentSurfaceProps` and
 * `resolveShortcutActivations` below are their own functions.
 */
const collectPerContext = <Context, Value>(
  contributions: readonly ((context: Context) => Value | readonly Value[] | null | undefined | false)[],
) => (context: Context): Value[] => {
  const result: Value[] = []
  for (const contribution of contributions) {
    const value = contribution(context)
    if (!value) continue
    if (Array.isArray(value)) result.push(...value as readonly Value[])
    else result.push(value as Value)
  }
  return result
}

export const blockHeaderFacet = defineFacet<
  BlockHeaderContribution,
  BlockHeaderResolver
>({
  id: 'core.block-header',
  combine: collectPerContext,
  empty: () => () => [],
  validate: isFunction<BlockHeaderContribution>,
})

export const blockChildrenFooterFacet = defineFacet<
  BlockChildrenFooterContribution,
  BlockChildrenFooterResolver
>({
  id: 'core.block-children-footer',
  combine: collectPerContext,
  empty: () => () => [],
  validate: isFunction<BlockChildrenFooterContribution>,
})

export const blockBulletHoverFacet = defineFacet<
  BlockBulletHoverContribution,
  BlockBulletHoverResolver
>({
  id: 'core.block-bullet-hover',
  combine: collectPerContext,
  empty: () => () => [],
  validate: isFunction<BlockBulletHoverContribution>,
})

/** One entry in the bullet's context menu, contributed by a plugin. */
export interface BlockContextMenuItem {
  /** Stable identity, also the React key. Namespace it per plugin. */
  id: string
  label: string
  icon?: ComponentType<SVGProps<SVGSVGElement>>
  onSelect: () => void
  destructive?: boolean
}

export type BlockContextMenuItemsContribution =
  (context: BlockResolveContext) => BlockContextMenuItem | readonly BlockContextMenuItem[] | null

export type BlockContextMenuItemsResolver =
  (context: BlockResolveContext) => readonly BlockContextMenuItem[]

// Slot for items appended to the block bullet's context menu — the plugin
// side of a menu core otherwise owns outright. Mirrors `blockBulletHoverFacet`:
// each contribution returns an item, a list of items, or null/undefined/false
// to opt out for this block; `BlockBullet` renders every returned item, in
// contribution order, after core's own items and behind a separator that
// appears only when there is at least one contribution.
//
// Core's five existing items (Copy ID / Copy Block Ref / Copy Block Embed /
// Zoom In / Show-Hide Properties) stay hardcoded rather than becoming
// contributions through this same facet — they close over hook-local state
// (`setShowProperties`, `panelId`, `workspaceId`) that isn't on
// `BlockResolveContext`, and converting them would be a much larger refactor
// of the shell for no gain today. The asymmetry is deliberate, not
// unfinished.
export const blockContextMenuItemsFacet = defineFacet<
  BlockContextMenuItemsContribution,
  BlockContextMenuItemsResolver
>({
  id: 'core.block-context-menu-items',
  combine: collectPerContext,
  empty: () => () => [],
  validate: isFunction<BlockContextMenuItemsContribution>,
})

export const blockLayoutFacet = defineVariantFacet<BlockResolveContext, BlockLayout>({
  id: 'core.block-layout',
})

export const blockShellDecoratorsFacet = defineFacet<
  BlockShellDecoratorContribution,
  BlockShellDecoratorResolver
>({
  id: 'core.block-shell-decorators',
  combine: collectPerContext,
  empty: () => () => [],
  validate: isFunction<BlockShellDecoratorContribution>,
})

export type ShortcutSurface =
  | 'block'
  | 'codemirror'
  | (string & {})

export interface ShortcutSurfaceContext extends BlockInteractionContext {
  surface: ShortcutSurface
  editorView?: EditorView
  [key: string]: unknown
}

export type ShortcutActivationContribution =
  (context: ShortcutSurfaceContext) => readonly ActionContextActivation[] | null | undefined | false

export type ShortcutActivationResolver =
  (context: ShortcutSurfaceContext) => readonly ActionContextActivation[]

export const getBlockContentRendererSlot = (
  context: BlockResolveContext,
  slotId: string,
): BlockRenderer | undefined =>
  context.contentRenderers?.find(slot => slot.id === slotId)?.renderer

export const blockContentRendererFacet = defineVariantFacet<BlockResolveContext, BlockRenderer>({
  id: 'core.block-content-renderer',
})

/**
 * Which component draws a whole block — the outermost choice, made in
 * `useRenderer` before any of the facets above are consulted.
 *
 * One registration per renderer: `{id, label}` names it (a user's
 * `renderer` property and any picker address it by `id`), and either a
 * static `render` or a `resolve` that claims the blocks it wants.
 * `resolve` returning null means "not this block"; returning facts with
 * `claims: false` means "available if asked for by id, but do not take
 * the block on my own" — which is how a renderer that could draw
 * ANYTHING (a raw-JSON view, a table view) gets offered without
 * claiming everything.
 *
 * Ranking is facet precedence: the last claiming registration in
 * precedence order wins, so the plain default renderer sits at the
 * implicit 0 and every specialization registers above it. Precedence is
 * fixed at registration; a renderer that must outrank a peer only for
 * SOME blocks registers twice, gated.
 */
export type BlockRendererRegistration =
  VariantRegistration<BlockRendererContext, BlockRenderer>

export const blockRendererFacet = defineVariantFacet<BlockRendererContext, BlockRenderer>({
  id: 'core.block-renderer',
})

// Layered decoration on top of the chosen content renderer. Lower
// precedence wraps closer to the inner renderer; the last contribution
// applied is the outermost layer (its chrome is furthest from the inner
// content). Returning null/undefined/false from a contribution skips it
// for that block. Decorator authors should memoize the wrapped component
// per-inner so React doesn't unmount the inner subtree on every render.
//
// A CONTRIBUTION IS A STRUCTURAL GATE, NOT A REACTIVE ONE. It runs when the
// decorator set is resolved for a block, and is NOT re-run because the world
// moved underneath it — so anything it decides from a clock, a query result,
// or another block's state freezes at resolve time. Two bugs of exactly that
// shape shipped from one gate that tested "is this today's daily note": a note
// left open across midnight kept a hint that had become wrong, and tomorrow's
// note, opened before midnight, could never gain one. Decide on `ctx.types`,
// `ctx.isTopLevel`, `ctx.blockContext` and the like; put anything time- or
// data-dependent inside the decorating component, where a hook can re-run it.
export const blockContentDecoratorsFacet = defineFacet<
  BlockContentDecoratorContribution,
  BlockContentDecoratorResolver
>({
  id: 'core.block-content-decorators',
  combine: contributions => (context, inner) => {
    let renderer = inner
    for (const contribution of contributions) {
      const decorator = contribution(context)
      if (decorator) renderer = decorator(renderer)
    }
    return renderer
  },
  empty: () => (_context, inner) => inner,
  validate: isFunction<BlockContentDecoratorContribution>,
})

export const blockClickHandlersFacet = defineFacet<
  BlockClickContribution,
  BlockClickResolver
>({
  id: 'core.block-click-handlers',
  combine: combineLastContributionResult<BlockResolveContext, BlockMouseHandler>(),
  empty: () => () => undefined,
  validate: isFunction<BlockClickContribution>,
})

// Compose props from multiple contributions onto the same DOM node:
// - function-valued props (event handlers) are chained in contribution order
// - className strings are concatenated with a space
// - everything else is last-wins
export const mergeBlockContentSurfaceProps = (
  contributions: readonly BlockContentSurfaceContribution[],
  context: BlockResolveContext,
): BlockContentSurfaceProps => {
  const merged: Record<string, unknown> = {}

  for (const contribution of contributions) {
    const props = contribution(context)
    if (!props) continue

    for (const [key, value] of Object.entries(props)) {
      const existing = merged[key]
      if (typeof value === 'function' && typeof existing === 'function') {
        const prev = existing as (...args: unknown[]) => unknown
        const next = value as (...args: unknown[]) => unknown
        merged[key] = (...args: unknown[]) => {
          prev(...args)
          next(...args)
        }
      } else if (key === 'className' && typeof value === 'string' && typeof existing === 'string') {
        merged[key] = `${existing} ${value}`
      } else {
        merged[key] = value
      }
    }
  }

  return merged as BlockContentSurfaceProps
}

export const blockContentSurfacePropsFacet = defineFacet<
  BlockContentSurfaceContribution,
  BlockContentSurfaceResolver
>({
  id: 'core.block-content-surface-props',
  combine: contributions => context => mergeBlockContentSurfaceProps(contributions, context),
  empty: () => () => ({}),
  validate: isFunction<BlockContentSurfaceContribution>,
})

/** What a text-class contribution gets to decide from. Deliberately tiny: the
 *  renderers that draw block text have a `block`, not a full
 *  `BlockResolveContext`. `aliases` is read reactively by the hook (a
 *  contribution can't call hooks, and `block.peek()` would freeze at resolve
 *  time — the failure mode `blockContentDecoratorsFacet` documents). */
export interface BlockTextClassContext {
  block: Block
  /** This render is its panel's document body — see `useIsFocalRender`. */
  isFocal: boolean
  /** The block's page names, or `[]`. */
  aliases: readonly string[]
}

export type BlockTextClassContribution = (ctx: BlockTextClassContext) => string | null
export type BlockTextClassResolver = (ctx: BlockTextClassContext) => string

/**
 * Classes for the block's own TEXT, contributed by plugins.
 *
 * The counterpart to `blockContentSurfacePropsFacet`, and the difference is
 * load-bearing. That one styles the content SLOT, whose occupant is whatever
 * won `blockContentRendererFacet` — a review deck, a recents list, a video
 * player. font-size/weight/line-height inherit, so anything typographic put
 * there styles an arbitrary plugin subtree (see `blockTitleText.ts` for the
 * bug that taught us). Use this facet for typography and that one for box
 * properties the slot genuinely owns.
 */
export const blockTextClassFacet = defineFacet<
  BlockTextClassContribution,
  BlockTextClassResolver
>({
  id: 'core.block-text-class',
  combine: contributions => context =>
    contributions.map(contribute => contribute(context)).filter(Boolean).join(' '),
  empty: () => () => '',
  validate: isFunction<BlockTextClassContribution>,
})

/** What a bullet-class contribution gets to decide from. No `isFocal`: the
 *  focal block renders no bullet at all (the controls slot returns null for
 *  it), so there is no focal case to decide. `aliases` is read reactively at
 *  the bullet, same reason as above. */
export interface BlockBulletClassContext {
  block: Block
  /** The block's page names, or `[]`. */
  aliases: readonly string[]
}

export type BlockBulletClassContribution = (ctx: BlockBulletClassContext) => string | null
export type BlockBulletClassResolver = (ctx: BlockBulletClassContext) => string

/**
 * Classes for the block's BULLET, contributed by plugins.
 *
 * The third of the sibling class seams, and the one to reach for when the
 * mark should not be part of the text at all. Nothing here inherits into the
 * content subtree, nothing here can be resized or re-flowed by a decorator
 * that wraps the content (the type chips make the content container
 * shrink-to-fit, which is what made a border on the title text render at two
 * different widths), and the bullet column is where an outline already
 * carries structural facts — collapsed-with-children draws its halo here.
 *
 * Contributions land on the dot itself, so they compose with that halo rather
 * than replacing it: keep them to paint (color, background, box-shadow) and
 * to the dot's own size. Anything that changes the bullet's FOOTPRINT would
 * move every row's text, since the surrounding anchor is fixed-size.
 */
export const blockBulletClassFacet = defineFacet<
  BlockBulletClassContribution,
  BlockBulletClassResolver
>({
  id: 'core.block-bullet-class',
  combine: contributions => context =>
    contributions.map(contribute => contribute(context)).filter(Boolean).join(' '),
  empty: () => () => '',
  validate: isFunction<BlockBulletClassContribution>,
})

export const resolveShortcutActivations = (
  contributions: readonly ShortcutActivationContribution[],
  context: ShortcutSurfaceContext,
): readonly ActionContextActivation[] =>
  contributions.flatMap(contribution => contribution(context) || [])

export const shortcutSurfaceActivationsFacet = defineFacet<
  ShortcutActivationContribution,
  ShortcutActivationResolver
>({
  id: 'core.shortcut-surface-activations',
  combine: contributions => context => resolveShortcutActivations(contributions, context),
  empty: () => () => [],
  validate: isFunction<ShortcutActivationContribution>,
})

const interactiveContentSelector = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'details',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[data-block-interaction="ignore"]',
].join(',')

export const isInteractiveContentEvent = (event: { target: EventTarget | null }) => {
  const target = event.target
  if (typeof Node === 'undefined' || !(target instanceof Node)) return false
  const element = target.nodeType === Node.ELEMENT_NODE
    ? target as Element
    : target.parentElement
  return Boolean(element?.closest(interactiveContentSelector))
}

/**
 * Where one block's DOM ends and another's begins: a content surface
 * (`DefaultBlockRenderer`'s content slot) or a block shell. Walking up from an
 * event target, the first of these decides which block the target belongs to.
 *
 * BOTH are needed. A shell holds more than its content slot — the bullet, the
 * property panel, a breadcrumb chain, whatever chrome a surface adds — and a
 * target there has no `.block-content` above it until the CONTAINER's, which
 * would read as the container's own. Neither marker alone spans a block.
 *
 * The shell half is an attribute carried by `shellProps`, not the default
 * layout's class: a layout is free to style its own wrapper, and one that does
 * must still be recognisable as a block.
 */
const BLOCK_BOUNDARY_SELECTOR = `.block-content, [${BLOCK_SHELL_ATTRIBUTE}]`

/**
 * Is this event's target on OUR surface, rather than on a nested block's?
 *
 * Innermost wins unconditionally, whether or not the nested block handles that
 * gesture: an ancestor must not inherit a gesture the block under the pointer
 * declined (a nested block in edit mode disables its swipe, and "swipe the
 * container instead" is never the right reading of that).
 *
 * Propagation cannot stand in for this. A renderer that fills a content slot
 * with real block rows puts one surface inside another, and then each phase
 * fails its own way: bubbling lets the container act LAST and overwrite,
 * capturing lets it act FIRST and consume. Ordinary outline children sit
 * outside their parent's content slot, which is why only such surfaces are
 * affected — and why testing this needs one of them.
 */
export const ownsGestureTarget = (element: HTMLElement, target: EventTarget | null): boolean => {
  if (typeof Node === 'undefined' || !(target instanceof Node)) return true
  const start = target.nodeType === Node.ELEMENT_NODE ? (target as Element) : target.parentElement
  const boundary = start?.closest(BLOCK_BOUNDARY_SELECTOR)
  return !boundary || boundary === element
}

/**
 * Enter edit mode for a block from its flat dependencies — the core used by
 * both the `BlockResolveContext` wrapper below and the pointer-dispatched
 * click-to-edit action (which only carries `{block, uiStateBlock, renderScopeId}`).
 */
export const enterEditModeForBlock = async (
  block: Block,
  uiStateBlock: Block,
  renderScopeId?: string,
  selection?: EditorActivationSelection,
) => {
  // Read-only workspace: clicks/keyboard shouldn't drop into edit mode, but
  // we still want the click target to register as focused so navigation
  // affordances (highlight, keyboard nav anchor) work. `focusBlock` honors
  // the read-only gate internally — `{edit: true}` here becomes a noop on
  // the edit flag in read-only mode.
  if (uiStateBlock.repo.isReadOnly) {
    void focusBlock(uiStateBlock, block.id, {renderScopeId})
    return
  }

  await resetBlockSelection(uiStateBlock)
  await focusBlock(uiStateBlock, block.id, {edit: true, renderScopeId})

  if (selection) {
    void uiStateBlock.set(editorSelection, {
      blockId: block.id,
      ...selection,
    })
  }

  requestEditorFocus(uiStateBlock)
}

export const enterBlockEditMode = async (
  context: BlockResolveContext,
  selection?: EditorActivationSelection,
) => {
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined
  await enterEditModeForBlock(context.block, context.uiStateBlock, renderScopeId, selection)
}

/**
 * Focus a block without entering edit mode, clearing any active block
 * selection first — the "single click focuses" behaviour vim normal mode wants
 * (and the plain-click branch of `handleBlockSelectionClick`). Operates on the
 * flat deps a pointer-dispatched action carries.
 */
export const focusBlockWithoutEditing = async (
  block: Block,
  uiStateBlock: Block,
  renderScopeId?: string,
) => {
  await resetBlockSelection(uiStateBlock)
  void focusBlock(uiStateBlock, block.id, renderScopeId ? {renderScopeId} : undefined)
}

export const isSelectionClick = (event: MouseEvent) =>
  event.ctrlKey || event.metaKey || event.shiftKey

/**
 * Build the deps a pointer-dispatched block gesture needs from a block's
 * resolve context plus the live event — the clicked/tapped block, the surface
 * boundary, and the DOM node the event targeted. `currentTarget` is read
 * synchronously here (the caller is still inside the React handler) because
 * React nulls it once the handler returns, and pointer actions (the spatial
 * selection walker) need the bound element to locate the gesture among visible
 * blocks. Shared by the block shell's click path and the content surface's
 * double-click/tap path so the supplied-deps shape stays in one place.
 */
export const blockPointerDepsFrom = (
  context: BlockResolveContext,
  event: PointerGestureEvent,
): BlockPointerDependencies => {
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined
  return {
    block: context.block,
    uiStateBlock: context.uiStateBlock,
    scopeRootId: context.scopeRootId,
    scopeRootForcesOpen: !context.blockContext?.isNestedSurface,
    targetElement: event.currentTarget,
    ...(renderScopeId ? {renderScopeId} : {}),
  }
}
