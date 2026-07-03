import {describe, expect, it, vi} from 'vitest'
import type {EventsNextResponse} from '@knowledge-medium/agent-cli/protocol'
import {parseConfig} from '../src/config'
import {
  buildRegistrationWatchers,
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
    const watchers = await buildRegistrationWatchers(config, graph)
    expect(watchers).toEqual([
      // Quiet period measured at the source: settleMs = quietMs.
      {kind: 'backlinks', name: 'claude-mentions', targetId: 'page:claude', settleMs: 5_000},
      {kind: 'sql', name: 'inbox', sql: 'SELECT id FROM blocks', params: [], tables: ['blocks', 'block_references'], settleMs: 1_000},
    ])
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

  it('forwards settledBlocks as quiet-exemptions to requestTick', async () => {
    const {requestTick} = await runLoop([
      {events: [], nextSeq: 0},
      {
        events: [{
          seq: 1, receivedAt: 0, clientId: 'tab',
          event: {type: 'watcher-settled', consumer: PUSH_CONSUMER, watcher: 'claude-mentions', settledBlocks: ['block-1', 'block-2']},
        }],
        nextSeq: 1,
      },
    ])
    expect(requestTick).toHaveBeenCalledWith(['block-1', 'block-2'])
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
})
