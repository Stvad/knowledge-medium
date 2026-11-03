/**
 * The comments UI on outline blocks and in thread cards (the side margin's
 * column is `margin.tsx`):
 *
 * - a comment pill in the gutter, after the reference pill, on every
 *   non-nested surface, the focal block included (nothing else shows a focal
 *   block's comments). It also hands the block's threads to the read-mode
 *   highlights (`readHighlights.ts`);
 * - its inline expansion under the block, holding the composer and a card per
 *   thread;
 * - each card renders the thread root through `BlockComponent` in a nested
 *   surface, so comments are ordinary editable blocks. The root's own line is
 *   the card header (`ThreadRootContent`), and each comment gets Reply and
 *   Delete (`CommentActions`).
 */

import {useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode} from 'react'
import {MessageSquare} from 'lucide-react'
import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import type {Repo} from '@/data/repo'
import {useInEditMode, useUIStateBlock} from '@/data/globalState.js'
import {exitEditModeForBlock} from '@/data/properties.js'
import {BlockComponent} from '@/components/BlockComponent.js'
import {NestedBlockContextProvider, useBlockContext} from '@/context/block.js'
import {MarkdownInputProvider} from '@/markdown/context.js'
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
import {firstLine, truncate} from '@/utils/string.js'
import {showError} from '@/utils/toast.js'
import type {RangeAnchor} from './anchor.ts'
import {ANCHOR_BADGES, useAnchorState} from './anchorState.ts'
import {composerReady, reportFailure, submitComposer} from './actions.ts'
import {deleteCommentFromCard} from './deleteComment.ts'
import {confirmedAnchor, reanchorThread} from './reanchor.ts'
import {isAccepted, showsAnchorState, SuggestionActions, SuggestionText} from './suggestionCard.tsx'
import {THREAD_HIGHLIGHTS_INPUT, type ThreadHighlightsFeed} from './readHighlights.ts'
import {ReadSelectionMenu} from './readSelectionUi.tsx'
import {
  THREAD_TYPE,
  threadAnchorOf,
  threadIsOpen,
  threadSuggestionOf,
  threadTargetIdOf,
  type ThreadAnchor,
} from './schema.ts'
import {drawsHighlight, pillCount, THREADS_FOR_BLOCK_QUERY, type HighlightThread, type ThreadSummary} from './summaries.ts'
import {isThreadRefusal, replyTo, setThreadStatus} from './threads.ts'
import {
  activateThread,
  cardRenderScopeId,
  closeComposer,
  openComposer,
  releasePendingReanchor,
  showClosedThreads,
  startReanchor,
  toggleShowResolved,
  toggleThreadsExpanded,
  updateComposer,
  useActiveThread,
  useComposer,
  useMarginShowing,
  usePendingReanchor,
  useShowResolved,
  useThreadsExpanded,
  viewKey,
  type CardSurface,
  type ComposerState,
} from './uiStore.ts'

/** Set to the card's render scope on a card's nested surface; read by the
 *  root's header renderer, the per-comment actions and "Quoted in". */
export const COMMENT_CARD_KEY = 'annotations.commentCard'

/** A block of a thread's card, not of a surface nested in it. Block context is
 *  inherited, but every nested surface (an embed, a reference, a backlink
 *  entry under "Quoted in") sets a render scope of its own, so the card's
 *  blocks are those still in the card's. Breadcrumbs keep their surface's
 *  scope, so they are excluded by name. */
export const inCard = (blockContext: Record<string, unknown> | undefined): boolean =>
  typeof blockContext?.[COMMENT_CARD_KEY] === 'string' && blockContext[COMMENT_CARD_KEY] === blockContext.renderScopeId &&
  blockContext.isBreadcrumb !== true

const useReadOnly = (repo: Repo): boolean =>
  useSyncExternalStore(useCallback(onChange => repo.onReadOnlyChange(onChange), [repo]), () => repo.isReadOnly)

const NO_THREADS: readonly ThreadSummary[] = Object.freeze([])

const appliesToOutlineBlock = (ctx: BlockResolveContext): boolean => !ctx.blockContext?.isNestedSurface

const NO_HIGHLIGHTS: readonly HighlightThread[] = Object.freeze([])

export const highlightsOf = (threads: readonly ThreadSummary[] | undefined): readonly HighlightThread[] =>
  threads?.filter(drawsHighlight).map(({id, open, anchor, suggestion}) => ({id, open, anchor, suggestion})) ?? NO_HIGHLIGHTS

/** The block's highlights, only, for this render scope: the selection keeps
 *  its identity while just a thread's comments change, and so does the feed
 *  built from it, so a new comment doesn't re-render the content. Threads a
 *  card already encloses are left out. */
