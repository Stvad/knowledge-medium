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

/** Ports `fetch` refuses outright (the WHATWG "bad port" list). `new URL`
 *  accepts them, so only the request fails — locally, identically, every
 *  time — and a per-delivery rejection reads as a transport outage: the
 *  task defers forever instead of saying the port is unusable. A fixed spec
 *  list is worth carrying to turn that into one error at wiring time. */
const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
])

export const createChannelDelivery = (options: ChannelDeliveryOptions) => {
  if (FETCH_BLOCKED_PORTS.has(options.port)) {
    throw new Error(`channel port ${options.port} is one fetch refuses to connect to — pick another`)
  }
  // Built ONCE, here, and deliberately outside the classified path below: a
  // URL that cannot be constructed is a configuration error no amount of
  // retrying fixes, and letting it reject per-delivery would read as a
  // transport outage and defer every channel task indefinitely. Failing at
  // wiring time says what is actually wrong. (`config.ts` bounds the port
  // too, so this is the backstop rather than the first line of defence.)
  const endpoint = new URL(`http://127.0.0.1:${options.port}/`).toString()
  return async (event: ChannelEvent): Promise<void> => {
    const send = options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await send(endpoint, {
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
}
