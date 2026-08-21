/**
 * POST one event to the ambient channel listener.
 *
 * Its own module so the failure classification has a seam a test can drive.
 * That matters more here than usual: this sender is the reason the daemon
 * can classify a delivery failure from the TRANSPORT rather than from the
 * sentence it renders — three separate review findings were the classifier
 * meeting a phrasing it had not been taught (a `503` reply, a dropped
 * bridge client, a fetch timeout), and each was fixed by adding one more
 * pattern until the shape itself was the problem.
 */
import { errorMessage } from '@knowledge-medium/agent-cli/client'
import { channelFailureFor, withRunFailure } from './runFailure.js'
import type { ChannelEvent } from './engine.js'

/** How long a POST may take before we give up on it. The listener hands the
 *  event to the ambient session and only then acknowledges, so a timeout is
 *  ambiguous by nature — see the dedup in mcp.ts, which is what makes the
 *  retry after one safe. */
export const CHANNEL_POST_TIMEOUT_MS = 10_000

export interface ChannelDeliveryOptions {
  port: number
  secret: string | null
  secretHeader: string
  /** Injected for tests; the real one is global `fetch`. */
  fetchImpl?: typeof fetch
  /** Appended to every failure so the operator knows what to start. */
  hint: string
}

export const createChannelDelivery = (options: ChannelDeliveryOptions) =>
  async (event: ChannelEvent): Promise<void> => {
    const send = options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await send(`http://127.0.0.1:${options.port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.secret ? {[options.secretHeader]: options.secret} : {}),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(CHANNEL_POST_TIMEOUT_MS),
      })
    } catch (error) {
      // Never got a response, so there is no status to read: the cause is
      // the transport itself (refused, unreachable, or our own timeout).
      throw withRunFailure(
        `channel listener unreachable: ${errorMessage(error)} — ${options.hint}`,
        channelFailureFor(null, error),
      )
    }
    if (!response.ok) {
      // The listener CHOSE this status; it is the authoritative cause and
      // needs no parsing.
      throw withRunFailure(
        `channel listener replied ${response.status} — ${options.hint}`,
        channelFailureFor(response.status, null),
      )
    }
  }
