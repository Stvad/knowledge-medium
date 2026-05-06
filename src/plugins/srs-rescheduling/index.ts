import { actionsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import type { Block } from '@/data/block'
import { ChangeScope, type PropertySchema } from '@/data/api'
import { propertyUiFacet } from '@/data/facets.ts'
import { getOrCreateDailyNote } from '@/data/dailyNotes'
import { getBlockTypes } from '@/data/properties.ts'
import { formatIsoDate } from '@/utils/dailyPage'
import {
  ActionConfig,
  ActionContextTypes,
  BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import {
  DEFAULT_FACTOR,
  DEFAULT_INTERVAL,
  scheduleSrsContent,
  scheduleSrsProperties,
  SrsSignal,
  srsSignals,
} from './scheduler.ts'
import { srsReschedulingDataExtension } from './dataExtension.ts'
import {
  SRS_SM25_TYPE,
  srsFactorProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
} from './schema.ts'
import { srsNextReviewDateUi } from './propertyUi.ts'

const shortcutKeysForSignal = (signal: SrsSignal): string[] => {
  const key = String(signal)
  return [
    `ctrl+shift+${key}`,
    `ctrl+shift+alt+cmd+${key}`,
  ]
}

const signalName = (signal: SrsSignal): string =>
  SrsSignal[signal]

type SrsActionContext =
  | typeof ActionContextTypes.NORMAL_MODE
  | typeof ActionContextTypes.EDIT_MODE_CM

interface RescheduleActionOptions<T extends SrsActionContext> {
  context: T
  idPrefix?: string
  descriptionSuffix?: string
}

const readProperty = <T,>(
  properties: Record<string, unknown>,
  schema: PropertySchema<T>,
  fallback: T,
): T => {
  const stored = properties[schema.name]
  if (stored === undefined) return fallback
  try {
    return schema.codec.decode(stored)
  } catch {
    return fallback
  }
}

export const rescheduleBlock = async (block: Block, signal: SrsSignal): Promise<void> => {
  if (block.repo.isReadOnly) return

  const data = block.peek() ?? await block.load()
  if (!data) return

  if (getBlockTypes(data).includes(SRS_SM25_TYPE)) {
    const interval = readProperty(data.properties, srsIntervalProp, DEFAULT_INTERVAL)
    const factor = readProperty(data.properties, srsFactorProp, DEFAULT_FACTOR)
    const reviewCount = readProperty(data.properties, srsReviewCountProp, 0)
    const scheduled = scheduleSrsProperties({interval, factor}, signal)
    const daily = await getOrCreateDailyNote(
      block.repo,
      data.workspaceId,
      formatIsoDate(scheduled.nextReviewDate),
    )

    await block.repo.tx(async tx => {
      const row = await tx.get(block.id)
      if (!row) return
      await tx.update(block.id, {
        properties: {
          ...row.properties,
          [srsIntervalProp.name]: srsIntervalProp.codec.encode(scheduled.interval),
          [srsFactorProp.name]: srsFactorProp.codec.encode(scheduled.factor),
          [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(daily.id),
          [srsReviewCountProp.name]: srsReviewCountProp.codec.encode(reviewCount + 1),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'srs reschedule'})
    return
  }

  await block.setContent(scheduleSrsContent(data.content, signal))
}

const createRescheduleAction = <T extends SrsActionContext>(
  signal: SrsSignal,
  {
    context,
    idPrefix = '',
    descriptionSuffix = '',
  }: RescheduleActionOptions<T>,
): ActionConfig<T> => {
  const name = signalName(signal)
  return {
    id: `${idPrefix}srs.reschedule.${name.toLowerCase()}`,
    description: `SRS: ${name}${descriptionSuffix}`,
    context,
    handler: (async ({block}: BlockShortcutDependencies) => {
      await rescheduleBlock(block, signal)
    }) as ActionConfig<T>['handler'],
    defaultBinding: {
      keys: shortcutKeysForSignal(signal),
      eventOptions: {
        preventDefault: true,
      },
    },
  }
}

export const srsReschedulingActions: readonly ActionConfig[] = [
  ...srsSignals.map(signal => createRescheduleAction(signal, {
    context: ActionContextTypes.NORMAL_MODE,
  })),
  ...srsSignals.map(signal => createRescheduleAction(signal, {
    context: ActionContextTypes.EDIT_MODE_CM,
    idPrefix: 'edit.cm.',
    descriptionSuffix: ' (Edit Mode)',
  })),
]

export const srsReschedulingPlugin: AppExtension = [
  srsReschedulingDataExtension,
  propertyUiFacet.of(srsNextReviewDateUi, {source: 'srs-rescheduling'}),
  srsReschedulingActions.map(action =>
    actionsFacet.of(action, {source: 'srs-rescheduling'}),
  ),
]

export { srsReschedulingDataExtension } from './dataExtension.ts'
export {
  SRS_SM25_TYPE,
  srsFactorProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSm25Type,
} from './schema.ts'
export { srsNextReviewDateUi } from './propertyUi.ts'
