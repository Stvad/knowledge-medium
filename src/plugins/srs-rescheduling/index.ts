import { Check, ClockArrowDown, Gauge, RotateCcw, Sparkles } from 'lucide-react'
import { actionsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import type { Block } from '@/data/block'
import type { BlockContentSurfaceContribution } from '@/extensions/blockInteraction.ts'
import { blockContentSurfacePropsFacet } from '@/extensions/blockInteraction.ts'
import { ChangeScope, type PropertySchema } from '@/data/api'
import { getOrCreateDailyNote } from '@/plugins/daily-notes'
import { getBlockTypes } from '@/data/properties.ts'
import { formatIsoDate } from '@/utils/dailyPage'
import {
  ActionConfig,
  ActionContextTypes,
  ActionIcon,
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
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from './schema.ts'
import { srsBarClass, srsIndicatorTitle } from './indicator.ts'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'

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

const iconForSignal = (signal: SrsSignal): ActionIcon => {
  switch (signal) {
    case SrsSignal.AGAIN:
      return RotateCcw
    case SrsSignal.HARD:
      return Gauge
    case SrsSignal.GOOD:
      return Check
    case SrsSignal.EASY:
      return Sparkles
    case SrsSignal.SOONER:
      return ClockArrowDown
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

  const hasSrsType = getBlockTypes(data).includes(SRS_SM25_TYPE)
  const sourceProperties = hasSrsType ? data.properties : {}

  const now = new Date()
  const interval = readProperty(sourceProperties, srsIntervalProp, DEFAULT_INTERVAL)
  const factor = readProperty(sourceProperties, srsFactorProp, DEFAULT_FACTOR)
  const reviewCount = readProperty(sourceProperties, srsReviewCountProp, 0)
  const history = readProperty(sourceProperties, srsSnapshotHistoryProp, [])
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
  const typeSnapshot = block.repo.snapshotTypeRegistries()

  await block.repo.tx(async tx => {
    let row = await tx.get(block.id)
    if (!row) return
    if (!getBlockTypes(row).includes(SRS_SM25_TYPE)) {
      await block.repo.addTypeInTx(tx, block.id, SRS_SM25_TYPE, {}, typeSnapshot)
      row = await tx.get(block.id)
      if (!row) return
    }
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
    icon: iconForSignal(signal),
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

const srsQuickActionItems = srsSignals.map(signal => ({
  actionId: `srs.reschedule.${signalName(signal).toLowerCase()}`,
  label: signalName(signal),
  row: 2 as const,
}))

const srsContentSurfaceDecoration: BlockContentSurfaceContribution = ({block}) => {
  const data = block.peek()
  if (!data || !getBlockTypes(data).includes(SRS_SM25_TYPE)) return null
  const indicatorState = {
    interval: readProperty(data.properties, srsIntervalProp, DEFAULT_INTERVAL),
    factor: readProperty(data.properties, srsFactorProp, DEFAULT_FACTOR),
    reviewCount: readProperty(data.properties, srsReviewCountProp, 0),
    archived: readProperty(data.properties, srsArchivedProp, false),
  }
  return {
    className: srsBarClass(indicatorState),
    title: srsIndicatorTitle(indicatorState),
  }
}

export const srsReschedulingPlugin: AppExtension = [
  srsReschedulingDataExtension,
  srsQuickActionItems.map(item =>
    quickActionItemsFacet.of(item, {source: 'srs-rescheduling'}),
  ),
  blockContentSurfacePropsFacet.of(srsContentSurfaceDecoration, {source: 'srs-rescheduling'}),
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
