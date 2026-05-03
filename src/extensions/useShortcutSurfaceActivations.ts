import { useMemo } from 'react'
import { shortcutSurfaceActivationsFacet } from '@/extensions/blockInteraction.ts'
import type {
  BlockInteractionContext,
  ShortcutSurface,
  ShortcutSurfaceContext,
} from '@/extensions/blockInteraction.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useActionContextActivations } from '@/shortcuts/useActionContext.ts'
import { Block } from '../data/block'
import { useRepo } from '@/context/repo.tsx'
import { useBlockContext } from '@/context/block.tsx'
import {
  useInEditMode,
  useInFocus,
  useIsSelected,
  useUIStateBlock,
  useUIStateProperty,
} from '@/data/globalState.ts'
import { topLevelBlockIdProp } from '@/data/properties.ts'

type ShortcutSurfaceOptions =
  Partial<Omit<ShortcutSurfaceContext, keyof BlockInteractionContext | 'surface'>> &
  Record<string, unknown>

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
  const inFocus = useInFocus(block.id)
  const inEditMode = useInEditMode(block.id)
  const isSelected = useIsSelected(block.id)

  const runtime = useAppRuntime()
  const resolveShortcutActivations = runtime.read(shortcutSurfaceActivationsFacet)

  const shortcutActivations = useMemo(
    () => resolveShortcutActivations({
      block,
      repo,
      uiStateBlock,
      topLevelBlockId,
      isTopLevel: block.id === topLevelBlockId,
      blockContext,
      inFocus,
      inEditMode,
      isSelected,
      ...options,
      surface,
    }),
    [
      block,
      repo,
      uiStateBlock,
      topLevelBlockId,
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
