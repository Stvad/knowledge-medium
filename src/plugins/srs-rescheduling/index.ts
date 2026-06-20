import { Check, ClipboardPaste, ClockArrowDown, Gauge, RotateCcw, Scissors, Sparkles } from 'lucide-react'
import { actionTransformsFacet, actionsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import type { Block } from '@/data/block'
import type { BlockContentSurfaceContribution } from '@/extensions/blockInteraction.js'
import { blockContentSurfacePropsFacet } from '@/extensions/blockInteraction.js'
import { ChangeScope, type PropertySchema } from '@/data/api'
import {
  DATE_SCRUB_CONTEXT,
  blockDateAdapterFacet,
  dailyNoteBlockId,
  getDateScrubDraft,
  getOrCreateDailyNote,
  stageDateScrubDraft,
  type DateScrubDraft,
} from '@/plugins/daily-notes'
import { getBlockTypes } from '@/data/properties.js'
import { formatIsoDate } from '@/utils/dailyPage'
import { createElement } from 'react'
import { showCustom } from '@/utils/toast.js'
import { RescheduleToast } from './RescheduleToast.tsx'
import {
  ActionConfig,
  ActionContextTypes,
  ActionIcon,
  BaseShortcutDependencies,
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

export interface SrsReschedulePlan extends RescheduleResult {
  workspaceId: string
  newFactor: number
  grade: number
  nextReviewIso: string
  reviewedIso: string
  nextReviewCount: number
  history: readonly SrsReviewSnapshot[]
}

interface SrsRescheduleBasis {
  workspaceId: string
  interval: number
  factor: number
  reviewCount: number
  history: readonly SrsReviewSnapshot[]
  scheduleFrom: Date
  reviewedIso: string
}

interface SrsScrubDraftPayload {
  plugin: 'srs-rescheduling'
  plan: SrsReschedulePlan
}

interface DateScrubDateDraftPayload {
  plugin: 'daily-notes.date-scrub'
  deltaDays: number
}

const isSrsScrubDraftPayload = (payload: unknown): payload is SrsScrubDraftPayload =>
  typeof payload === 'object' &&
  payload !== null &&
  (payload as SrsScrubDraftPayload).plugin === 'srs-rescheduling'

const isDateScrubDateDraftPayload = (payload: unknown): payload is DateScrubDateDraftPayload =>
  typeof payload === 'object' &&
  payload !== null &&
  (payload as DateScrubDateDraftPayload).plugin === 'daily-notes.date-scrub'

const scheduleFromIsoForDraft = (draft: DateScrubDraft | null): string | undefined => {
  if (!draft) return undefined
  if (isDateScrubDateDraftPayload(draft.payload) && draft.payload.deltaDays === 0) {
    return undefined
  }
  return draft.currentIso
}

const dateFromIso = (iso: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

const snapshotForPlan = (plan: SrsReschedulePlan): SrsReviewSnapshot => ({
  reviewedAt: dailyNoteBlockId(plan.workspaceId, plan.reviewedIso),
  grade: plan.grade,
  interval: plan.newInterval,
  factor: plan.newFactor,
  reviewCount: plan.nextReviewCount,
})

const basisFromPlan = (plan: SrsReschedulePlan): SrsRescheduleBasis => ({
  workspaceId: plan.workspaceId,
  interval: plan.newInterval,
  factor: plan.newFactor,
  reviewCount: plan.nextReviewCount,
  history: [...plan.history, snapshotForPlan(plan)],
  scheduleFrom: dateFromIso(plan.nextReviewIso) ?? plan.nextReviewDate,
  reviewedIso: plan.reviewedIso,
})

const basisFromBlock = async (
  block: Block,
  scheduleFromIso?: string,
): Promise<SrsRescheduleBasis | null> => {
  if (block.repo.isReadOnly) return null

  const data = block.peek() ?? await block.load()
  if (!data) return null

  const hasSrsType = getBlockTypes(data).includes(SRS_SM25_TYPE)
  const sourceProperties = hasSrsType ? data.properties : {}
  const now = new Date()
  return {
    workspaceId: data.workspaceId,
    interval: readProperty(sourceProperties, srsIntervalProp, DEFAULT_INTERVAL),
    factor: readProperty(sourceProperties, srsFactorProp, DEFAULT_FACTOR),
    reviewCount: readProperty(sourceProperties, srsReviewCountProp, 0),
    history: readProperty(sourceProperties, srsSnapshotHistoryProp, []),
    scheduleFrom: scheduleFromIso ? dateFromIso(scheduleFromIso) ?? now : now,
    reviewedIso: formatIsoDate(now),
  }
}

const planSrsRescheduleFromBasis = (
  basis: SrsRescheduleBasis,
  signal: SrsSignal,
): SrsReschedulePlan => {
  const grade = gradeForSignal(signal)
  const scheduled = scheduleSrsProperties(
    {interval: basis.interval, factor: basis.factor},
    signal,
    {now: basis.scheduleFrom},
  )
  const nextReviewCount = basis.reviewCount + 1

  return {
    signal,
    workspaceId: basis.workspaceId,
    previousInterval: basis.interval,
    newInterval: scheduled.interval,
    newFactor: scheduled.factor,
    nextReviewDate: scheduled.nextReviewDate,
    previousReviewCount: basis.reviewCount,
    grade,
    nextReviewIso: formatIsoDate(scheduled.nextReviewDate),
    reviewedIso: basis.reviewedIso,
    nextReviewCount,
    history: basis.history,
  }
}

export const planSrsReschedule = async (
  block: Block,
  signal: SrsSignal,
  options: {scheduleFromIso?: string} = {},
): Promise<SrsReschedulePlan | null> => {
  const basis = await basisFromBlock(block, options.scheduleFromIso)
  return basis ? planSrsRescheduleFromBasis(basis, signal) : null
}

export const applySrsReschedulePlan = async (
  block: Block,
  plan: SrsReschedulePlan,
): Promise<boolean> => {
  if (block.repo.isReadOnly) return false

  const nextReviewDaily = await getOrCreateDailyNote(
    block.repo,
    plan.workspaceId,
    plan.nextReviewIso,
  )
  const reviewedDaily = await getOrCreateDailyNote(
    block.repo,
    plan.workspaceId,
    plan.reviewedIso,
  )
  const snapshot: SrsReviewSnapshot = {
    ...snapshotForPlan(plan),
    reviewedAt: reviewedDaily.id,
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
        [srsIntervalProp.name]: srsIntervalProp.codec.encode(plan.newInterval),
        [srsFactorProp.name]: srsFactorProp.codec.encode(plan.newFactor),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(nextReviewDaily.id),
        [srsReviewCountProp.name]: srsReviewCountProp.codec.encode(plan.nextReviewCount),
        [srsGradeProp.name]: srsGradeProp.codec.encode(plan.grade),
        [srsSnapshotHistoryProp.name]: srsSnapshotHistoryProp.codec.encode([
          ...plan.history,
          snapshot,
        ]),
      },
    })
    written = true
  }, {scope: ChangeScope.BlockDefault, description: 'srs reschedule'})

  return written
}

