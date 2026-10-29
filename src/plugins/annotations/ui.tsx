/**
 * The slice-1 comments UI on ordinary outline blocks:
 *
 * - a comment pill in the gutter, after the reference pill, on every
 *   non-nested surface, the focal block included (nothing else shows a focal
 *   block's comments);
 * - its inline expansion under the block, holding the composer and a card per
 *   thread;
 * - each card renders the thread root through `BlockComponent` in a nested
 *   surface, so comments are ordinary editable blocks. The root's own line is
 *   the card header (`ThreadRootContent`), and each comment gets Reply and
 *   Delete (`CommentActions`).
 */

import {useEffect, useRef, useState, type ReactNode} from 'react'
import {MessageSquare} from 'lucide-react'
import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import {useUIStateBlock} from '@/data/globalState.js'
import {editorSelection, focusBlock, requestEditorFocus} from '@/data/properties.js'
import {BlockComponent} from '@/components/BlockComponent.js'
import {NestedBlockContextProvider, useBlockContext} from '@/context/block.js'
import {useRepo} from '@/context/repo.js'
import {useHandle, useWorkspaceId} from '@/hooks/block.js'
import {
  cachedContentDecorator,
  type BlockChildrenFooterContribution,
  type BlockContentDecoratorContribution,
  type BlockContextMenuItemsContribution,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import {defineVariant, type VariantContribution} from '@/facets/variantFacet.js'
import {CONTRIBUTOR_CARD_MODE_KEY} from '@/plugins/contributors/ContributorBadges.js'
import type {BlockRenderer} from '@/types.js'
import {useOpenBlock} from '@/utils/navigation.js'
import {surfaceRenderScopeId} from '@/utils/renderScope.js'
import {showError} from '@/utils/toast.js'
import {resolveAnchor} from './anchor.ts'
import {submitComposer} from './actions.ts'
import {deleteCommentFromCard} from './deleteComment.ts'
import {
  THREAD_TYPE,
  threadAnchorOf,
  threadIsOpen,
  threadTargetIdOf,
  type ThreadAnchor,
} from './schema.ts'
import {countsInPill, THREADS_FOR_BLOCK_QUERY, type ThreadSummary} from './summaries.ts'
import {replyTo, setThreadStatus} from './threads.ts'
import {
  closeComposer,
  openComposer,
  toggleShowResolved,
  toggleThreadsExpanded,
  updateComposer,
  useComposer,
  useShowResolved,
  useThreadsExpanded,
  type ComposerState,
} from './uiStore.ts'

/** Set on a card's nested surface; read by the root's header renderer and by
 *  the per-comment actions. */
export const COMMENT_CARD_KEY = 'annotations.commentCard'

const NO_THREADS: readonly ThreadSummary[] = Object.freeze([])

const appliesToOutlineBlock = (ctx: BlockResolveContext): boolean => !ctx.blockContext?.isNestedSurface

const useThreadSummaries = (block: Block): readonly ThreadSummary[] => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  return useHandle(
    block.repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId, id: block.id}),
    {selector: threads => threads ?? NO_THREADS},
  )
}

// ──── Pill ────

const CommentPill = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const threads = useThreadSummaries(block)
  const expanded = useThreadsExpanded(block.id)
  const hasOpen = threads.some(thread => thread.open)
  // A block whose open threads are all pure highlights still gets an
  // unnumbered pill, so its threads stay reachable.
  const count = threads.filter(countsInPill).length
  const label = count > 0 ? `${count} open comment thread${count === 1 ? '' : 's'}` : 'Comments'
  return (
    <div className="flex w-full items-start gap-1">
      <div className="min-w-0 flex-1"><Inner block={block}/></div>
      {(hasOpen || expanded) && (
        <button
          type="button"
          onClick={event => { event.stopPropagation(); toggleThreadsExpanded(block.id) }}
          aria-expanded={expanded}
          aria-label={label}
          title={label}
          className={`mt-0.5 inline-flex h-4 shrink-0 select-none items-center gap-0.5 rounded-full px-1 text-xs leading-none tabular-nums transition-colors ${
            expanded
              ? 'bg-accent text-accent-foreground'
              : 'bg-amber-100 text-amber-900 hover:bg-accent hover:text-accent-foreground dark:bg-amber-900/40 dark:text-amber-100'
          }`}
        >
          <MessageSquare className="h-3 w-3" aria-hidden/>
          {count > 0 && count}
        </button>
      )}
    </div>
  )
}

const decoratePill = cachedContentDecorator(CommentPill, 'WithCommentPill')

