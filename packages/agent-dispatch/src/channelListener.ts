/**
 * What the channel listener does with one POST, as a value in and a value
 * out — the HTTP plumbing stays in mcp.ts.
 *
 * Its own module because the decisions here are all about telling failures
 * apart — a malformed body, a dead session, and a dispatch that never
 * happened each need a different response — which needs a seam a test can
 * reach.
 */
import type { createDeliveryDedup } from './deliveryDedup.js'

export interface ChannelPostResult {
  status: number
  body: string
}

export interface ChannelPostDeps {
  body: string
  dedup: ReturnType<typeof createDeliveryDedup>
  /** Hand the event to the ambient session. Rejects if it never got there. */
  dispatch: (event: {content: string, meta?: Record<string, string>}) => Promise<void>
}

export const handleChannelPost = async (
  {body, dedup, dispatch}: ChannelPostDeps,
): Promise<ChannelPostResult> => {
  // PARSE FIRST, claim second. One try around both reported every failure as
  // 400 and left a claim behind for the ones that never dispatched — and the
  // sender reads 400 as a permanent task failure.
  let content: string
  let meta: Record<string, string> | undefined
  try {
    const parsed = JSON.parse(body) as {content?: unknown, meta?: unknown}
    if (typeof parsed.content !== 'string') throw new Error('content required')
    content = parsed.content
    meta = parsed.meta && typeof parsed.meta === 'object'
      ? Object.fromEntries(
          Object.entries(parsed.meta as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string'),
        ) as Record<string, string>
      : undefined
  } catch {
    return {status: 400, body: 'expected JSON {content, meta?}'}
  }

  // Dispatch STARTS the ambient session working and only then do we
  // acknowledge, so a lost ack leaves the sender unable to tell "never
  // arrived" from "already running" — and its retry would duplicate billed,
  // write-capable work on the graph. Claiming the id is what makes that
  // retry safe, and it happens BEFORE the await: dispatch waits for the
  // stdio transport to drain, a wait that can outlast the sender's timeout,
  // so a claim recorded afterwards leaves the in-flight request unclaimed.
  const eventId = meta?.event_id
  const outcome = dedup.claim(eventId)
  if (outcome === 'delivered') return {status: 200, body: 'duplicate'}
  if (outcome === 'unconfirmed') {
    // Someone holds this id and has not confirmed. Answering 200 would tell
    // a query sender its rows are with the session, and it would advance its
    // cursor past work that may never have run — with no block left behind
    // for a sweep to find. 503 says "unknown, ask again".
    return {status: 503, body: 'in flight'}
  }

  try {
    await dispatch({content, ...(meta ? {meta} : {})})
  } catch {
    // Nothing reached the session. On a stdio transport a rejection means it
    // was never connected or is gone — a message that made it into the pipe
    // does not reject — so releasing the claim is safe, and is what stops
    // this id answering 503 forever. 503 rather than 400: the listener is up
    // but the session behind it is not, which is the transient the sender's
    // retry path exists for.
    dedup.release(eventId)
    return {status: 503, body: 'ambient session not connected'}
  }
  // Confirmed only once the write completed. Until then the claim reads
  // `unconfirmed`, so nobody may bank on it.
  dedup.confirm(eventId)
  return {status: 200, body: 'ok'}
}
