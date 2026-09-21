/**
 * Dispatch observers: sample the undo stack before an action runs, and once
 * it has settled ask the action's describer (if it has one) for a receipt.
 *
 * Observers get only the invocation; the repo and the live runtime handle
 * come from the plugin's app effect (`receiptsHost`).
 *
 * Attribution is "the top entry changed while the handler ran". A flow
 * that awaits a dialog can see an unrelated write land in that window; the
 * describer's kind check is the only guard, which is why a flow that can
 * call `showReceipt` itself should (the move flow does).
 */
import { ChangeScope } from '@/data/api'
import type { UndoEntry } from '@/data/internals/undoManager'
import type { VerbOutcome } from '@/facets/verbFacet.js'
import type { ActionInvocation } from '@/shortcuts/actionDispatch.js'
import type { ActionHandlerResult } from '@/shortcuts/types.js'
import { actionReceiptsFacet } from './facet.ts'
import { receiptsHost, showReceipt } from './receipts.ts'
import { summarizeEntry } from './summarize.ts'

interface StackSample {
  workspaceId: string
  top: UndoEntry | null
}

const pending = new WeakMap<ActionInvocation, StackSample>()

export const receiptsBeforeDispatch = (invocation: ActionInvocation): void => {
  const host = receiptsHost()
  if (host === null) return
  const workspaceId = host.repo.activeWorkspaceId
  if (workspaceId === null) return
  pending.set(invocation, {
    workspaceId,
    top: host.repo.undoManagerFor(workspaceId).peekUndo(ChangeScope.BlockDefault),
  })
}

export const receiptsAfterDispatch = async (
  invocation: ActionInvocation,
  outcome: VerbOutcome<ActionHandlerResult>,
): Promise<void> => {
  const before = pending.get(invocation)
  pending.delete(invocation)
  const host = receiptsHost()
  if (host === null || before === undefined || !outcome.ok) return
  const {repo, runtime} = host
  const describer = runtime.read(actionReceiptsFacet).get(invocation.action.id)
  if (describer === undefined) return
  // The handler's promise, when it returned one. A handler that threw owns
  // its own error surface; no receipt on top of it.
  try {
    await outcome.result
  } catch {
    return
  }
  const top = repo.undoManagerFor(before.workspaceId).peekUndo(ChangeScope.BlockDefault)
  const entry = top !== null && top !== before.top ? top : null
  const receipt = describer.describe({
    invocation,
    repo,
    entry,
    summary: entry === null ? null : summarizeEntry(entry),
  })
  if (receipt !== null) void showReceipt(receipt, repo)
}
