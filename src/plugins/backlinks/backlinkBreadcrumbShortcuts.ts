import { Block } from '@/data/block'
import { isCollapsedProp } from '@/data/properties.ts'
import {
  actionsFacet,
  actionContextsFacet,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  shortcutSurfaceActivationsFacet,
  type ShortcutActivationContribution,
} from '@/extensions/blockInteraction.ts'
import type {
  ActionConfig,
  ActionContextConfig,
  BaseShortcutDependencies,
} from '@/shortcuts/types.ts'
import type { BlockContextType } from '@/types.ts'

export const BACKLINK_ENTRY_ACTION_CONTEXT = 'backlinks.entry'
export const BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY = 'backlinks.entryShortcutController'

export interface BacklinkEntryShortcutController {
  expandNextCollapsedBreadcrumb: () => void | boolean | Promise<void | boolean>
  hasCollapsedBreadcrumb: () => boolean
}

interface BacklinkEntryShortcutDependencies extends BaseShortcutDependencies {
  block: Block
  expandNextCollapsedBreadcrumb: () => void | boolean | Promise<void | boolean>
  hasCollapsedBreadcrumb: () => boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isBacklinkEntryShortcutController = (
  value: unknown,
): value is BacklinkEntryShortcutController =>
  isRecord(value) &&
  typeof value.expandNextCollapsedBreadcrumb === 'function' &&
  typeof value.hasCollapsedBreadcrumb === 'function'

const isBacklinkEntryShortcutDependencies = (
  value: unknown,
): value is BacklinkEntryShortcutDependencies =>
  isRecord(value) &&
  value.block instanceof Block &&
  value.uiStateBlock instanceof Block &&
  typeof value.expandNextCollapsedBreadcrumb === 'function' &&
  typeof value.hasCollapsedBreadcrumb === 'function'

const toBacklinkEntryShortcutDependencies = (
  value: BaseShortcutDependencies,
): Partial<BacklinkEntryShortcutDependencies> =>
  value as Partial<BacklinkEntryShortcutDependencies>

export const backlinkEntryShortcutContextOverrides = (
  controller: BacklinkEntryShortcutController,
): Partial<BlockContextType> => ({
  [BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY]: controller,
})

export const findNextCollapsedBreadcrumb = (
  parents: readonly Block[],
): Block | null => {
  for (let index = parents.length - 1; index >= 0; index--) {
    const parent = parents[index]
    if (parent.peekProperty(isCollapsedProp) === true) return parent
  }
  return null
}

export const openNextCollapsedBreadcrumb = async (
  parents: readonly Block[],
  showBlock: (blockId: string) => void | Promise<void>,
): Promise<boolean> => {
  const target = findNextCollapsedBreadcrumb(parents)
  if (!target) return false

  await target.set(isCollapsedProp, false)
  await showBlock(target.id)
  return true
}

export const backlinkEntryActionContext: ActionContextConfig = {
  type: BACKLINK_ENTRY_ACTION_CONTEXT,
  displayName: 'Backlink Entry',
  validateDependencies: isBacklinkEntryShortcutDependencies,
}

export const expandNextCollapsedBreadcrumbAction: ActionConfig = {
  id: 'backlinks.expand_next_collapsed_breadcrumb',
  description: 'Expand next collapsed backlink breadcrumb',
  context: BACKLINK_ENTRY_ACTION_CONTEXT,
  handler: async (dependencies) => {
    const deps = toBacklinkEntryShortcutDependencies(dependencies)
    await deps.expandNextCollapsedBreadcrumb?.()
  },
  canRun: (dependencies) => {
    const deps = toBacklinkEntryShortcutDependencies(dependencies)
    return deps.hasCollapsedBreadcrumb?.() === true
  },
  defaultBinding: {
    keys: 'alt+z',
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
      expandNextCollapsedBreadcrumb: controller.expandNextCollapsedBreadcrumb,
      hasCollapsedBreadcrumb: controller.hasCollapsedBreadcrumb,
    },
  }]
}

export const backlinkBreadcrumbShortcutsExtension: AppExtension = [
  actionContextsFacet.of(backlinkEntryActionContext, {source: 'backlinks'}),
  actionsFacet.of(expandNextCollapsedBreadcrumbAction, {source: 'backlinks'}),
  shortcutSurfaceActivationsFacet.of(backlinkEntryShortcutActivation, {source: 'backlinks'}),
]
