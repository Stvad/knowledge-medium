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
  /** Reveal a hidden answer; grade a revealed one Good. Space/Enter, so a
   *  pass through well-known cards is one key per card. */
  revealOrGradeDefault: () => void
}

/** Builds the controller from the session's live state. The gating lives
 *  here — grading is only reachable once the answer is on screen, and
 *  nothing fires while a grade write is in flight. */
export const makeSrsReviewController = ({busy, revealed, reveal, grade}: {
  busy: boolean
  revealed: boolean
  reveal: () => void
  grade: (signal: SrsSignal) => void
}): SrsReviewController => ({
  reveal: () => { if (!busy) reveal() },
  grade: signal => { if (revealed && !busy) grade(signal) },
  revealOrGradeDefault: () => {
    if (busy) return
    if (revealed) grade(SrsSignal.GOOD)
    else reveal()
  },
})

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
  // shadow typing or navigation elsewhere. The session also deactivates
  // the context when focus is inside the revealed answer's editor (the
  // dispatcher's default editable filter is bypassed here because
  // EDIT_MODE_CM opts editor events back in — see ReviewSession).
  modal: true,
  defaultEventOptions: {preventDefault: true},
  validateDependencies: isSrsReviewDependencies,
}

// Index-signature contexts type handler deps as `BaseShortcutDependencies`;
// `validateDependencies` gates activation, so the cast is sound at call time.
const controllerOf = (deps: BaseShortcutDependencies): SrsReviewController =>
  (deps as SrsReviewDependencies).controller

// Id stays `srs-review.reveal` (saved keybinding overrides key on it) even
// though the action now also carries the default vote.
const revealAction: ActionConfig<typeof SRS_REVIEW_CONTEXT> = {
  id: 'srs-review.reveal',
  description: 'SRS review: Show answer / Good',
  context: SRS_REVIEW_CONTEXT,
  defaultBinding: {keys: ['Space', 'Enter']},
  handler: deps => { controllerOf(deps).revealOrGradeDefault() },
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
