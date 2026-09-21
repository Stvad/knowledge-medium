/**
 * Dispatch observers: sample the undo stack before an action runs, and once
 * it has settled ask the action's describer (if it has one) for a receipt.
 *
 * Observers get only the invocation, so the repo and the live runtime
 * handle come from the plugin's app effect (`setReceiptsHost`), which runs
 * whenever a runtime is up.
 */
import { ChangeScope } from '@/data/api'
import type { UndoEntry } from '@/data/internals/undoManager'
import type { Repo } from '@/data/repo'
import type { AppEffectContext } from '@/extensions/core.js'
import type { VerbOutcome } from '@/facets/verbFacet.js'
import type { ActionInvocation } from '@/shortcuts/actionDispatch.js'
import type { ActionHandlerResult } from '@/shortcuts/types.js'
import { actionReceiptsFacet } from './facet.ts'
import { showReceipt } from './receipts.ts'
import { phrase, summarizeEntry } from './summarize.ts'

interface StackSample {
  workspaceId: string
  top: UndoEntry | null
  depth: number
}

const pending = new WeakMap<ActionInvocation, StackSample>()

interface Host {
  repo: Repo
  runtime: AppEffectContext['runtime']
}

let host: Host | null = null

export const setReceiptsHost = (next: Host | null): void => {
  host = next
}

export const receiptsBeforeDispatch = (invocation: ActionInvocation): void => {
  if (host === null) return
  const workspaceId = host.repo.activeWorkspaceId
  if (workspaceId === null) return
  const manager = host.repo.undoManagerFor(workspaceId)
  pending.set(invocation, {
    workspaceId,
    top: manager.peekUndo(ChangeScope.BlockDefault),
    depth: manager.depths(ChangeScope.BlockDefault).undo,
  })
}

export const receiptsAfterDispatch = async (
  invocation: ActionInvocation,
  outcome: VerbOutcome<ActionHandlerResult>,
): Promise<void> => {
  const before = pending.get(invocation)
  pending.delete(invocation)
  if (host === null || before === undefined || !outcome.ok) return
  const {repo, runtime} = host
  const describer = runtime.read(actionReceiptsFacet).get(invocation.action.id)
  if (describer === undefined) return
  if (describer.context !== undefined && describer.context !== invocation.action.context) return
  // The handler's promise, when it returned one. A handler that threw owns
  // its own error surface; no receipt on top of it.
  try {
    await outcome.result
  } catch {
    return
  }
  const manager = repo.undoManagerFor(before.workspaceId)
  const top = manager.peekUndo(ChangeScope.BlockDefault)
  const entry = top !== null && top !== before.top ? top : null
  const summary = entry === null ? null : summarizeEntry(entry)
  const receipt = describer.describe({
    invocation,
    repo,
    entry,
    summary,
    phrase: summary === null ? null : phrase(summary, 'forward'),
    recorded: Math.max(0, manager.depths(ChangeScope.BlockDefault).undo - before.depth),
  })
  if (receipt !== null) void showReceipt(receipt, repo)
}
