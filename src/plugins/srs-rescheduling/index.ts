import { Check, ClipboardPaste, ClockArrowDown, Gauge, RotateCcw, Scissors, Sparkles } from 'lucide-react'
import { actionDecoratorsFacet, actionsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import type { Block } from '@/data/block'
import type { BlockContentSurfaceContribution } from '@/extensions/blockInteraction.js'
import { blockContentSurfacePropsFacet } from '@/extensions/blockInteraction.js'
import { ChangeScope, type PropertySchema } from '@/data/api'
import { getOrCreateDailyNote } from '@/plugins/daily-notes'
import { getBlockTypes } from '@/data/properties.js'
import { formatIsoDate } from '@/utils/dailyPage'
import { createElement } from 'react'
import { showCustom } from '@/utils/toast.js'
import { RescheduleToast } from './RescheduleToast.tsx'
import {
  ActionConfig,
  ActionContextTypes,
  ActionIcon,
  BlockShortcutDependencies,
} from '@/shortcuts/types.js'
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
import { srsBlockDateAdapter } from './srsBlockDateAdapter.ts'
import { srsRescheduleDecorator } from './rescheduleDecorator.ts'
import { srsSwipeRightDecorator, srsTodoCycleDecorators } from './swipeRightDecorator.ts'
import { blockDateAdapterFacet } from '@/plugins/daily-notes'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'

const shortcutKeysForSignal = (signal: SrsSignal): string[] => {
  const key = String(signal)
  // Use the Digit{n} code so the binding survives the Shift transform
  // (shift+0 → ')', shift+1 → '!', etc.) on US layouts.
  return [
    `Control+Shift+Digit${key}`,
    `Control+Shift+Alt+Meta+Digit${key}`,
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

  let written = false
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
    written = true
  }, {scope: ChangeScope.BlockDefault, description: 'srs reschedule'})

  if (!written) return null
  return {
    signal,
    previousInterval: interval,
    newInterval: scheduled.interval,
    nextReviewDate: scheduled.nextReviewDate,
    previousReviewCount: reviewCount,
  }
}

// Mirrors `scheduleSrsProperties` which uses `Math.ceil(interval)` to
// pick the next-review date — display rounding has to match or the
// toast says "7d" while the date lands 8 days out.
const formatIntervalDays = (days: number): string => {
  const ceil = Math.max(1, Math.ceil(days))
  if (ceil < 30) return `${ceil}d`
  if (ceil < 365) return `${Math.round(ceil / 30)}mo`
  return `${Math.round(ceil / 365)}y`
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
  // JS is single-threaded; the entry recorded by the just-completed tx
  // is guaranteed to be the BlockDefault top right now, so peekUndo
  // gives us the txId to gate the toast's Undo button on. If a later
  // tx pushes onto the stack, the toast subscribes via UndoManager and
  // disables itself rather than reverting the wrong action.
  const top = block.repo.undoManager.peekUndo(ChangeScope.BlockDefault)
  if (!top) return
  const message = formatRescheduleToastMessage(result)
  showCustom(id => createElement(RescheduleToast, {
    toastId: id,
    message,
    txId: top.txId,
    repo: block.repo,
  }))
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

export const srsReschedulingPlugin: AppExtension = systemToggle({
  id: 'system:srs-rescheduling',
  name: 'SRS rescheduling',
  description: 'Spaced-repetition scheduling for blocks with a next-review date.',
}).of([
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
  actionDecoratorsFacet.of(srsRescheduleDecorator, {source: 'srs-rescheduling'}),
  actionDecoratorsFacet.of(srsSwipeRightDecorator, {source: 'srs-rescheduling'}),
  srsTodoCycleDecorators.map(decorator =>
    actionDecoratorsFacet.of(decorator, {source: 'srs-rescheduling'}),
  ),
  // Negative precedence: SRS adapter sorts before the generic reference
  // adapter so a block that is BOTH an SRS card AND has an inline date
  // reference reschedules its `srsNextReviewDateProp` rather than
  // rewriting its content.
  blockDateAdapterFacet.of(srsBlockDateAdapter, {
    source: 'srs-rescheduling',
    precedence: -1,
  }),
])

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
