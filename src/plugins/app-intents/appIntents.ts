/**
 * PWA-shortcut and Web Share Target dispatcher.
 *
 * The manifest exposes URL surfaces that land back in the SPA:
 *   - shortcuts                  → `./?intent=new-daily-block`
 *                                 `./?intent=open-picker`
 *                                 `./?intent=quick-find`
 *   - share_target action        → `./?intent=share&title=…&text=…&url=…`
 *   - note_taking.new_note_url   → `./?intent=new-daily-block`
 *
 * `new-daily-block` and `share` drop the user into a freshly-created
 * block on today's daily note (the share-target variant pre-fills
 * it with the shared payload); we delegate to
 * `appendTodayDailyBlockInStack` so the UX matches Ctrl+Shift+N
 * exactly. `open-picker` and `quick-find` just fire the same global
 * events the matching keyboard actions / header buttons do, so the
 * launcher entry points are 1:1 with the in-app affordances.
 *
 * The dispatcher runs once per page load (module-level `consumed`
 * flag), fired by `appIntentsBootstrapEffect` once the workspace's
 * UI-state and layout-session blocks are resolvable. It strips the
 * consumed query params via `history.replaceState` so reloads (or a
 * later share landing on the same tab) don't replay the intent.
 *
 * Lives in its own plugin (rather than inside daily-notes) because
 * the intent surface is a property of the app shell, not of daily
 * notes — when future intents resolve to a different target
 * (e.g. an "open last panel" or a tag-quick-add flow) they can grow
 * here without daily-notes owning them all.
 */
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import {
  appendTodayDailyBlockInStack,
  openDailyNotePicker,
} from '@/plugins/daily-notes'
import { toggleQuickFindEvent } from '@/plugins/quick-find'

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
  const isOpenPicker = intent === 'open-picker'
  const isQuickFind = intent === 'quick-find'
  if (!isShare && !isNewBlock && !isOpenPicker && !isQuickFind) return

  // Flip the module-level guard BEFORE awaiting so a re-entrant
  // call (e.g. React strict-mode double-invoke of the bootstrap
  // effect) doesn't dispatch the same intent twice. We do NOT
  // strip the URL params here — that has to wait until we know
  // the dispatch actually produced a block, otherwise a no-op
  // (read-only mode, missing workspace) or a thrown mutator would
  // silently drop the shared payload with no way to recover.
  consumed = true

  // UI-only intents — fire-and-forget window events that the
  // matching app mounts listen for. No data to lose, so we strip
  // the URL params unconditionally.
  if (isOpenPicker) {
    openDailyNotePicker()
    stripIntentParams()
    return
  }
  if (isQuickFind) {
    window.dispatchEvent(new CustomEvent(toggleQuickFindEvent))
    stripIntentParams()
    return
  }

  const dispatched = isShare
    ? await appendTodayDailyBlockInStack(repo, layoutSessionBlock, {
      content: formatSharedContent(title, text, sharedUrl),
    })
    : await appendTodayDailyBlockInStack(repo, layoutSessionBlock)

  // Only strip on a successful dispatch. On no-op, leave the
  // params so a reload (which resets `consumed`) can retry once
  // the read-only / no-workspace condition has been resolved.
  if (dispatched !== null) stripIntentParams()
}
