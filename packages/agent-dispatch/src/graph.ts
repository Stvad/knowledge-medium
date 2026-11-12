/**
 * Dispatch-specific graph writes layered over the generic bridge graph.
 * Generic reads/writes live in @knowledge-medium/agent-cli/graph; this
 * module owns only the durable dispatch task protocol. A write's
 * attribution is decided by the factory that defines it.
 */
import { withContributorId, type BridgeClient } from '@knowledge-medium/agent-cli/client'
import { createBridgeGraph, type BacklinkSource, type BlockData, type BlockView, type HydratedRef } from '@knowledge-medium/agent-cli/graph'
import { PROPS, type Executor, type TaskStatus } from './config.js'
import type { AgentResumeOptions } from './resumeCommand.js'
import { MEMORY_BLOCK_TITLE, type MemoryEntry } from './memory.js'

export type { BacklinkSource, BlockData, BlockView, HydratedRef }

interface TaskPropsWrite {
  status: TaskStatus, watcher?: string, executor?: Executor, session?: string | null, error?: string | null,
  resumeOptions?: AgentResumeOptions | null,
  attempts?: number, activity?: string | null, cancel?: string | null, nowMs: number,
}

/** Reads, and the `agent:*` writes to a mention's source block. They go
 *  through a client with `contributorId: null`, for which the contributors
 *  processor records nothing, so a person's note keeps exactly the authors
 *  who wrote it. */
/** Blocks of memory a run's prompt shows (about 50 short lines). */
const MEMORY_OUTLINE_LIMIT = 50

