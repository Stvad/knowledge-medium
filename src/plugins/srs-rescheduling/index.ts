import { actionsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import type { Block } from '@/data/block'
import { ChangeScope, type PropertySchema } from '@/data/api'
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
  scheduleSrsProperties,
  SrsSignal,
  srsSignals,
} from './scheduler.ts'
import { srsReschedulingDataExtension } from './dataExtension.ts'
import {
  SRS_SM25_TYPE,
  type SrsReviewSnapshot,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from './schema.ts'

const shortcutKeysForSignal = (signal: SrsSignal): string[] => {
  const key = String(signal)
  return [
    `ctrl+shift+${key}`,
    `ctrl+shift+alt+cmd+${key}`,
  ]
}

const signalName = (signal: SrsSignal): string =>
  SrsSignal[signal]

const gradeForSignal = (signal: SrsSignal): number => {
  switch (signal) {
    case SrsSignal.AGAIN:
      return 0
    case SrsSignal.HARD:
      return 2
    case SrsSignal.GOOD:
      return 4
    case SrsSignal.EASY:
      return 5
    case SrsSignal.SOONER:
      return 3
  }
}

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

  if (!getBlockTypes(data).includes(SRS_SM25_TYPE)) {
    return
  }

  const now = new Date()
  const interval = readProperty(data.properties, srsIntervalProp, DEFAULT_INTERVAL)
  const factor = readProperty(data.properties, srsFactorProp, DEFAULT_FACTOR)
  const reviewCount = readProperty(data.properties, srsReviewCountProp, 0)
  const history = readProperty(data.properties, srsSnapshotHistoryProp, [])
  const grade = gradeForSignal(signal)
  const scheduled = scheduleSrsProperties({interval, factor}, signal, {now})
  const nextReviewDaily = await getOrCreateDailyNote(
    block.repo,
    data.workspaceId,
    formatIsoDate(scheduled.nextReviewDate),
  )
  const reviewedDaily = await getOrCreateDailyNote(
    block.repo,
    data.workspaceId,
    formatIsoDate(now),
  )
  const nextReviewCount = reviewCount + 1
  const snapshot: SrsReviewSnapshot = {
    reviewedAt: reviewedDaily.id,
    grade,
    interval: scheduled.interval,
    factor: scheduled.factor,
    reviewCount: nextReviewCount,
  }

  await block.repo.tx(async tx => {
    const row = await tx.get(block.id)
    if (!row) return
    await tx.update(block.id, {
      properties: {
        ...row.properties,
        [srsIntervalProp.name]: srsIntervalProp.codec.encode(scheduled.interval),
        [srsFactorProp.name]: srsFactorProp.codec.encode(scheduled.factor),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(nextReviewDaily.id),
        [srsReviewCountProp.name]: srsReviewCountProp.codec.encode(nextReviewCount),
        [srsGradeProp.name]: srsGradeProp.codec.encode(grade),
        [srsSnapshotHistoryProp.name]: srsSnapshotHistoryProp.codec.encode([...history, snapshot]),
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: 'srs reschedule'})
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
  srsReschedulingActions.map(action =>
    actionsFacet.of(action, {source: 'srs-rescheduling'}),
  ),
]

export { srsReschedulingDataExtension } from './dataExtension.ts'
export {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
  srsSm25Type,
} from './schema.ts'
