/**
 * Dispatch-specific graph writes layered over the generic bridge graph.
 * Generic reads/writes live in @knowledge-medium/agent-cli/graph; this
 * module owns only the durable dispatch task protocol.
 */
import type { BridgeClient } from '@knowledge-medium/agent-cli/client'
import { createBridgeGraph, type BacklinkSource, type BlockData, type BlockView, type BridgeGraph, type HydratedRef } from '@knowledge-medium/agent-cli/graph'
import { PROPS, type Executor, type TaskStatus } from './config.js'

export type { BacklinkSource, BlockData, BlockView, HydratedRef }

export const createGraph = (client: BridgeClient) => {
  const bridgeGraph = createBridgeGraph(client)

  // KNOWN LIMITATION: this write goes through the bridge `update-block`
  // command, which stamps user_updated_at/updatedBy like a user edit —
  // so a claimed mention jumps to the top of "recently edited" views.
  // It does NOT cause a re-trigger (decidePending only reads editedAtMs
  // when status is unset, and this sets status). A clean fix needs the
  // bridge to forward a skipMetadata flag to tx.update; not available yet.
  const setTaskProps = async (
    id: string,
    args: {
      status: TaskStatus, watcher?: string, executor?: Executor, session?: string | null, error?: string | null,
      attempts?: number, activity?: string | null, cancel?: string | null, nowMs: number,
    },
  ): Promise<void> => {
    const properties: Record<string, unknown> = {
      [PROPS.status]: args.status,
      [PROPS.updatedAt]: args.nowMs,
    }
    if (args.watcher !== undefined) properties[PROPS.watcher] = args.watcher
    if (args.executor !== undefined) properties[PROPS.executor] = args.executor
    if (args.session !== undefined && args.session !== null) properties[PROPS.session] = args.session
    if (args.error !== undefined) properties[PROPS.error] = args.error ?? ''
    if (args.attempts !== undefined) properties[PROPS.attempts] = args.attempts
    if (args.activity !== undefined) properties[PROPS.activity] = args.activity ?? ''
    // Clear the cancel REQUEST on terminal writes (merged, like activity)
    // so a satisfied/stale cancel never re-cancels a later rerun.
    if (args.cancel !== undefined) properties[PROPS.cancel] = args.cancel ?? ''
    await bridgeGraph.updateBlock(id, {properties})
  }

  const createReply = async (parentId: string, content: string): Promise<BlockData> =>
    bridgeGraph.createBlock(parentId, content, {[PROPS.reply]: true})

  /** Transient "what the run is doing now" label — merged
   *  (update-block merges the properties map) so it never clobbers
   *  other dispatch state written concurrently. */
  const setActivity = async (id: string, label: string): Promise<void> => {
    await bridgeGraph.updateBlock(id, {properties: {[PROPS.activity]: label}})
  }

  /** Persist the run's session id the instant it's known (mid-run),
   *  merged so it never clobbers concurrent dispatch state. */
  const setSession = async (id: string, session: string): Promise<void> => {
    await bridgeGraph.updateBlock(id, {properties: {[PROPS.session]: session}})
  }

  /** Clear ONLY the cancel request (merged single-key write, like
   *  setSession) so a Stop the daemon cannot act on cannot clobber a
   *  concurrently terminal task. */
  const clearCancel = async (id: string): Promise<void> => {
    await bridgeGraph.updateBlock(id, {properties: {[PROPS.cancel]: ''}})
  }

  return {
    ...bridgeGraph,
    setTaskProps,
    createReply,
    setActivity,
    setSession,
    clearCancel,
  }
}

type DispatchBridgeGraph = Pick<
  BridgeGraph,
  | 'resolvePageId'
  | 'backlinkSources'
  | 'getBlock'
  | 'ancestors'
  | 'getSubtree'
  | 'updateBlockContent'
  | 'sqlAll'
  | 'blockViews'
>

export type Graph = DispatchBridgeGraph & {
  setTaskProps: (
    id: string,
    args: {
      status: TaskStatus, watcher?: string, executor?: Executor, session?: string | null, error?: string | null,
      attempts?: number, activity?: string | null, cancel?: string | null, nowMs: number,
    },
  ) => Promise<void>
  createReply: (parentId: string, content: string) => Promise<BlockData>
  setActivity: (id: string, label: string) => Promise<void>
  setSession: (id: string, session: string) => Promise<void>
  clearCancel: (id: string) => Promise<void>
}
