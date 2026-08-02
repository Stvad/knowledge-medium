/**
 * The tutorial's prominent entry point.
 *
 * Until now the only ways in were a plain `[[Tutorial]]` bullet seeded onto
 * the first daily note (which scrolls away with everything else the user
 * writes) and a command-palette action — neither of which a new user is
 * likely to find. This is a one-line card above the daily note's body.
 *
 * It does NOT reimplement the tutorial entry: clicking it dispatches the
 * existing `onboarding.insert_tutorial` action, which seeds-or-finds the
 * Tutorial page and navigates to it.
 *
 * Dismissible, and self-dismissing once opened — a nudge that outlives its
 * usefulness is worse than no nudge at all.
 */
import { GraduationCap, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button.js'
import { useRepo } from '@/context/repo.js'
import type { BlockHeaderContribution } from '@/extensions/blockInteraction.js'
import { isFocalRender } from '@/hooks/useIsFocalRender.js'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'
import { openTutorialInActiveWorkspace } from './action.ts'
import { dismissTutorialBanner, isTutorialBannerDismissed } from './bannerDismissal.ts'

export const TutorialBanner = () => {
  const repo = useRepo()
  const [dismissed, setDismissed] = useState(isTutorialBannerDismissed)
  if (dismissed) return null

  const dismiss = () => {
    dismissTutorialBanner()
    setDismissed(true)
  }

  const openTutorial = () => {
    // Hide immediately but do NOT persist yet: opening navigates away, so
    // waiting would leave the card on screen through the transition, while
    // persisting up front would burn the only prominent route in even when
    // nothing opened. Persist once the tutorial is genuinely on screen;
    // restore the banner if it isn't.
    //
    // Calls the shared helper rather than dispatching the action: the action
    // reports its own failures as toasts and then returns normally, so a
    // dispatch resolves "successfully" even when no tutorial opened — which
    // would permanently dismiss the banner on exactly the failures the user
    // most needs a retry route for.
    setDismissed(true)
    void openTutorialInActiveWorkspace(repo)
      .then(opened => (opened ? dismissTutorialBanner() : setDismissed(false)))
  }

  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
      <GraduationCap className="h-5 w-5 shrink-0 text-primary"/>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">New here? Start with the tutorial</div>
        <div className="text-xs text-muted-foreground">
          A short guided tour of blocks, links and search.
        </div>
      </div>
      <Button type="button" size="sm" className="shrink-0" onClick={openTutorial}>
        Open tutorial
      </Button>
      <button
        type="button"
        aria-label="Dismiss tutorial prompt"
        className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
        onClick={dismiss}
      >
        <X className="h-4 w-4"/>
      </button>
    </div>
  )
}

/**
 * Show the banner only above the daily note the app actually lands on.
 * `isFocalRender` (rather than a bare `isTopLevel`) also keeps it out of
 * embeds and backlink entries of that same note, where it would read as a
 * duplicate of the real one.
 */
export const tutorialBannerHeader: BlockHeaderContribution = ctx =>
  isFocalRender(ctx) && ctx.types.includes(DAILY_NOTE_TYPE) ? TutorialBanner : null