export const rescheduleBlock = async (
  block: Block,
  signal: SrsSignal,
): Promise<RescheduleResult | null> => {
  const plan = await planSrsReschedule(block, signal)
  if (!plan) return null
  const written = await applySrsReschedulePlan(block, plan)
  return written ? plan : null
}

// Mirrors `scheduleSrsProperties` which uses `Math.ceil(interval)` to
// pick the next-review date — display rounding has to match or the
// toast says "7d" while the date lands 8 days out. Exported so the review
// buttons can label their next-interval estimate the same way.
export const formatIntervalDays = (days: number): string => {
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

const formatRescheduleScrubDetail = (result: RescheduleResult): string => {
  const next = formatIntervalDays(result.newInterval)
  if (result.previousReviewCount === 0) return next
  return `${formatIntervalDays(result.previousInterval)} -> ${next}`
}

const formatRescheduleScrubPreview = (result: RescheduleResult) => ({
  label: `SRS ${signalName(result.signal)}`,
  value: formatShortDate(result.nextReviewDate),
  detail: formatRescheduleScrubDetail(result),
})

const shiftPlanDate = (
  plan: SrsReschedulePlan,
  deltaDays: number,
): SrsReschedulePlan => {
  const nextReviewDate = new Date(plan.nextReviewDate)
  nextReviewDate.setDate(nextReviewDate.getDate() + deltaDays)
  return {
    ...plan,
    nextReviewDate,
    nextReviewIso: formatIsoDate(nextReviewDate),
  }
}

const createSrsScrubDraft = (
  block: Block,
  plan: SrsReschedulePlan,
): DateScrubDraft<SrsScrubDraftPayload> => ({
  id: `date-scrub.srs.reschedule.${signalName(plan.signal).toLowerCase()}`,
  currentIso: plan.nextReviewIso,
  preview: formatRescheduleScrubPreview(plan),
  payload: {
    plugin: 'srs-rescheduling',
    plan,
  },
  shiftDate: deltaDays => createSrsScrubDraft(block, shiftPlanDate(plan, deltaDays)),
  commit: async () => {
    await applySrsReschedulePlan(block, plan)
  },
})

const runRescheduleWithFeedback = async (
  block: Block,
  signal: SrsSignal,
): Promise<void> => {
  const result = await rescheduleBlock(block, signal)
  if (!result) return
  // JS is single-threaded; the entry recorded by the just-completed tx
  // is guaranteed to be the BlockDefault top right now, so peekUndo
  // gives us the txId to gate the toast's Undo button on. We also capture
  // the entry's workspaceId: undo is workspace-scoped (issue #186), so the
  // toast must track the reschedule's own workspace — `repo.undo()` only
  // reverts it while that workspace is active and it's still that
  // workspace's top. If a later tx pushes onto the stack, the toast
  // subscribes via UndoManager and disables itself rather than reverting
  // the wrong action.
  const top = block.repo.undoManager.peekUndo(ChangeScope.BlockDefault)
  if (!top) return
  const message = formatRescheduleToastMessage(result)
  showCustom(id => createElement(RescheduleToast, {
    toastId: id,
    message,
    txId: top.txId,
    workspaceId: top.workspaceId,
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

const blockFromDependencies = (deps: BaseShortcutDependencies): Block | null => {
  const block = (deps as Partial<BlockShortcutDependencies>).block
  return block && typeof block.id === 'string' ? block : null
}

const createScrubRescheduleAction = (
  signal: SrsSignal,
): ActionConfig<typeof DATE_SCRUB_CONTEXT> => {
  const name = signalName(signal)
  const id = `date-scrub.srs.reschedule.${name.toLowerCase()}`
  return {
    id,
    description: `SRS: ${name} (Date Scrub)`,
    context: DATE_SCRUB_CONTEXT,
    icon: iconForSignal(signal),
    isVisible: (deps: BaseShortcutDependencies) => {
      const block = blockFromDependencies(deps)
      const data = block?.peek()
      return !!data && getBlockTypes(data).includes(SRS_SM25_TYPE)
    },
    handler: async (deps: BaseShortcutDependencies) => {
      const block = blockFromDependencies(deps)
      if (!block) return
      const currentDraft = getDateScrubDraft(block.id)
      const currentPayload = currentDraft?.payload
      const plan = isSrsScrubDraftPayload(currentPayload)
        ? planSrsRescheduleFromBasis(basisFromPlan(currentPayload.plan), signal)
        : await planSrsReschedule(block, signal, {
          scheduleFromIso: scheduleFromIsoForDraft(currentDraft),
        })
      if (!plan) return
      stageDateScrubDraft(block.id, createSrsScrubDraft(block, plan))
    },
    defaultBinding: {
      keys: `Digit${signal}`,
      eventOptions: {
        preventDefault: true,
      },
    },
  }
}

const isSrsBlockTarget = ({block}: BlockShortcutDependencies): boolean => {
  const data = block.peek()
  return !!data && getBlockTypes(data).includes(SRS_SM25_TYPE)
}

const canPasteSrsState = ({block}: BlockShortcutDependencies): boolean => {
  const entry = getSrsClipboard()
  return entry !== null && entry.sourceBlockId !== block.id
}

const srsCutAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'srs.cut',
  description: 'SRS: Cut state',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Scissors,
  // isVisible filters the menu/palette; canDispatch is the dispatch gate. The
  // handler stashes whatever block it's given (SRS-ness lives only in these
  // predicates), so canDispatch must mirror isVisible — otherwise an imperative
  // dispatch (a stale swipe menu, a run event) could cut a non-SRS block.
  isVisible: isSrsBlockTarget,
  canDispatch: isSrsBlockTarget,
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
  isVisible: canPasteSrsState,
  canDispatch: canPasteSrsState,
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
  ...srsSignals.map(signal => createScrubRescheduleAction(signal)),
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
// the `isVisible` predicate on the actions themselves, so the same gating
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
  actionTransformsFacet.of(srsRescheduleDecorator, {source: 'srs-rescheduling'}),
  actionTransformsFacet.of(srsSwipeRightDecorator, {source: 'srs-rescheduling'}),
  srsTodoCycleDecorators.map(decorator =>
    actionTransformsFacet.of(decorator, {source: 'srs-rescheduling'}),
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
