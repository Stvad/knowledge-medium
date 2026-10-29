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

import {useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode} from 'react'
import {MessageSquare} from 'lucide-react'
import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import type {Repo} from '@/data/repo'
import {useInEditMode, useUIStateBlock} from '@/data/globalState.js'
import {exitEditModeForBlock} from '@/data/properties.js'
import {BlockComponent} from '@/components/BlockComponent.js'
import {NestedBlockContextProvider, useBlockContext} from '@/context/block.js'
import {useRepo} from '@/context/repo.js'
import {useHandle, useWorkspaceId} from '@/hooks/block.js'
import {
  cachedContentDecorator,
  enterEditModeForBlock,
  type BlockChildrenFooterContribution,
  type BlockContentDecoratorContribution,
  type BlockContextMenuItemsContribution,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import {defineVariant, type VariantContribution} from '@/facets/variantFacet.js'
import {CONTRIBUTOR_CARD_MODE_KEY} from '@/plugins/contributors/ContributorBadges.js'
import type {BlockRenderer} from '@/types.js'
import {GutterPill} from '@/components/GutterPill.js'
import {ReferenceLink} from '@/components/references/ReferenceLink.js'
import {isImeKeyEvent} from '@/shortcuts/utils.js'
import {surfaceRenderScopeId} from '@/utils/renderScope.js'
import {firstLine, truncate} from '@/utils/string.js'
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
import {pillCount, THREADS_FOR_BLOCK_QUERY, type ThreadSummary} from './summaries.ts'
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
  viewKey,
  type ComposerState,
} from './uiStore.ts'

/** Set to the thread id on a card's nested surface; read by the root's header
 *  renderer and by the per-comment actions. */
export const COMMENT_CARD_KEY = 'annotations.commentCard'

/** Inside a thread's card, and not inside a nested surface within it: block
 *  context is inherited, but every nested surface (an embed in a comment, say)
 *  resets the scope root, so the card's blocks are those whose scope root is
 *  the thread the card was opened for. */
const inCard = (blockContext: Record<string, unknown> | undefined): boolean =>
  typeof blockContext?.[COMMENT_CARD_KEY] === 'string' && blockContext[COMMENT_CARD_KEY] === blockContext.scopeRootId

const useReadOnly = (repo: Repo): boolean =>
  useSyncExternalStore(useCallback(onChange => repo.onReadOnlyChange(onChange), [repo]), () => repo.isReadOnly)

const reportFailure = (error: unknown): void => {
  showError(error instanceof Error ? error.message : String(error))
}

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
  const key = viewKey(useBlockContext().renderScopeId, block.id)
  const expanded = useThreadsExpanded(key)
  const count = pillCount(threads)
  const label = count ? `${count} open comment thread${count === 1 ? '' : 's'}` : 'Comments'
  return (
    <div className="flex w-full items-start gap-1">
      <div className="min-w-0 flex-1"><Inner block={block}/></div>
      {(count !== null || expanded) && (
        <GutterPill
          count={count}
          expanded={expanded}
          onClick={event => { event.stopPropagation(); toggleThreadsExpanded(key) }}
          label={label}
          icon={MessageSquare}
          tone="amber"
        />
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
    : <span className="break-words">“{truncate(anchor.quote, 160)}”</span>

const Composer = ({block, composerKey, composer}: {block: Block; composerKey: string; composer: ComposerState}) => {
  const input = useRef<HTMLTextAreaElement>(null)
  // A frame late, on open and on re-aim: a menu that opened the composer
  // returns focus to its trigger as it closes.
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [composer.anchor])
  const submit = async () => {
    try {
      await submitComposer(block.repo, composerKey)
    } catch (error) {
      reportFailure(error)
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
        readOnly={composer.submitting}
        value={composer.draft}
        onChange={event => updateComposer(composerKey, {draft: event.target.value, error: null})}
        onKeyDown={event => {
          event.stopPropagation()
          // Escape and Enter belong to an IME composition while one is open.
          if (isImeKeyEvent(event.nativeEvent)) return
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            closeComposer(composerKey)
          }
        }}
        className="w-full resize-y rounded border bg-background px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {composer.error && <p role="alert" className="text-xs text-destructive">{composer.error}</p>}
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          disabled={composer.submitting || composer.draft.trim() === ''}
          onClick={() => void submit()}
          className="rounded bg-primary px-2 py-0.5 text-primary-foreground disabled:opacity-50"
        >
          Comment
        </button>
        <button type="button" onClick={() => closeComposer(composerKey)} className="px-1 text-muted-foreground hover:text-foreground">
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
        [COMMENT_CARD_KEY]: thread.id,
        [CONTRIBUTOR_CARD_MODE_KEY]: thread.id,
      }}>
        <BlockComponent blockId={thread.id}/>
      </NestedBlockContextProvider>
    </div>
  )
}

const ThreadsSection = ({block}: {block: Block}) => {
  const threads = useThreadSummaries(block)
  const key = viewKey(useBlockContext().renderScopeId, block.id)
  const composer = useComposer(key)
  const showResolved = useShowResolved(key)
  const open = threads.filter(thread => thread.open)
  const closed = threads.filter(thread => !thread.open)
  return (
    <section aria-label="Comments" className="my-1 ml-6 min-w-0 space-y-1.5 rounded-md border border-dashed p-1.5">
      {composer && <Composer block={block} composerKey={key} composer={composer}/>}
      {open.map(thread => <ThreadCard key={thread.id} thread={thread}/>)}
      {!composer && open.length === 0 && closed.length === 0 && (
        <p className="px-1 text-xs text-muted-foreground">No comments.</p>
      )}
      {closed.length > 0 && (
        <button type="button" onClick={() => toggleShowResolved(key)} className="px-1 text-xs text-muted-foreground hover:text-foreground">
          {showResolved ? 'Hide' : 'Show'} {closed.length} resolved
        </button>
      )}
      {showResolved && closed.map(thread => <ThreadCard key={thread.id} thread={thread}/>)}
    </section>
  )
}