const useHighlightFeed = (block: Block, exclude: readonly string[] = NO_IDS): ThreadHighlightsFeed => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const {renderScopeId} = useBlockContext()
  const threads = useHandle(block.repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId, id: block.id}), {selector: highlightsOf})
  return useMemo(() => ({
    blockId: block.id,
    renderScopeId,
    threads: exclude.length === 0 ? threads : threads.filter(thread => !exclude.includes(thread.id)),
  }), [block.id, renderScopeId, threads, exclude])
}

const NO_IDS: readonly string[] = Object.freeze([])

export const useThreadSummaries = (block: Block): readonly ThreadSummary[] => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  return useHandle(
    block.repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId, id: block.id}),
    {selector: threads => threads ?? NO_THREADS},
  )
}

// ──── Pill ────

export type PillClick =
  | {kind: 'expand-inline'}
  | {kind: 'activate'; threadId: string; revealClosed: boolean}

/** What a click on the pill does. With the margin drawn it pins the block's
 *  first open thread's card, or, for a block whose threads are all resolved,
 *  the first one's, revealing closed threads so the card is there to pin. */
export const pillClick = (threads: readonly ThreadSummary[], inMargin: boolean): PillClick => {
  const first = threads.find(thread => thread.open) ?? threads[0]
  return inMargin && first
    ? {kind: 'activate', threadId: first.id, revealClosed: !first.open}
    : {kind: 'expand-inline'}
}

