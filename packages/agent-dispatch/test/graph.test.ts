import {describe, expect, it, vi} from 'vitest'
import type {BridgeClient} from '@knowledge-medium/agent-cli/client'
import {createGraph} from '../src/graph'
import {statedRunFailure} from '../src/runFailure'

/** A bridge whose every command rejects, as a slow or absent app tab does.
 *  `runCommand` is the real entry point — a double with the wrong method
 *  name still "passes" these tests, on a TypeError rather than a bridge
 *  failure, because everything from this boundary classifies the same. */
const failingClient = (message: string): BridgeClient =>
  ({
    bridgeUrl: 'http://127.0.0.1:0',
    runCommand: vi.fn(async () => { throw new Error(message) }),
  }) as unknown as BridgeClient

describe('bridge failures leave with their cause attached', () => {
  it('classifies a command timeout as transport, not as a bad task', async () => {
    // Everything between claiming a block and running it goes through the
    // bridge. Left to the string matcher, the 60s command timeout arrived as
    // unrecognised prose and parked the claimed block as a dead task.
    const graph = createGraph(failingClient('Timed out waiting for runtime command get-subtree'))
    const error = await graph.getSubtree('b-1').then(() => null, (thrown: unknown) => thrown)

    expect(statedRunFailure(error)).toMatchObject({kind: 'network', retryable: true})
  })

  it('classifies a dropped client the same way, without knowing its wording', async () => {
    const graph = createGraph(failingClient('Target client is not currently connected.'))
    const error = await graph.getBlock('b-1').then(() => null, (thrown: unknown) => thrown)

    expect(statedRunFailure(error)).toMatchObject({kind: 'network', retryable: true})
  })

  it('leaves a command the app REFUSED alone — that is an answer, not an outage', async () => {
    // Dressing a rejection as a transport failure cooled the whole executor
    // lane, so deleting one block could pause every unrelated watcher on it.
    const rejecting = {
      bridgeUrl: 'http://127.0.0.1:0',
      runCommand: vi.fn(async () => {
        throw Object.assign(new Error('updateBlock: block b-1 not found'), {__kmCommandRejected: true})
      }),
    } as unknown as BridgeClient
    const graph = createGraph(rejecting)
    const error = await graph.getBlock('b-1').then(() => null, (thrown: unknown) => thrown)

    expect(statedRunFailure(error)).toBeNull()
    expect((error as Error).message).toContain('not found')
  })

  it('keeps the original message, so the log still says what happened', async () => {
    const graph = createGraph(failingClient('Timed out waiting for runtime command get-subtree'))
    await expect(graph.getSubtree('b-1')).rejects.toThrow(/Timed out waiting for runtime command/)
  })
})
