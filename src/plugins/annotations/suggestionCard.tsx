/**
 * An edit suggestion's part of its card: the change as a diff, with Accept
 * and Reject while it is open, and what became of it once it is closed. The
 * card's header (`ui.tsx`) mounts it in place of the quote.
 */

import {useState, type MouseEvent} from 'react'
import type {BlockData} from '@/data/api'
import type {Repo} from '@/data/repo'
import {useRepo} from '@/context/repo.js'
import {truncate} from '@/utils/string.js'
import {showError} from '@/utils/toast.js'
import {threadIsOpen, threadStatusOf, threadSuggestionOf, type ThreadSuggestion} from './schema.ts'
import {acceptSuggestion, rejectSuggestion} from './suggestions.ts'

type RootFields = Pick<BlockData, 'content' | 'properties'>

/** Does the card show where the quote resolves now, and offer to re-anchor
 *  it? Not for a closed suggestion, which reads from its properties alone:
 *  accepting changed the text around its quote on purpose, and re-anchoring
 *  it would make it applicable a second time. */
export const showsAnchorState = (root: RootFields): boolean => threadIsOpen(root) || !threadSuggestionOf(root)

const closedAs = (root: RootFields): 'accepted' | 'rejected' | null => {
  try {
    const status = threadStatusOf(root)
    return status === 'accepted' || status === 'rejected' ? status : null
  } catch {
    return null
  }
}

const clipped = (text: string): string => truncate(text, 160)

/** Read off the properties: the anchor is not rewritten on accept, so the
 *  quote is the text the replacement took the place of. An open suggestion
 *  shows both texts whole, since Accept applies all of the replacement; a
 *  closed one, history only, is clipped. */
export const SuggestionText = ({root, suggestion: {anchor: {quote}, replacement}}: {root: RootFields; suggestion: ThreadSuggestion}) => {
  const closed = closedAs(root)
  if (closed === 'accepted') {
    return <span className="break-words">Replaced “{clipped(quote)}” with “{clipped(replacement)}”</span>
  }
  if (closed === 'rejected') {
    return <span className="break-words">Rejected replacing “{clipped(quote)}” with “{clipped(replacement)}”</span>
  }
  return (
    <span className="break-words" aria-label={`Suggested edit: replace “${quote}” with “${replacement}”`}>
      <del className="text-muted-foreground decoration-red-600/70">{quote}</del>
      {' '}
      <ins className="rounded-sm bg-sky-400/20 px-0.5 text-foreground no-underline">{replacement}</ins>
    </span>
  )
}

const reportFailure = (error: unknown): void => {
  showError(error instanceof Error ? error.message : String(error))
}

/** Accept is a click, which blurs the target's editor and so flushes its
 *  pending write ahead of the accept's transaction (`suggestions.ts`). One
 *  decision at a time: both buttons wait while one is in flight, and each
 *  transaction also refuses a suggestion that is no longer open. */
export const SuggestionActions = ({threadId}: {threadId: string}) => {
  const repo = useRepo()
  const [deciding, setDeciding] = useState(false)
  const decide = (write: (repo: Repo, threadId: string) => Promise<void>) => (event: MouseEvent) => {
    event.stopPropagation()
    setDeciding(true)
    write(repo, threadId).catch(reportFailure).finally(() => setDeciding(false))
  }
  return (
    <>
      <button
        type="button"
        disabled={deciding}
        onClick={decide(acceptSuggestion)}
        className="rounded bg-primary px-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        Accept
      </button>
      <button
        type="button"
        disabled={deciding}
        onClick={decide(rejectSuggestion)}
        className="text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
      >
        Reject
      </button>
    </>
  )
}
