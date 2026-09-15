import { Check, Gauge, RotateCcw, Sparkles } from 'lucide-react'
import type { Block } from '@/data/block'
import { useProperty } from '@/hooks/block.js'
import { Button } from '@/components/ui/button.js'
import { cn } from '@/lib/utils.js'
import {
  formatIntervalDays,
  srsFactorProp,
  srsIntervalProp,
} from '@/plugins/srs-rescheduling'
import { SrsSignal, estimateSrsIntervalDays } from '@/plugins/srs-rescheduling/scheduler.js'
import { gradeButtonHint } from './keyHints.ts'

/** The review session's two hint-bearing controls. They live here rather
 *  than in ReviewSession so a test can render them against a hint map
 *  without standing up a repo, the due queries and suspense. */

interface GradeButton {
  signal: SrsSignal
  label: string
  icon: typeof Check
  className: string
}

const GRADE_BUTTONS: readonly GradeButton[] = [
  {signal: SrsSignal.AGAIN, label: 'Again', icon: RotateCcw, className: 'text-rose-600'},
  {signal: SrsSignal.HARD, label: 'Hard', icon: Gauge, className: 'text-amber-600'},
  {signal: SrsSignal.GOOD, label: 'Good', icon: Check, className: 'text-emerald-600'},
  {signal: SrsSignal.EASY, label: 'Easy', icon: Sparkles, className: 'text-sky-600'},
]

export const ShowAnswerButton = ({hint, busy, onReveal}: {
  hint: string | undefined
  busy: boolean
  onReveal: () => void
}) => (
  <Button type="button" className="w-full" onClick={onReveal} disabled={busy}>
    Show answer
    {hint && <span className="ml-2 text-xs opacity-70">{hint}</span>}
  </Button>
)

/** The four grade buttons, each labelled with the interval the card would
 *  next be scheduled for if you picked it ("1d", "4d", "2mo", …). The
 *  estimate reads the card's live interval/factor so it tracks edits made
 *  elsewhere, and uses the same formatter as the post-grade toast so the
 *  two agree. Its own component so the `useProperty` reads only run for
 *  the card on screen. */
export const GradeButtons = ({card, busy, keyHints, onGrade}: {
  card: Block
  busy: boolean
  keyHints: ReadonlyMap<string, string>
  onGrade: (signal: SrsSignal) => void
}) => {
  const [interval] = useProperty(card, srsIntervalProp)
  const [factor] = useProperty(card, srsFactorProp)
  return (
    <div className="grid grid-cols-4 gap-2">
      {GRADE_BUTTONS.map(btn => {
        const hint = gradeButtonHint(keyHints, btn.signal)
        return (
          <Button
            key={btn.label}
            type="button"
            variant="outline"
            className="flex h-auto flex-col gap-1 py-2"
            disabled={busy}
            onClick={() => onGrade(btn.signal)}
          >
            <btn.icon className={cn('h-4 w-4', btn.className)} />
            <span className="text-sm font-medium">{btn.label}</span>
            <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
              {formatIntervalDays(estimateSrsIntervalDays({interval, factor}, btn.signal))}
            </span>
            {hint && <span className="text-[10px] opacity-50">{hint}</span>}
          </Button>
        )
      })}
    </div>
  )
}