const CommentPill = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const threads = useThreadSummaries(block)
  const blockContext = useBlockContext()
  const key = viewKey(blockContext.renderScopeId, block.id)
  const panelId = blockContext.panelId
  // With the margin drawn, the threads are already beside the block: the pill
  // pins its first card instead of expanding them a second time inline.
  const inMargin = useMarginShowing(panelId)
  const activeThread = useActiveThread(panelId ?? '')
  const inlineExpanded = useThreadsExpanded(key)
  const expanded = inMargin ? threads.some(thread => thread.id === activeThread) : inlineExpanded
  const onPill = () => {
    const click = pillClick(threads, inMargin)
    if (click.kind === 'expand-inline') {
      toggleThreadsExpanded(key)
      return
    }
    if (click.revealClosed) showClosedThreads(panelId!)
    activateThread(panelId!, click.threadId)
  }
  const count = pillCount(threads)
  const label = count ? `${count} open comment thread${count === 1 ? '' : 's'}` : 'Comments'
  const highlights = useHighlightFeed(block)
  return (
    <div className="flex w-full items-start gap-1">
      <ReadSelectionMenu block={block}>
        <div className="min-w-0 flex-1">
          <MarkdownInputProvider name={THREAD_HIGHLIGHTS_INPUT} value={highlights}>
            <Inner block={block}/>
          </MarkdownInputProvider>
        </div>
      </ReadSelectionMenu>
      {(count !== null || expanded) && (
        <GutterPill
          count={count}
          expanded={expanded}
          onClick={event => { event.stopPropagation(); onPill() }}
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

const COMPOSER_FIELD = 'w-full resize-y rounded border bg-background px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** A comment's composer, or an edit suggestion's: the replacement, prefilled
 *  with the quote, and an optional comment. */
const Composer = ({block, composerKey, composer}: {block: Block; composerKey: string; composer: ComposerState}) => {
  const input = useRef<HTMLTextAreaElement>(null)
  const suggesting = composer.replacement !== undefined
  // A frame late, on open and on re-aim: a menu that opened the composer
  // returns focus to its trigger as it closes. At the end of the text, where
  // a prefilled replacement is usually extended.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const field = input.current
      field?.focus()
      field?.setSelectionRange(field.value.length, field.value.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [composer.anchor])
  const submit = async () => {
    try {
      await submitComposer(block.repo, composerKey)
    } catch (error) {
      reportFailure(error)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
  }
  const fieldProps = {rows: 2, readOnly: composer.submitting, onKeyDown, className: COMPOSER_FIELD}
  return (
    <div className="min-w-0 space-y-1 rounded border bg-background p-2" data-testid="comment-composer">
      <div className="text-xs text-muted-foreground">
        {suggesting ? 'Suggest a change to' : 'Comment on'}{' '}
        <QuoteText anchor={composer.anchor ? {kind: 'range', ...composer.anchor} : {kind: 'block'}}/>
      </div>
      {suggesting && (
        <textarea
          {...fieldProps}
          ref={input}
          aria-label="Replacement"
          value={composer.replacement}
          onChange={event => updateComposer(composerKey, {replacement: event.target.value, error: null})}
        />
      )}
      <textarea
        {...fieldProps}
        ref={suggesting ? undefined : input}
        aria-label={suggesting ? 'Comment (optional)' : 'New comment'}
        placeholder={suggesting ? 'Why (optional)' : undefined}
        value={composer.draft}
        onChange={event => updateComposer(composerKey, {draft: event.target.value, error: null})}
      />
      {composer.error && <p role="alert" className="text-xs text-destructive">{composer.error}</p>}
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          disabled={composer.submitting || !composerReady(composer)}
          onClick={() => void submit()}
          className="rounded bg-primary px-2 py-0.5 text-primary-foreground disabled:opacity-50"
        >
          {suggesting ? 'Suggest' : 'Comment'}
        </button>
        <button type="button" onClick={() => closeComposer(composerKey)} className="px-1 text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  )
}

/** The thread ids of the cards enclosing this one, outermost first: a thread
 *  anchored to a comment renders inside that comment's card, and a thread
 *  anchored (by hand or by an agent) to a comment of itself must not render
 *  itself forever. */
const CARD_CHAIN_KEY = 'annotations.cardChain'

const cardChainOf = (blockContext: Record<string, unknown>): readonly string[] =>
  Array.isArray(blockContext[CARD_CHAIN_KEY]) ? blockContext[CARD_CHAIN_KEY] as string[] : []

/** One thread, its root rendered through `BlockComponent` in a nested surface.
 *  `surface` keeps an inline card and a margin card of the same thread in
 *  distinct render scopes. */
export const ThreadCard = ({thread, surface = 'comments'}: {thread: ThreadSummary; surface?: CardSurface}) => {
  const parent = useBlockContext()
  const renderScopeId = cardRenderScopeId(surface, parent.renderScopeId ?? '', thread.id)
  return (
    <div className="rounded border bg-background px-1 py-0.5" data-testid="comment-thread">
      <NestedBlockContextProvider overrides={{
        isNestedSurface: true,
        layoutBoundary: false,
        renderScopeId,
        scopeRootId: thread.id,
        [COMMENT_CARD_KEY]: renderScopeId,
        [CONTRIBUTOR_CARD_MODE_KEY]: thread.id,
        [CARD_CHAIN_KEY]: [...cardChainOf(parent), thread.id],
      }}>
        <BlockComponent blockId={thread.id}/>
      </NestedBlockContextProvider>
    </div>
  )
}

const ThreadsSection = ({block}: {block: Block}) => {
  const threads = useThreadSummaries(block)
  const blockContext = useBlockContext()
  const key = viewKey(blockContext.renderScopeId, block.id)
  const composer = useComposer(key)
  const showResolved = useShowResolved(key)
  const inMargin = useMarginShowing(blockContext.panelId)
  // The margin shows the threads; only a composer opened here stays inline.
  if (inMargin) {
    return composer
      ? <section aria-label="Comments" className="my-1 ml-6 min-w-0"><Composer block={block} composerKey={key} composer={composer}/></section>
      : null
  }
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
          {showResolved ? 'Hide' : 'Show'} {closed.length} closed
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

const reportRefusal = (error: unknown): void => {
  if (isThreadRefusal(error)) showError(error.message)
  else reportFailure(error)
}

/** Re-anchoring a moved or stale quote: confirm it where it now sits, select
 *  new text for it (the next comment-on-selection in its block re-anchors
 *  it), or anchor it to the whole block, which a suggestion can't be: it
 *  would have nothing to replace. */
const ReanchorControls = ({root, state, targetContent}: {
  root: RootFields
  state: 'moved' | 'stale'
  targetContent: string
}) => {
  const repo = useRepo()
  const pending = usePendingReanchor()
  const anchor = threadAnchorOf(root) as {kind: 'range'} & RangeAnchor
  const targetId = threadTargetIdOf(root)
  useEffect(() => () => releasePendingReanchor(root.id), [root.id])
  if (pending?.threadId === root.id) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground" role="status">
        <span>Select the new text in the block, then choose Comment on selection.</span>
        <ActionButton onClick={() => startReanchor(null)}>Cancel</ActionButton>
      </div>
    )
  }
  const confirm = () => {
    const next = confirmedAnchor(targetContent, anchor)
    if (!next) {
      showError('This quote can\u2019t be confirmed where it is now. Select it again.')
      return
    }
    reanchorThread(repo, root.id, next).catch(reportRefusal)
  }
  return (
    <div className="flex flex-wrap gap-x-2">
      {state === 'moved' && <ActionButton onClick={confirm}>Confirm position</ActionButton>}
      {targetId && <ActionButton onClick={() => startReanchor({threadId: root.id, targetId})}>Reselect</ActionButton>}
      {!threadSuggestionOf(root) && (
        <ActionButton onClick={() => reanchorThread(repo, root.id, null).catch(reportRefusal)}>Whole block</ActionButton>
      )}
    </div>
  )
}

/** What a thread's line shows: a suggestion's change, or the quote. */
const ThreadQuote = ({root}: {root: RootFields}) => {
  const suggestion = threadSuggestionOf(root)
  return suggestion ? <SuggestionText root={root} suggestion={suggestion}/> : <QuoteText anchor={threadAnchorOf(root)}/>
}

const ThreadHeader = ({root, onReply}: {root: RootFields; onReply: () => Promise<void>}) => {
  const repo = useRepo()
  const readOnly = useReadOnly(repo)
  const {state, targetContent} = useAnchorState(root)
  const open = threadIsOpen(root)
  const awaitingDecision = open && threadSuggestionOf(root) !== null
  const anchorShown = showsAnchorState(root)
  return (
    <div className="space-y-0.5">
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="min-w-0 flex-1 basis-32 text-muted-foreground"><ThreadQuote root={root}/></span>
      {anchorShown && state !== 'exact' && (
        <span className="rounded bg-muted px-1 text-xs text-muted-foreground">{ANCHOR_BADGES[state]}</span>
      )}
      {!readOnly && <>
        {awaitingDecision && <SuggestionActions threadId={root.id}/>}
        <ActionButton onClick={() => onReply().catch(reportFailure)}>Reply</ActionButton>
        {!awaitingDecision && !isAccepted(root) && (
          <ActionButton onClick={() => setThreadStatus(repo, root.id, open ? 'resolved' : 'open').catch(reportFailure)}>
            {open ? 'Resolve' : 'Reopen'}
          </ActionButton>
        )}
      </>}
    </div>
    {anchorShown && !readOnly && targetContent !== null && (state === 'moved' || state === 'stale') && (
      <ReanchorControls root={root} state={state} targetContent={targetContent}/>
    )}
    </div>
  )
}

/** On the container page, in search results and anywhere else a root shows
 *  outside a card: which block it is on, and what it quotes. */
const ThreadElsewhere = ({root}: {root: RootFields}) => {
  const targetId = threadTargetIdOf(root)
  const {state} = useAnchorState(root)
  return (
    <div className="text-sm text-muted-foreground">
      <span>on </span>
      {targetId ? <TargetLink targetId={targetId}/> : <span>a missing block</span>}
      <span> · </span>
      <ThreadQuote root={root}/>
      {showsAnchorState(root) && state !== 'exact' && <span className="ml-1 rounded bg-muted px-1 text-xs">{ANCHOR_BADGES[state]}</span>}
    </div>
  )
}

/** The root's content is display-only: editing it would move the anchor. */
export const threadRootContentContribution: VariantContribution<BlockResolveContext, BlockRenderer> = ctx =>
  ctx.types.includes(THREAD_TYPE) ? defineVariant('annotations.thread-root', 'Comment thread', ThreadRootContent) : null

// ──── Per-comment actions ────

/** The threads a comment's card shows under it: the open ones, less any card
 *  already open around it. */
export const threadsUnderComment = (
  threads: readonly ThreadSummary[],
  chain: readonly string[],
): readonly ThreadSummary[] => threads.filter(thread => thread.open && !chain.includes(thread.id))

/** Threads anchored to a comment (a quote-reply, a note on a phrase) render
 *  inside that comment's card, highlighted in its text with their cards under
 *  it; they never get a margin card of their own. */
const CommentActions = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const focusNewComment = useFocusNewComment()
  const readOnly = useReadOnly(block.repo)
  const blockContext = useBlockContext()
  const chain = cardChainOf(blockContext)
  const all = useThreadSummaries(block)
  const threads = useMemo(() => threadsUnderComment(all, chain), [all, chain])
  const highlights = useHighlightFeed(block, chain)
  return (
    <div className="w-full">
      <MarkdownInputProvider name={THREAD_HIGHLIGHTS_INPUT} value={highlights}>
        <Inner block={block}/>
      </MarkdownInputProvider>
      {!readOnly && (
        <div className="flex gap-2 pb-0.5">
          <ActionButton onClick={() => replyTo(block.repo, block.id).then(focusNewComment).catch(reportFailure)}>Reply</ActionButton>
          <ActionButton onClick={() => deleteCommentFromCard(block).catch(reportFailure)}>Delete</ActionButton>
        </div>
      )}
      {threads.length > 0 && (
        <div className="mb-1 space-y-1 border-l-2 border-yellow-500/50 pl-1.5" aria-label="Comments on this comment">
          {threads.map(thread => <ThreadCard key={thread.id} thread={thread}/>)}
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
