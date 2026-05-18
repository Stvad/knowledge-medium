/**
 * PWA-shortcut and Web Share Target dispatcher.
 *
 * The manifest exposes two URL surfaces that land back in the SPA:
 *   - shortcuts and `note_taking.new_note_url` → `./?intent=new-daily-block`
 *   - share_target action                     → `./?intent=share&title=…&text=…&url=…`
 *
 * Both should drop the user into a freshly-created block on today's
 * daily note (the share-target variant pre-fills it with the shared
 * payload). We delegate to `appendTodayDailyBlockInStack` so the UX
 * matches Ctrl+Shift+N exactly — same panel placement, same focus,
 * same editing state.
 *
 * The handler runs once per page load (module-level `consumed` flag),
 * after `App.tsx` has resolved the layout session block. It clears
 * the consumed query params via `history.replaceState` so reloads
 * (or a later share that lands on the same tab) don't replay the
 * intent.
 */
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { appendTodayDailyBlockInStack } from './actions.ts'

const INTENT_PARAMS = ['intent', 'title', 'text', 'url'] as const

let consumed = false

/** Test-only: reset the module-level "already handled this load" flag. */
export const __resetAppIntentForTesting = (): void => {
  consumed = false
}

const stripIntentParams = (): void => {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  let changed = false
  for (const param of INTENT_PARAMS) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param)
      changed = true
    }
  }
  if (!changed) return
  window.history.replaceState(null, '', url.toString())
}

/** Combine the Web Share API's title/text/url fields into a single
 *  block-content string. Skips empty parts, and dedupes when the
 *  same value lands in multiple fields — Android Chrome puts a
 *  shared URL into `text` (not `url`) when the source page omits
 *  the `url` share field, so naive concatenation would emit it
 *  twice. Joins with newlines; the block editor handles multi-line
 *  content. */
export const formatSharedContent = (
  title: string | null,
  text: string | null,
  url: string | null,
): string => {
  const parts: string[] = []
  const seen = new Set<string>()
  const push = (value: string | null) => {
    if (!value) return
    if (seen.has(value)) return
    seen.add(value)
    parts.push(value)
  }
  push(title)
  push(text)
  push(url)
  return parts.join('\n')
}

export const consumeAppIntent = async (
  repo: Repo,
  layoutSessionBlock: Block,
): Promise<void> => {
  if (consumed) return
  if (typeof window === 'undefined') return

  const params = new URLSearchParams(window.location.search)
  const intent = params.get('intent')
  const title = params.get('title')
  const text = params.get('text')
  const sharedUrl = params.get('url')
  const hasShareFields = title !== null || text !== null || sharedUrl !== null

  const isShare = intent === 'share' || hasShareFields
  const isNewBlock = intent === 'new-daily-block'
  if (!isShare && !isNewBlock) return

  // Mark consumed and strip params BEFORE awaiting any work, so a
  // re-entrant call (e.g. React strict-mode double-invoke of the
  // bootstrap effect) doesn't dispatch the intent twice.
  consumed = true
  stripIntentParams()

  if (isShare) {
    const content = formatSharedContent(title, text, sharedUrl)
    await appendTodayDailyBlockInStack(repo, layoutSessionBlock, {content})
    return
  }

  await appendTodayDailyBlockInStack(repo, layoutSessionBlock)
}
