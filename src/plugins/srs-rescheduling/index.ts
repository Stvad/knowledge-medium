import { actionsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import type { Block } from '@/data/block'
import {
  ActionConfig,
  ActionContextTypes,
  BlockShortcutDependencies,
  CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.ts'
import {
  scheduleSrsContent,
  SrsSignal,
  srsSignals,
} from './scheduler.ts'

const shortcutKeysForSignal = (signal: SrsSignal): string[] => {
  const key = String(signal)
  return [
    `ctrl+shift+${key}`,
    `ctrl+shift+alt+cmd+${key}`,
  ]
}

const signalName = (signal: SrsSignal): string =>
  SrsSignal[signal]

const rescheduleBlock = async (block: Block, signal: SrsSignal): Promise<void> => {
  const data = block.peek() ?? await block.load()
  if (!data) return

  await block.setContent(scheduleSrsContent(data.content, signal))
}

const createNormalModeAction = (
  signal: SrsSignal,
): ActionConfig<typeof ActionContextTypes.NORMAL_MODE> => ({
  id: `srs.reschedule.${signalName(signal).toLowerCase()}`,
  description: `SRS: ${signalName(signal)}`,
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}: BlockShortcutDependencies) => {
    await rescheduleBlock(block, signal)
  },
  defaultBinding: {
    keys: shortcutKeysForSignal(signal),
    eventOptions: {
      preventDefault: true,
    },
  },
})

const createEditModeAction = (
  signal: SrsSignal,
): ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> => ({
  id: `edit.cm.srs.reschedule.${signalName(signal).toLowerCase()}`,
  description: `SRS: ${signalName(signal)} (Edit Mode)`,
  context: ActionContextTypes.EDIT_MODE_CM,
  handler: async ({block}: CodeMirrorEditModeDependencies) => {
    await rescheduleBlock(block, signal)
  },
  defaultBinding: {
    keys: shortcutKeysForSignal(signal),
    eventOptions: {
      preventDefault: true,
    },
  },
})

export const srsReschedulingActions: readonly ActionConfig[] = [
  ...srsSignals.map(createNormalModeAction),
  ...srsSignals.map(createEditModeAction),
]

export const srsReschedulingPlugin: AppExtension =
  srsReschedulingActions.map(action =>
    actionsFacet.of(action, {source: 'srs-rescheduling'}),
  )
