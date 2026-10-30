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
export const createGraph = (client: BridgeClient) => {
  const bridgeGraph = createBridgeGraph(withContributorId(client, null))

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
    // Clear the cancel REQUEST on terminal writes (merged, like activity)
    // so a satisfied/stale cancel never re-cancels a later rerun.
    if (args.cancel !== undefined) properties[PROPS.cancel] = args.cancel ?? ''
    await bridgeGraph.updateBlock(id, {properties})
  }

  /** Transient "what the run is doing now" label — merged
   *  (update-block merges the properties map) so it never clobbers
   *  other dispatch state written concurrently. */
  const setActivity = async (id: string, label: string): Promise<void> => {
    await bridgeGraph.updateBlock(id, {properties: {[PROPS.activity]: label}})
  }

  /** Persist the run's session id the instant it's known (mid-run),
   *  merged so it never clobbers concurrent dispatch state. */
  const setSession = async (id: string, session: string, resumeOptions?: AgentResumeOptions | null): Promise<void> => {
    await bridgeGraph.updateBlock(id, {
      properties: {
        [PROPS.session]: session,
        ...(resumeOptions ? {[PROPS.resumeOptions]: resumeOptions} : {}),
      },
    })
  }

  /** Clear ONLY the cancel request (merged single-key write, like
   *  setSession) so a Stop the daemon cannot act on cannot clobber a
   *  concurrently terminal task. */
  const clearCancel = async (id: string): Promise<void> => {
    await bridgeGraph.updateBlock(id, {properties: {[PROPS.cancel]: ''}})
  }

  return {
    resolvePageId: bridgeGraph.resolvePageId,
    backlinkSources: bridgeGraph.backlinkSources,
    getBlock: bridgeGraph.getBlock,
    ancestors: bridgeGraph.ancestors,
    getSubtree: bridgeGraph.getSubtree,
    sqlAll: bridgeGraph.sqlAll,
    blockViews: bridgeGraph.blockViews,
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

  const createReply = async (parentId: string, content: string): Promise<BlockData> =>
    bridgeGraph.createBlock(parentId, content, {[PROPS.reply]: true})

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
    })
  }

  return {createReply, reconcileReplyTree}
}

export type ReplyWriter = ReturnType<typeof createReplyWriter>
