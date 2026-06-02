import { Check, Gauge, RotateCcw, Sparkles } from 'lucide-react'
import { Block } from '@/data/block'
import type {
  ActionConfig,
  ActionContextConfig,
  ActionIcon,
  BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.js'

export const SRS_REVIEW_CONTEXT = 'srs-review'

/** Imperative hooks the active review session hands to the shortcut
 *  system as context dependencies. The session keeps the
 *  reveal/grade gating (busy, revealed) inside these so the actions
 *  stay dumb. */
export interface SrsReviewController {
  reveal: () => void
  grade: (signal: SrsSignal) => void
}

export interface SrsReviewDependencies extends BaseShortcutDependencies {
  controller: SrsReviewController
}

const isSrsReviewDependencies = (deps: unknown): deps is SrsReviewDependencies =>
  typeof deps === 'object' &&
  deps !== null &&
  'uiStateBlock' in deps &&
  (deps as {uiStateBlock: unknown}).uiStateBlock instanceof Block &&
  'controller' in deps

export const srsReviewActionContext: ActionContextConfig<typeof SRS_REVIEW_CONTEXT> = {
  type: SRS_REVIEW_CONTEXT,
  displayName: 'SRS Review',
  // Modal so the single-key reveal/grade bindings only fire while a
  // focused review session has activated this context — they never
  // shadow typing or navigation elsewhere. Editable targets are still
  // dropped by the dispatcher's default event filter, so grading keys
  // don't fire while editing the revealed answer.
  modal: true,
  defaultEventOptions: {preventDefault: true},
  validateDependencies: isSrsReviewDependencies,
}

// Index-signature contexts type handler deps as `BaseShortcutDependencies`;
// `validateDependencies` gates activation, so the cast is sound at call time.
const controllerOf = (deps: BaseShortcutDependencies): SrsReviewController =>
  (deps as SrsReviewDependencies).controller

const revealAction: ActionConfig<typeof SRS_REVIEW_CONTEXT> = {
  id: 'srs-review.reveal',
  description: 'SRS review: Show answer',
  context: SRS_REVIEW_CONTEXT,
  defaultBinding: {keys: ['Space', 'Enter']},
  handler: deps => { controllerOf(deps).reveal() },
}

interface GradeBinding {
  signal: SrsSignal
  key: string
  label: string
  icon: ActionIcon
}

// Keys are the on-screen 1–4 order (Again/Hard/Good/Easy), which doesn't
// match the SrsSignal numeric values (GOOD=4, EASY=5), so map explicitly.
const GRADE_BINDINGS: readonly GradeBinding[] = [
  {signal: SrsSignal.AGAIN, key: 'Digit1', label: 'Again', icon: RotateCcw},
  {signal: SrsSignal.HARD, key: 'Digit2', label: 'Hard', icon: Gauge},
  {signal: SrsSignal.GOOD, key: 'Digit3', label: 'Good', icon: Check},
  {signal: SrsSignal.EASY, key: 'Digit4', label: 'Easy', icon: Sparkles},
]

const gradeActions: readonly ActionConfig<typeof SRS_REVIEW_CONTEXT>[] = GRADE_BINDINGS.map(
  ({signal, key, label, icon}) => ({
    id: `srs-review.grade.${label.toLowerCase()}`,
    description: `SRS review: ${label}`,
    context: SRS_REVIEW_CONTEXT,
    icon,
    defaultBinding: {keys: key},
    handler: (deps: BaseShortcutDependencies) => { controllerOf(deps).grade(signal) },
  }),
)

export const srsReviewActions: readonly ActionConfig[] = [revealAction, ...gradeActions]
