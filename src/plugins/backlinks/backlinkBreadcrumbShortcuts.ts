import { Block } from '@/data/block'
import {
  actionsFacet,
  actionContextsFacet,
} from '@/extensions/core.js'
import type { AppExtension } from '@/extensions/facet.js'
import {
  shortcutSurfaceActivationsFacet,
  type ShortcutActivationContribution,
} from '@/extensions/blockInteraction.js'
import type {
  ActionConfig,
  ActionContextConfig,
  BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import type { BlockContextType } from '@/types.js'

export const BACKLINK_ENTRY_ACTION_CONTEXT = 'backlinks.entry'
export const BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY = 'backlinks.entryShortcutController'

export interface BacklinkEntryShortcutController {
  promoteClosestBreadcrumb: () => boolean
  hasBreadcrumb: () => boolean
}

interface BacklinkEntryShortcutDependencies extends BaseShortcutDependencies {
  block: Block
  promoteClosestBreadcrumb: () => boolean
  hasBreadcrumb: () => boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isBacklinkEntryShortcutController = (
  value: unknown,
): value is BacklinkEntryShortcutController =>
  isRecord(value) &&
  typeof value.promoteClosestBreadcrumb === 'function' &&
  typeof value.hasBreadcrumb === 'function'

const isBacklinkEntryShortcutDependencies = (
  value: unknown,
): value is BacklinkEntryShortcutDependencies =>
  isRecord(value) &&
  value.block instanceof Block &&
  value.uiStateBlock instanceof Block &&
  typeof value.promoteClosestBreadcrumb === 'function' &&
  typeof value.hasBreadcrumb === 'function'

const toBacklinkEntryShortcutDependencies = (
  value: BaseShortcutDependencies,
): Partial<BacklinkEntryShortcutDependencies> =>
  value as Partial<BacklinkEntryShortcutDependencies>

export const backlinkEntryShortcutContextOverrides = (
  controller: BacklinkEntryShortcutController,
): Partial<BlockContextType> => ({
  [BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY]: controller,
})

// Promote the breadcrumb segment closest to the body — i.e. the immediate
// parent of the currently-shown block — to be the new shown block. Mirrors
// what clicking the rightmost breadcrumb does, so repeated invocations
// peel off one ancestor at a time and surface more surrounding context.
export const promoteClosestBreadcrumb = (
  parents: readonly Block[],
  setShownBlockId: (blockId: string) => void,
): boolean => {
  const target = parents.at(-1)
  if (!target) return false
  setShownBlockId(target.id)
  return true
}

export const backlinkEntryActionContext: ActionContextConfig = {
  type: BACKLINK_ENTRY_ACTION_CONTEXT,
  displayName: 'Backlink Entry',
  validateDependencies: isBacklinkEntryShortcutDependencies,
}

export const promoteClosestBreadcrumbAction: ActionConfig = {
  id: 'backlinks.promote_closest_breadcrumb',
  description: 'Promote closest backlink breadcrumb',
  context: BACKLINK_ENTRY_ACTION_CONTEXT,
  handler: (dependencies) => {
    const deps = toBacklinkEntryShortcutDependencies(dependencies)
    deps.promoteClosestBreadcrumb?.()
  },
  canRun: (dependencies) => {
    const deps = toBacklinkEntryShortcutDependencies(dependencies)
    return deps.hasBreadcrumb?.() === true
  },
  defaultBinding: {
    // Code form: Mac's Alt+z produces 'Ω' as event.key, so the binding
    // has to match event.code 'KeyZ' instead.
    keys: 'Alt+KeyZ',
  },
}

export const backlinkEntryShortcutActivation: ShortcutActivationContribution = context => {
  if (
    context.surface !== 'block' ||
    !context.inFocus ||
    context.inEditMode ||
    context.isSelected ||
    context.blockContext?.isBacklink !== true
  ) {
    return null
  }

  const controller = context.blockContext[BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY]
  if (!isBacklinkEntryShortcutController(controller)) return null

  return [{
    context: BACKLINK_ENTRY_ACTION_CONTEXT,
    dependencies: {
      block: context.block,
      promoteClosestBreadcrumb: controller.promoteClosestBreadcrumb,
      hasBreadcrumb: controller.hasBreadcrumb,
    },
  }]
}

export const backlinkBreadcrumbShortcutsExtension: AppExtension = [
  actionContextsFacet.of(backlinkEntryActionContext, {source: 'backlinks'}),
  actionsFacet.of(promoteClosestBreadcrumbAction, {source: 'backlinks'}),
  shortcutSurfaceActivationsFacet.of(backlinkEntryShortcutActivation, {source: 'backlinks'}),
]
