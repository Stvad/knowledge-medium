import { useEffect, useState } from 'react'
import { useUser } from '@/components/Login.js'
import { useRepo } from '@/context/repo.js'
import { actionsFacet } from '@/extensions/core.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import {
  celebrationCycle,
  isBirthdayToday,
  isForced,
  isRecipient,
  msUntilNextLocalMidnight,
} from './gate.ts'
import { applyWolfTheme, syncWolfTheme } from './wolfTheme.ts'
import { BirthdayOverlay } from './BirthdayOverlay.tsx'

/*
  App-level mount (one instance, via appMountsFacet). Runs the gate, drives
  the pop-stack theme, and shows the dramatic overlay once per cycle. For
  everyone who isn't the recipient this is inert — the gate never matches,
  the theme sync sees no active marker, and nothing renders.

  The theme and the overlay have independent lifetimes: the theme is
  ambient for the whole day (recomputed each load + at local midnight), the
  overlay is a one-shot that the user dismisses. Dismissing the overlay
  does not revert the theme.
*/

const OVERLAY_KEY = 'birthday:overlay-shown'

/** Runtime-contribution bucket for the command-palette entry. Pushed only
 *  while the celebration is live so "Theme: Wolf" appears in the palette
 *  on the day (and nowhere else) — the way back if he switches away. */
const WOLF_ACTION_SOURCE = 'birthday.wolf-theme-action'

const wolfThemeAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'birthday.apply-wolf-theme',
  description: 'Theme: Wolf 🐺',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    applyWolfTheme()
  },
}

function readOverlayShown(): string | null {
  try {
    return window.localStorage?.getItem(OVERLAY_KEY) ?? null
  } catch {
    return null
  }
}

function markOverlayShown(cycle: string): void {
  try {
    window.localStorage?.setItem(OVERLAY_KEY, cycle)
  } catch {
    /* ignore */
  }
}

export function BirthdayCelebration() {
  const user = useUser()
  const repo = useRepo()
  const [showOverlay, setShowOverlay] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const run = async () => {
      const now = new Date()
      const cycle = celebrationCycle(now)
      const isBirthday = isBirthdayToday(now) && (await isRecipient(user.id))
      if (cancelled) return

      syncWolfTheme(isBirthday, cycle)

      // Offer "Theme: Wolf" in the command palette only while it's live,
      // so he can re-apply it after switching to another theme. Use the
      // repo (durable) API, not the raw runtime — durable contributions
      // survive a runtime swap; a transient one gets dropped.
      if (repo.facetRuntime) {
        repo.setRuntimeContributions(
          actionsFacet,
          WOLF_ACTION_SOURCE,
          isBirthday ? [wolfThemeAction] : [],
        )
      }

      if (isBirthday && (isForced() || readOverlayShown() !== cycle)) {
        markOverlayShown(cycle)
        setShowOverlay(true)
      }

      // Re-evaluate at the next local midnight so the theme activates /
      // restores even if the app is left open across the day boundary.
      timer = setTimeout(() => void run(), msUntilNextLocalMidnight(now) + 1000)
    }

    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (repo.facetRuntime) repo.setRuntimeContributions(actionsFacet, WOLF_ACTION_SOURCE, [])
    }
  }, [user.id, repo])

  if (!showOverlay) return null
  return (
    <BirthdayOverlay
      name={user.name ?? undefined}
      onClose={() => setShowOverlay(false)}
    />
  )
}
