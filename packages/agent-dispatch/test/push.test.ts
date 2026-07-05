import {describe, expect, it, vi} from 'vitest'
import type {EventsNextResponse} from '@knowledge-medium/agent-cli/protocol'
import {parseConfig} from '../src/config'
import {
  buildRegistrationWatchers,
  CLEAR_REGISTRATION_TIMEOUT_MS,
  clearPushRegistration,
  createExemptionPool,
  EXEMPTION_POOL_TTL_MS,
  MAX_EXEMPTION_AGE_MS,
  MAX_PENDING_EXEMPT_IDS,
  PUSH_CONSUMER,
  REGISTRATION_REFRESH_MS,
  REGISTRATION_TTL_MS,
  startPushLoop,
} from '../src/push'

const config = parseConfig({
  watchers: [
    {kind: 'backlinks', name: 'claude-mentions', target: 'claude', quietMs: 5_000},
    {kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks', tables: ['blocks', 'block_references']},
  ],
})

const graph = {resolvePageId: vi.fn(async (alias: string) => `page:${alias}`)}

const settled = (consumer: string, watcher: string, seq: number) => ({
  seq,
  receivedAt: 0,
  clientId: 'tab',
  event: {type: 'watcher-settled', consumer, watcher},
})

/** Drive the loop through a script of nextEvents outcomes, then stop it.
 *  Each entry is either a response or an error to throw; when the script
 *  is exhausted the loop sees isStopping() === true. */
const runLoop = async (script: Array<EventsNextResponse | Error>, overrides: {nowStep?: number} = {}) => {
  const responses = [...script]
  let clock = 0
  const runCommands: Array<Record<string, unknown>> = []
  const naps: number[] = []
  const requestTick = vi.fn()
  const log = vi.fn()

  await startPushLoop({
    client: {
      runCommand: vi.fn(async command => {
        runCommands.push(command as unknown as Record<string, unknown>)
        return {}
      }),
      nextEvents: vi.fn(async () => {
        clock += overrides.nowStep ?? 0
        const next = responses.shift()
        if (next === undefined) throw new Error('script exhausted')
        if (next instanceof Error) throw next
        return next
      }),
    },
    config,
    graph,
    requestTick,
    log,
    isStopping: () => responses.length === 0,
    nap: async ms => { naps.push(ms) },
    now: () => clock,
  })

  return {runCommands, naps, requestTick, log}
}

describe('buildRegistrationWatchers', () => {
  it('maps config watchers to tab-side registrations', async () => {
    const watchers = await buildRegistrationWatchers(config.watchers, graph)
    expect(watchers).toEqual([
      // Quiet period measured at the source: settleMs = quietMs.
      {kind: 'backlinks', name: 'claude-mentions', targetId: 'page:claude', settleMs: 5_000},
      {kind: 'sql', name: 'inbox', sql: 'SELECT id FROM blocks', params: [], tables: ['blocks', 'block_references'], settleMs: 1_000},
    ])
  })

  it('clears the daemon consumer with an empty registration', async () => {
    const client = {runCommand: vi.fn(async () => ({}))}

    await clearPushRegistration(client)

    expect(client.runCommand).toHaveBeenCalledWith({
      type: 'watch-events',
      consumer: PUSH_CONSUMER,
      watchers: [],
      ttlMs: REGISTRATION_TTL_MS,
    }, {timeoutMs: CLEAR_REGISTRATION_TIMEOUT_MS})
  })
})

describe('createExemptionPool', () => {
  const exemptions = (watcher: string, ...ids: string[]) =>
    new Map([[watcher, new Set(ids)]])

  it('pools per watcher, dedupes, and drains everything fresh', () => {
    const pool = createExemptionPool(() => 0)
    pool.add(exemptions('claude-mentions', 'b1', 'b2'))
    pool.add(exemptions('claude-mentions', 'b2'))
    pool.add(exemptions('inbox', 'b3'))

    expect(pool.drain()).toEqual(new Map([
      ['claude-mentions', new Set(['b1', 'b2'])],
      ['inbox', new Set(['b3'])],
    ]))
    // Drain empties the pool.
    expect(pool.drain()).toEqual(new Map())
  })

  it('drops exemptions that aged out in the pool (delayed drain)', () => {
    let clock = 0
    const pool = createExemptionPool(() => clock)
    pool.add(exemptions('claude-mentions', 'stale'))
    clock += EXEMPTION_POOL_TTL_MS + 1
    pool.add(exemptions('claude-mentions', 'fresh'))

    // A sick bridge stalled the tick; by drain time 'stale' may be
    // mid-retype again — only 'fresh' survives.
    expect(pool.drain()).toEqual(new Map([['claude-mentions', new Set(['fresh'])]]))
  })

  it('caps the pooled id count', () => {
    const pool = createExemptionPool(() => 0)
    const ids = Array.from({length: MAX_PENDING_EXEMPT_IDS + 10}, (_, index) => `b${index}`)
    pool.add(new Map([['claude-mentions', new Set(ids)]]))
    const drained = pool.drain()
    expect(drained.get('claude-mentions')!.size).toBe(MAX_PENDING_EXEMPT_IDS)
  })

  it('evicts aged-out ids at the cap so fresh exemptions still land (stalled-tick squatters)', () => {
    let clock = 0
    const pool = createExemptionPool(() => clock)
    const staleIds = Array.from({length: MAX_PENDING_EXEMPT_IDS}, (_, index) => `stale${index}`)
    pool.add(new Map([['claude-mentions', new Set(staleIds)]]))

    // A stalled tick left the pool full of now-expired ids; a fresh
    // blur must displace them, not bounce off the cap.
    clock += EXEMPTION_POOL_TTL_MS + 1
    pool.add(exemptions('claude-mentions', 'fresh'))

    expect(pool.drain()).toEqual(new Map([['claude-mentions', new Set(['fresh'])]]))
  })
})

describe('startPushLoop', () => {
  it('registers once, then ticks on events for its consumer', async () => {
    const {runCommands, requestTick} = await runLoop([
      {events: [], nextSeq: 0},
      {events: [settled(PUSH_CONSUMER, 'claude-mentions', 1)], nextSeq: 1},
    ])

    expect(runCommands).toHaveLength(1)
    expect(runCommands[0]).toMatchObject({type: 'watch-events', consumer: PUSH_CONSUMER, ttlMs: REGISTRATION_TTL_MS})
    expect(requestTick).toHaveBeenCalledTimes(1)
  })

  it('forwards settledBlocks as per-watcher quiet-exemptions to requestTick', async () => {
    const {requestTick} = await runLoop([
      {events: [], nextSeq: 0},
      {
        events: [
          {
            seq: 1, receivedAt: 0, clientId: 'tab',
            event: {type: 'watcher-settled', consumer: PUSH_CONSUMER, watcher: 'claude-mentions', settledBlocks: ['block-1', 'block-2']},
          },
          {
            seq: 2, receivedAt: 0, clientId: 'tab',
            // A DIFFERENT watcher's settle must not merge into the same
            // exemption pool — its (possibly much shorter) settle window
            // can't vouch for another watcher's quietMs.
            event: {type: 'watcher-settled', consumer: PUSH_CONSUMER, watcher: 'inbox', settledBlocks: ['block-3']},
          },
        ],
        nextSeq: 2,
      },
    ])
    expect(requestTick).toHaveBeenCalledWith(new Map([
      ['claude-mentions', new Set(['block-1', 'block-2'])],
      ['inbox', new Set(['block-3'])],
    ]))
  })

  it('drops exemptions (but still ticks) from stale replayed events', async () => {
    const {requestTick} = await runLoop([
      {events: [], nextSeq: 0},
      {
        events: [{
          // Replayed after a backoff: received long before the loop saw
          // it. The user may have re-entered the block since — exempting
          // it now would claim mid-typing content.
          seq: 1, receivedAt: -(MAX_EXEMPTION_AGE_MS + 1), clientId: 'tab',
          event: {type: 'watcher-settled', consumer: PUSH_CONSUMER, watcher: 'claude-mentions', settledBlocks: ['block-1']},
        }],
        nextSeq: 1,
      },
    ])
    expect(requestTick).toHaveBeenCalledTimes(1)
    expect(requestTick).toHaveBeenCalledWith(new Map())
  })

  it('ignores events for other consumers', async () => {
    const {requestTick} = await runLoop([
      {events: [], nextSeq: 0},
      {events: [settled('someone-else', 'their-watcher', 1)], nextSeq: 1},
    ])
    expect(requestTick).not.toHaveBeenCalled()
  })

  it('a reset cursor re-registers and sweeps once', async () => {
    const {runCommands, requestTick} = await runLoop([
      {events: [], nextSeq: 0},
      {events: [], nextSeq: 0, reset: true},
      {events: [], nextSeq: 0},
    ])
    expect(requestTick).toHaveBeenCalledTimes(1)
    expect(runCommands).toHaveLength(2) // initial + post-reset
  })

  it('refreshes the registration once the refresh interval elapses', async () => {
    const {runCommands} = await runLoop(
      [
        {events: [], nextSeq: 0},
        {events: [], nextSeq: 0},
        {events: [], nextSeq: 0},
      ],
      // Each poll advances the clock past the refresh threshold.
      {nowStep: REGISTRATION_REFRESH_MS + 1},
    )
    expect(runCommands.length).toBeGreaterThanOrEqual(2)
  })

  it('errors back off and re-register, without killing the loop', async () => {
    const {runCommands, naps, requestTick} = await runLoop([
      {events: [], nextSeq: 0},
      new Error('bridge poll failed: 503'),
      {events: [settled(PUSH_CONSUMER, 'inbox', 1)], nextSeq: 1},
    ])
    expect(naps).toEqual([15_000])
    expect(runCommands).toHaveLength(2) // re-registered after the error
    expect(requestTick).toHaveBeenCalledTimes(1)
  })

  it('an unsupported tab backs off long instead of hot-looping', async () => {
    const {naps} = await runLoop([
      {events: [], nextSeq: 0},
      new Error('Unknown agent runtime command: watch-events'),
      {events: [], nextSeq: 0},
    ])
    expect(naps).toEqual([5 * 60_000])
  })

  it('a read-only token scope rejection also backs off long — retrying cannot fix it', async () => {
    const {naps} = await runLoop([
      new Error('Token scope read-only does not permit command watch-events'),
      {events: [], nextSeq: 0},
    ])
    expect(naps).toEqual([5 * 60_000])
  })
})