export const createGraph = (bridgeClient: BridgeClient) => {
  const client = withContributorId(bridgeClient, null)
  const bridgeGraph = createBridgeGraph(client)

  /** Every `agent:*` write: merged into the bag (update-block merges), so it
   *  never clobbers dispatch state written concurrently, and kept off the
   *  user's undo stack — a cmd-Z in the app must undo the person's own edit,
   *  not flip a task back to `running`. */
  const writeTaskProps = (id: string, properties: Record<string, unknown>) =>
    bridgeGraph.updateBlock(id, {properties, undoable: false})

  // KNOWN LIMITATION: this write goes through the bridge `update-block`
  // command, which stamps user_updated_at/updatedBy like a user edit —
  // so a claimed mention jumps to the top of "recently edited" views.
  // It does NOT cause a re-trigger (decidePending only reads editedAtMs
  // when status is unset, and this sets status). A clean fix needs the
  // bridge to forward a skipMetadata flag to tx.update; not available yet.
  const setTaskProps = async (id: string, args: TaskPropsWrite): Promise<void> => {
    const properties: Record<string, unknown> = {
      [PROPS.status]: args.status,
      [PROPS.updatedAt]: args.nowMs,
    }
    if (args.watcher !== undefined) properties[PROPS.watcher] = args.watcher
    if (args.executor !== undefined) properties[PROPS.executor] = args.executor
    if (args.session !== undefined && args.session !== null) properties[PROPS.session] = args.session
    if (args.resumeOptions !== undefined && args.resumeOptions !== null) properties[PROPS.resumeOptions] = args.resumeOptions
    if (args.error !== undefined) properties[PROPS.error] = args.error ?? ''
    if (args.attempts !== undefined) properties[PROPS.attempts] = args.attempts
    if (args.activity !== undefined) properties[PROPS.activity] = args.activity ?? ''
    // Clear the cancel REQUEST on terminal writes so a satisfied/stale
    // cancel never re-cancels a later rerun.
    if (args.cancel !== undefined) properties[PROPS.cancel] = args.cancel ?? ''
    await writeTaskProps(id, properties)
  }

  /** Transient "what the run is doing now" label. */
  const setActivity = async (id: string, label: string): Promise<void> => {
    await writeTaskProps(id, {[PROPS.activity]: label})
  }

  /** Persist the run's session id the instant it's known (mid-run). */
  const setSession = async (id: string, session: string, resumeOptions?: AgentResumeOptions | null): Promise<void> => {
    await writeTaskProps(id, {
      [PROPS.session]: session,
      ...(resumeOptions ? {[PROPS.resumeOptions]: resumeOptions} : {}),
    })
  }

  /** Clear ONLY the cancel request, a single-key write, so a Stop the daemon
   *  cannot act on cannot clobber a concurrently terminal task. */
  const clearCancel = async (id: string): Promise<void> => {
    await writeTaskProps(id, {[PROPS.cancel]: ''})
  }

  const findMemoryBlock = async (pageId: string): Promise<string | null> => {
    const rows = await bridgeGraph.sqlAll(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 AND lower(trim(content)) = lower(?) ORDER BY order_key, id LIMIT 1',
      [pageId, MEMORY_BLOCK_TITLE],
    )
    const id = (rows[0] as {id?: unknown} | undefined)?.id
    return typeof id === 'string' ? id : null
  }

  /** The watched page's memory block, created when missing. Created as a
   *  keyed reconcile, not create-block: it stays off the person's undo stack,
   *  and two runs creating it at once converge on one block. */
  const ensureMemoryBlock = async (pageId: string): Promise<string> => {
    const found = await findMemoryBlock(pageId)
    if (found) return found
    await bridgeGraph.reconcileMarkdownSubtree(pageId, MEMORY_BLOCK_TITLE, {
      key: 'agent-dispatch:memory', shape: 'block', final: true, undoable: false,
    })
    const created = await findMemoryBlock(pageId)
    if (!created) throw new Error(`no ${MEMORY_BLOCK_TITLE} block under ${pageId} after creating it`)
    return created
  }

  /** The bounded outline the run's own `subtree` tool prints: shallow levels
   *  first, long entries cut with a marker. */
  const memoryOutline = async (memoryId: string): Promise<string> => {
    const view = await client.runCommand({type: 'view-outline', ref: memoryId, depth: 2, limit: MEMORY_OUTLINE_LIMIT})
    if (typeof view !== 'string') throw new Error('view-outline returned no text')
    return view
  }

  /** The memory's entries, for the reply's account of what a run changed. */
  const memoryEntries = async (memoryId: string): Promise<MemoryEntry[]> => {
    const rows = await bridgeGraph.sqlAll(
      'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id LIMIT 500',
      [memoryId],
    )
    return rows.flatMap(row => {
      const {id, content} = row as {id?: unknown, content?: unknown}
      return typeof id === 'string' ? [{id, content: typeof content === 'string' ? content : ''}] : []
    })
  }

  return {
    ensureMemoryBlock,
    memoryOutline,
    memoryEntries,
    resolvePageId: bridgeGraph.resolvePageId,
    backlinkSources: bridgeGraph.backlinkSources,
    getBlock: bridgeGraph.getBlock,
    ancestors: bridgeGraph.ancestors,
    getSubtree: bridgeGraph.getSubtree,
    sqlAll: bridgeGraph.sqlAll,
    blockViews: bridgeGraph.blockViews,
    beingEditedBlocks: bridgeGraph.beingEditedBlocks,
    comments: bridgeGraph.comments,
    setTaskProps,
    setActivity,
    setSession,
    clearCancel,
  }
}

export type Graph = ReturnType<typeof createGraph>

/** The agent's replies, attributed to the client's contributor. */
export const createReplyWriter = (client: BridgeClient) => {
  const bridgeGraph = createBridgeGraph(client)

  /** Reconcile the run's reply subtree (tagged `replyKey`) under `parentId`
   *  to match `markdown`, app-side in ONE transaction (a failure never
   *  leaves a partial tree). Every block is tagged the reply marker. This is
   *  the SINGLE reply-write primitive: `shape:'outline'` splits along the
   *  markdown outline into a block hierarchy, `'block'` keeps one block, and
   *  because it's idempotent by `replyKey`, streaming a reply is just
   *  repeated reconciles with the growing text (the last passes `final`).
   *  Safe to retry — a re-send converges to the same tree, no duplication. */
  const reconcileReplyTree = async (
    parentId: string, markdown: string,
    opts: {replyKey: string, shape: 'outline' | 'block', final?: boolean},
  ): Promise<void> => {
    await bridgeGraph.reconcileMarkdownSubtree(parentId, markdown, {
      key: opts.replyKey,
      shape: opts.shape,
      ...(opts.final ? {final: true} : {}),
      properties: {[PROPS.reply]: true},
      // A reply is the agent's write, not the person's: off their undo stack.
      undoable: false,
    })
  }

  return {reconcileReplyTree}
}

export type ReplyWriter = ReturnType<typeof createReplyWriter>
