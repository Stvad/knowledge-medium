import { Check, ClipboardPaste, ClockArrowDown, Gauge, RotateCcw, Scissors, Sparkles } from 'lucide-react'
import { actionDecoratorsFacet, actionsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import type { Block } from '@/data/block'
import type { BlockContentSurfaceContribution } from '@/extensions/blockInteraction.ts'
import { blockContentSurfacePropsFacet } from '@/extensions/blockInteraction.ts'
import { ChangeScope, type PropertySchema } from '@/data/api'
import { getOrCreateDailyNote } from '@/plugins/daily-notes'
import { getBlockTypes } from '@/data/properties.ts'
import { formatIsoDate } from '@/utils/dailyPage'
import { showSuccess } from '@/utils/toast.ts'
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
import { moveSrsState } from './moveSrsState.ts'
import {
  clearSrsClipboard,
  getSrsClipboard,
  setSrsClipboard,
} from './srsClipboard.ts'
import { srsDateShiftDecorators } from './dateShiftDecorator.ts'
import { srsBlockDateAdapter } from './srsBlockDateAdapter.ts'
import { srsRescheduleDecorator } from './rescheduleDecorator.ts'
import { blockDateAdapterFacet } from '@/plugins/daily-notes'
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

export interface RescheduleResult {
  signal: SrsSignal
  previousInterval: number
  newInterval: number
  nextReviewDate: Date
  previousReviewCount: number
  /** Pre-reschedule snapshot of the block's `properties` bag. Used by
   *  `undoReschedule` to restore both the SRS values and (if the block
   *  wasn't typed before) drop the type that was just added. */
  previousProperties: Record<string, unknown>
}

export const rescheduleBlock = async (
  block: Block,
  signal: SrsSignal,
): Promise<RescheduleResult | null> => {
  if (block.repo.isReadOnly) return null

  const data = block.peek() ?? await block.load()
  if (!data) return null

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

  // Captured before tx so undo restores the pre-action state even if
  // tx.update ends up merging with concurrent edits. Frozen clone so the
  // closure isn't tied to mutable repo internals.
  const previousProperties = {...data.properties}

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

  return {
    signal,
    previousInterval: interval,
    newInterval: scheduled.interval,
    nextReviewDate: scheduled.nextReviewDate,
    previousReviewCount: reviewCount,
    previousProperties,
  }
}

export const undoReschedule = async (
  block: Block,
  result: RescheduleResult,
): Promise<void> => {
  if (block.repo.isReadOnly) return
  await block.repo.tx(async tx => {
    const row = await tx.get(block.id)
    if (!row) return
    await tx.update(block.id, {properties: result.previousProperties})
  }, {scope: ChangeScope.BlockDefault, description: 'srs undo reschedule'})
}

const formatIntervalDays = (days: number): string => {
  const rounded = Math.max(1, Math.round(days))
  if (rounded < 30) return `${rounded}d`
  if (rounded < 365) return `${Math.round(rounded / 30)}mo`
  return `${Math.round(rounded / 365)}y`
}

const formatShortDate = (date: Date): string =>
  date.toLocaleString('en-US', {month: 'short', day: 'numeric'})

export const formatRescheduleToastMessage = (result: RescheduleResult): string => {
  const name = signalName(result.signal)
  const next = formatIntervalDays(result.newInterval)
  const when = formatShortDate(result.nextReviewDate)
  if (result.previousReviewCount > 0) {
    const prev = formatIntervalDays(result.previousInterval)
    return `${name} · ${prev} → ${next} (${when})`
  }
  return `${name} · ${next} (${when})`
}

const runRescheduleWithFeedback = async (
  block: Block,
  signal: SrsSignal,
): Promise<void> => {
  const result = await rescheduleBlock(block, signal)
  if (!result) return
  showSuccess(formatRescheduleToastMessage(result), {
    action: {
      label: 'Undo',
      onClick: () => { void undoReschedule(block, result) },
    },
  })
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
      await runRescheduleWithFeedback(block, signal)
    }) as ActionConfig<T>['handler'],
    defaultBinding: {
      keys: shortcutKeysForSignal(signal),
      eventOptions: {
        preventDefault: true,
      },
    },
  }
}

const srsCutAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'srs.cut',
  description: 'SRS: Cut state',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Scissors,
  canRun: ({block}) => {
    const data = block.peek()
    return !!data && getBlockTypes(data).includes(SRS_SM25_TYPE)
  },
  handler: async ({block}: BlockShortcutDependencies) => {
    const data = block.peek() ?? await block.load()
    if (!data) return
    setSrsClipboard({
      sourceBlockId: block.id,
      sourceWorkspaceId: data.workspaceId,
    })
  },
}

const srsPasteAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'srs.paste',
  description: 'SRS: Paste state',
  context: ActionContextTypes.NORMAL_MODE,
  icon: ClipboardPaste,
  canRun: ({block}) => {
    const entry = getSrsClipboard()
    return entry !== null && entry.sourceBlockId !== block.id
  },
  handler: async ({block}: BlockShortcutDependencies) => {
    const entry = getSrsClipboard()
    if (!entry) return
    if (entry.sourceBlockId === block.id) return
    await moveSrsState(block.repo, entry.sourceBlockId, block.id)
    clearSrsClipboard()
  },
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
  srsCutAction,
  srsPasteAction,
]

// SOONER is intentionally omitted from the swipe strip — the
// keyboard shortcut and command-palette entry remain for power users.
const srsQuickActionItems = srsSignals
  .filter(signal => signal !== SrsSignal.SOONER)
  .map(signal => ({
    actionId: `srs.reschedule.${signalName(signal).toLowerCase()}`,
    label: signalName(signal),
    row: 2 as const,
  }))

// Overflow keeps them out of the primary strip — these are rarer than
// reschedule. Visibility (cut only on SRS blocks; paste only when
// something is stashed and the target isn't the same block) is gated by
// the `canRun` predicate on the actions themselves, so the same gating
// applies to the command palette.
const srsCutQuickAction = {
  actionId: 'srs.cut',
  label: 'Cut SRS',
  overflow: true,
}

const srsPasteQuickAction = {
  actionId: 'srs.paste',
  label: 'Paste SRS',
  overflow: true,
}

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
  quickActionItemsFacet.of(srsCutQuickAction, {source: 'srs-rescheduling'}),
  quickActionItemsFacet.of(srsPasteQuickAction, {source: 'srs-rescheduling'}),
  blockContentSurfacePropsFacet.of(srsContentSurfaceDecoration, {source: 'srs-rescheduling'}),
  srsReschedulingActions.map(action =>
    actionsFacet.of(action, {source: 'srs-rescheduling'}),
  ),
  srsDateShiftDecorators.map(decorator =>
    actionDecoratorsFacet.of(decorator, {source: 'srs-rescheduling'}),
  ),
  actionDecoratorsFacet.of(srsRescheduleDecorator, {source: 'srs-rescheduling'}),
  // Negative precedence: SRS adapter sorts before the generic reference
  // adapter so a block that is BOTH an SRS card AND has an inline date
  // reference reschedules its `srsNextReviewDateProp` rather than
  // rewriting its content (matches the dual-dispatch precedence in
  // `dateShiftDecorator.ts`).
  blockDateAdapterFacet.of(srsBlockDateAdapter, {
    source: 'srs-rescheduling',
    precedence: -1,
  }),
]

export { srsReschedulingDataExtension } from './dataExtension.ts'
export { srsBlockDateAdapter } from './srsBlockDateAdapter.ts'
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