export const commentPillContribution: BlockContentDecoratorContribution = ctx =>
  appliesToOutlineBlock(ctx) ? decoratePill : null

// ──── Inline expansion ────

const QuoteText = ({anchor}: {anchor: ThreadAnchor}) =>
  anchor.kind === 'block'
    ? <span className="italic">whole block</span>
    : <span className="break-words">“{anchor.quote.length > 160 ? `${anchor.quote.slice(0, 160)}…` : anchor.quote}”</span>

const Composer = ({block, composer}: {block: Block; composer: ComposerState}) => {
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  // A frame late, on open and on re-aim: a menu that opened the composer
  // returns focus to its trigger as it closes.
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [composer.anchor])
  const submit = async () => {
    setBusy(true)
    try {
      await submitComposer(block.repo, block.id)
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="min-w-0 space-y-1 rounded border bg-background p-2" data-testid="comment-composer">
      <div className="text-xs text-muted-foreground">
        Comment on <QuoteText anchor={composer.anchor ? {kind: 'range', ...composer.anchor} : {kind: 'block'}}/>
      </div>
      <textarea
        ref={input}
        aria-label="New comment"
        rows={2}
        value={composer.draft}
        onChange={event => updateComposer(block.id, {draft: event.target.value, error: null})}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            closeComposer(block.id)
          }
        }}
        className="w-full resize-y rounded border bg-background px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {composer.error && <p role="alert" className="text-xs text-destructive">{composer.error}</p>}
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          disabled={busy || composer.draft.trim() === ''}
          onClick={() => void submit()}
          className="rounded bg-primary px-2 py-0.5 text-primary-foreground disabled:opacity-50"
        >
          Comment
        </button>
        <button type="button" onClick={() => closeComposer(block.id)} className="px-1 text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  )
}

const ThreadCard = ({thread}: {thread: ThreadSummary}) => {
  const parent = useBlockContext()
  const renderScopeId = surfaceRenderScopeId('comments', parent.renderScopeId ?? '', thread.id)
  return (
    <div className="rounded border bg-background px-1 py-0.5" data-testid="comment-thread">
      <NestedBlockContextProvider overrides={{
        isNestedSurface: true,
        layoutBoundary: false,
        renderScopeId,
        scopeRootId: thread.id,
        [COMMENT_CARD_KEY]: true,
        [CONTRIBUTOR_CARD_MODE_KEY]: true,
      }}>
        <BlockComponent blockId={thread.id}/>
      </NestedBlockContextProvider>
    </div>
  )
}

const ThreadsSection = ({block}: {block: Block}) => {
  const threads = useThreadSummaries(block)
  const composer = useComposer(block.id)
  const showResolved = useShowResolved(block.id)
  const open = threads.filter(thread => thread.open)
  const closed = threads.filter(thread => !thread.open)
  return (
    <section aria-label="Comments" className="my-1 ml-6 min-w-0 space-y-1.5 rounded-md border border-dashed p-1.5">
      {composer && <Composer block={block} composer={composer}/>}
      {open.map(thread => <ThreadCard key={thread.id} thread={thread}/>)}
      {!composer && open.length === 0 && closed.length === 0 && (
        <p className="px-1 text-xs text-muted-foreground">No comments.</p>
      )}
      {closed.length > 0 && (
        <button type="button" onClick={() => toggleShowResolved(block.id)} className="px-1 text-xs text-muted-foreground hover:text-foreground">
          {showResolved ? 'Hide' : 'Show'} {closed.length} resolved
        </button>
      )}
      {showResolved && closed.map(thread => <ThreadCard key={thread.id} thread={thread}/>)}
    </section>
  )
}

export const commentsFooterContribution: BlockChildrenFooterContribution = ctx => {
  if (!appliesToOutlineBlock(ctx)) return null
  const Section: BlockRenderer = ({block}) => (useThreadsExpanded(block.id) ? <ThreadsSection block={block}/> : null)
  Section.displayName = 'InlineCommentThreads'
  return Section
}

// ──── The thread root's line ────

const useFocusNewComment = () => {
  const uiStateBlock = useUIStateBlock()
  const {renderScopeId} = useBlockContext()
  return async (id: string) => {
    await focusBlock(uiStateBlock, id, {edit: !uiStateBlock.repo.isReadOnly, renderScopeId})
    await uiStateBlock.set(editorSelection, {blockId: id, start: 0})
    requestEditorFocus(uiStateBlock)
  }
}

