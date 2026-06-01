import { useMemo } from 'react'
import { shortcutSurfaceActivationsFacet } from '@/extensions/blockInteraction.js'
import type {
  BlockInteractionContext,
  ShortcutSurface,
  ShortcutSurfaceContext,
} from '@/extensions/blockInteraction.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useActionContextActivations } from '@/shortcuts/useActionContext.js'
import { Block } from '../data/block'
import { useRepo } from '@/context/repo.js'
import { useBlockContext } from '@/context/block.js'
import {
  useInEditMode,
  useInFocus,
  useIsSelected,
  useUIStateBlock,
  useUIStateProperty,
} from '@/data/globalState.js'
import { activePanelIdProp, topLevelBlockIdProp, typesProp } from '@/data/properties.js'
import { usePropertyValue } from '@/hooks/block.js'

type ShortcutSurfaceOptions =
  Partial<Omit<ShortcutSurfaceContext, keyof BlockInteractionContext | 'surface'>> &
  Record<string, unknown> & {
    surfaceActive?: boolean
  }

const emptyShortcutSurfaceOptions: ShortcutSurfaceOptions = {}

/**
 * Activate a shortcut surface for a block. Builds the full reactive
 * context (block + repo + uiStateBlock + panel envelope + focus / edit
 * mode / selection) from hooks and feeds it through the
 * `shortcutSurfaceActivationsFacet` resolver. Contributions that gate
 * on reactive state (e.g. vim normal mode opting out when the block is
 * in edit mode) therefore re-evaluate when that state changes — which
 * is what we want for shortcut surface scoping.
 *
 * Takes `block` directly rather than reading from a React context, so
 * it doesn't subscribe to per-block state changes unrelated to
 * shortcuts (and so resolver-side facets — layouts, decorators,
 * surface props — keep stable identity through reactive updates).
 */
export function useShortcutSurfaceActivations(
  block: Block,
  surface: ShortcutSurface,
  options: ShortcutSurfaceOptions = emptyShortcutSurfaceOptions,
): void {
  const repo = useRepo()
  const uiStateBlock = useUIStateBlock()
  const blockContext = useBlockContext()
  const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp)
  const [types] = usePropertyValue(block, typesProp)
  const panelId = typeof blockContext.panelId === 'string' ? blockContext.panelId : undefined
  const layoutSessionBlockId = typeof blockContext.layoutSessionBlockId === 'string'
    ? blockContext.layoutSessionBlockId
    : undefined
  const activePanelStateBlock = layoutSessionBlockId ? repo.block(layoutSessionBlockId) : uiStateBlock
  const [activePanelId] = usePropertyValue(activePanelStateBlock, activePanelIdProp)
  const blockInFocus = useInFocus(block.id)
  const surfaceActive = typeof options.surfaceActive === 'boolean'
    ? options.surfaceActive
    : true
  const panelSurfaceActive =
    !panelId || !layoutSessionBlockId || !activePanelId || activePanelId === panelId
  const inFocus = blockInFocus && surfaceActive && panelSurfaceActive
  const inEditMode = useInEditMode(block.id)
  const isSelected = useIsSelected(block.id)

  // Root of this surface's visible subtree — declared by every surface
  // that mounts a block (panel/top-level = its rendered root, backlink
  // entry = shown block, embed = embedded block, breadcrumb = segment).
  // This, not topLevelBlockId, is the boundary structural and navigation
  // handlers operate against.
  const scopeRootId = blockContext.scopeRootId

  const runtime = useAppRuntime()
  const resolveShortcutActivations = runtime.read(shortcutSurfaceActivationsFacet)

  const shortcutActivations = useMemo(
    () => resolveShortcutActivations({
      block,
      repo,
      uiStateBlock,
      types,
      topLevelBlockId,
      scopeRootId,
      isTopLevel: block.id === topLevelBlockId && !blockContext.isNestedSurface,
      blockContext,
      inFocus,
      inEditMode,
      isSelected,
      ...options,
      surface,
    // Inject the surface scope root into every activation's
    // dependencies so handlers receive it uniformly, without each
    // activation contribution (vim, codemirror, backlinks, plugins)
    // having to forward it by hand.
    }).map(activation => ({
      ...activation,
      dependencies: {...(activation.dependencies ?? {}), scopeRootId},
    })),
    [
      block,
      repo,
      uiStateBlock,
      types,
      topLevelBlockId,
      scopeRootId,
      blockContext,
      inFocus,
      inEditMode,
      isSelected,
      options,
      resolveShortcutActivations,
      surface,
    ],
  )

  useActionContextActivations(shortcutActivations)
}