export const commentsFooterContribution: BlockChildrenFooterContribution = ctx => {
  if (!appliesToOutlineBlock(ctx)) return null
  const Section: BlockRenderer = ({block}) =>
    useThreadsExpanded(viewKey(useBlockContext().renderScopeId, block.id)) ? <ThreadsSection block={block}/> : null
  Section.displayName = 'InlineCommentThreads'
  return Section
}

// ──── The thread root's line ────

const useFocusNewComment = () => {
  const uiStateBlock = useUIStateBlock()
  const {renderScopeId} = useBlockContext()
  return (id: string) => enterEditModeForBlock(uiStateBlock.repo.block(id), uiStateBlock, renderScopeId, {start: 0})
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

const useAnchorState = (root: RootFields): AnchorState => {
  const repo = useRepo()
  const targetId = threadTargetIdOf(root) ?? ''
  const targetContent = useHandle(repo.block(targetId), {selector: data => data && !data.deleted ? data.content : null})
  if (targetContent === null) return 'deleted'
  const anchor = threadAnchorOf(root)
  return anchor.kind === 'block' ? 'exact' : resolveAnchor(targetContent, anchor).state
}

const TargetLink = ({targetId}: {targetId: string}) => {
  const repo = useRepo()
  const target = repo.block(targetId)
  const excerpt = useHandle(target, {selector: data => truncate(firstLine(data?.content ?? ''), 80)})
  return <ReferenceLink block={target}>{excerpt || 'a block'}</ReferenceLink>
}

const ThreadRootContent: BlockRenderer = ({block}) => {
  const root = useHandle(block, {selector: data => data && {
    id: data.id, workspaceId: data.workspaceId, content: data.content, properties: data.properties,
  }})
  const blockContext = useBlockContext()
  const focusNewComment = useFocusNewComment()
  const uiStateBlock = useUIStateBlock()
  // The root renders no editor, so edit mode on it (a click on the quote, an
  // arrow up from the first comment) would leave the keyboard with nowhere to
  // go. Drop to plain focus instead.
  const editing = useInEditMode(block.id)
  useEffect(() => {
    if (editing) void exitEditModeForBlock(uiStateBlock, block.id, blockContext.renderScopeId)
  }, [editing, uiStateBlock, block.id, blockContext.renderScopeId])
  if (!root) return null
  return inCard(blockContext)
    ? <ThreadHeader root={root} onReply={async () => focusNewComment(await replyTo(block.repo, block.id))}/>
    : <ThreadElsewhere root={root}/>
}

type RootFields = Pick<BlockData, 'id' | 'workspaceId' | 'content' | 'properties'>

const ThreadHeader = ({root, onReply}: {root: RootFields; onReply: () => Promise<void>}) => {
  const repo = useRepo()
  const readOnly = useReadOnly(repo)
  const state = useAnchorState(root)
  const open = threadIsOpen(root)
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="min-w-0 flex-1 text-muted-foreground"><QuoteText anchor={threadAnchorOf(root)}/></span>
      {state !== 'exact' && (
        <span className="rounded bg-muted px-1 text-xs text-muted-foreground">{ANCHOR_BADGES[state]}</span>
      )}
      {!readOnly && <>
        <ActionButton onClick={() => onReply().catch(reportFailure)}>Reply</ActionButton>
        <ActionButton onClick={() => setThreadStatus(repo, root.id, open ? 'resolved' : 'open').catch(reportFailure)}>
          {open ? 'Resolve' : 'Reopen'}
        </ActionButton>
      </>}
    </div>
  )
}

/** On the container page, in search results and anywhere else a root shows
 *  outside a card: which block it is on, and what it quotes. */
const ThreadElsewhere = ({root}: {root: RootFields}) => {
  const targetId = threadTargetIdOf(root)
  return (
    <div className="text-sm text-muted-foreground">
      <span>on </span>
      {targetId ? <TargetLink targetId={targetId}/> : <span>a missing block</span>}
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
  const readOnly = useReadOnly(block.repo)
  return (
    <div className="w-full">
      <Inner block={block}/>
      {!readOnly && (
        <div className="flex gap-2 pb-0.5">
          <ActionButton onClick={() => replyTo(block.repo, block.id).then(focusNewComment).catch(reportFailure)}>Reply</ActionButton>
          <ActionButton onClick={() => deleteCommentFromCard(block).catch(reportFailure)}>Delete</ActionButton>
        </div>
      )}
    </div>
  )
}

const decorateComment = cachedContentDecorator(CommentActions, 'WithCommentActions')

export const commentActionsContribution: BlockContentDecoratorContribution = ctx =>
  inCard(ctx.blockContext) && !ctx.types.includes(THREAD_TYPE) ? decorateComment : null

// ──── Bullet menu ────

/** Only where the composer can render: the inline threads live on outline
 *  blocks, not on nested surfaces. */
export const commentContextMenuItem: BlockContextMenuItemsContribution = ctx =>
  appliesToOutlineBlock(ctx)
    ? {
      id: 'annotations.comment', label: 'Comment', icon: MessageSquare,
      onSelect: () => openComposer(viewKey(ctx.blockContext?.renderScopeId, ctx.block.id), ctx.block.id, null),
    }
    : null