const ActionButton = ({onClick, children}: {onClick: () => void; children: ReactNode}) => (
  <button
    type="button"
    onClick={event => { event.stopPropagation(); onClick() }}
    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
  >
    {children}
  </button>
)

type AnchorState = 'exact' | 'moved' | 'stale' | 'deleted'

const ANCHOR_BADGES: Record<Exclude<AnchorState, 'exact'>, string> = {
  moved: 'text around it changed',
  stale: 'quoted text changed',
  deleted: 'on a deleted block',
}

const useAnchorState = (root: BlockData): AnchorState => {
  const repo = useRepo()
  const targetId = threadTargetIdOf(root) ?? ''
  const targetContent = useHandle(repo.block(targetId), {selector: data => data && !data.deleted ? data.content : null})
  if (targetContent === null) return 'deleted'
  const anchor = threadAnchorOf(root)
  return anchor.kind === 'block' ? 'exact' : resolveAnchor(targetContent, anchor).state
}

const TargetLink = ({targetId, workspaceId}: {targetId: string; workspaceId: string}) => {
  const repo = useRepo()
  const excerpt = useHandle(repo.block(targetId), {selector: data => data?.content.split('\n')[0].slice(0, 80) ?? ''})
  const open = useOpenBlock({blockId: targetId, workspaceId})
  return (
    <a href="#" onClick={event => { event.stopPropagation(); open(event) }} className="underline decoration-dotted">
      {excerpt || 'a block'}
    </a>
  )
}

const ThreadRootContent: BlockRenderer = ({block}) => {
  const root = useHandle(block, {selector: data => data})
  const {[COMMENT_CARD_KEY]: inCard} = useBlockContext()
  const focusNewComment = useFocusNewComment()
  if (!root) return null
  return inCard === true
    ? <ThreadHeader root={root} onReply={async () => focusNewComment(await replyTo(block.repo, block.id))}/>
    : <ThreadElsewhere root={root}/>
}

const ThreadHeader = ({root, onReply}: {root: BlockData; onReply: () => Promise<void>}) => {
  const repo = useRepo()
  const state = useAnchorState(root)
  const open = threadIsOpen(root)
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="min-w-0 flex-1 text-muted-foreground"><QuoteText anchor={threadAnchorOf(root)}/></span>
      {state !== 'exact' && (
        <span className="rounded bg-muted px-1 text-xs text-muted-foreground">{ANCHOR_BADGES[state]}</span>
      )}
      <ActionButton onClick={() => void onReply()}>Reply</ActionButton>
      <ActionButton onClick={() => void setThreadStatus(repo, root.id, open ? 'resolved' : 'open')}>
        {open ? 'Resolve' : 'Reopen'}
      </ActionButton>
    </div>
  )
}

/** On the container page, in search results and anywhere else a root shows
 *  outside a card: which block it is on, and what it quotes. */
const ThreadElsewhere = ({root}: {root: BlockData}) => {
  const targetId = threadTargetIdOf(root)
  return (
    <div className="text-sm text-muted-foreground">
      <span>on </span>
      {targetId ? <TargetLink targetId={targetId} workspaceId={root.workspaceId}/> : <span>a missing block</span>}
      <span> · </span>
      <QuoteText anchor={threadAnchorOf(root)}/>
    </div>
  )
}

/** The root's content is display-only: editing it would move the anchor. */
export const threadRootContentContribution: VariantContribution<BlockResolveContext, BlockRenderer> = ctx =>
  ctx.types.includes(THREAD_TYPE) ? defineVariant('annotations.thread-root', 'Comment thread', ThreadRootContent) : null

// ──── Per-comment actions ────

const CommentActions = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const focusNewComment = useFocusNewComment()
  return (
    <div className="w-full">
      <Inner block={block}/>
      <div className="flex gap-2 pb-0.5">
        <ActionButton onClick={() => void replyTo(block.repo, block.id).then(focusNewComment)}>Reply</ActionButton>
        <ActionButton onClick={() => void deleteCommentFromCard(block)}>Delete</ActionButton>
      </div>
    </div>
  )
}

const decorateComment = cachedContentDecorator(CommentActions, 'WithCommentActions')

export const commentActionsContribution: BlockContentDecoratorContribution = ctx =>
  ctx.blockContext?.[COMMENT_CARD_KEY] === true && !ctx.types.includes(THREAD_TYPE) ? decorateComment : null

// ──── Bullet menu ────

export const commentContextMenuItem: BlockContextMenuItemsContribution = ({block}) => ({
  id: 'annotations.comment',
  label: 'Comment',
  icon: MessageSquare,
  onSelect: () => openComposer(block.id, null),
})
