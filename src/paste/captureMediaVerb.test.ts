import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { captureMediaVerb, fireCaptureMedia, type CaptureMediaInput } from './captureMediaVerb.js'

const input = (over: Partial<CaptureMediaInput> = {}): CaptureMediaInput => ({
  repo: {} as Repo,
  workspaceId: 'ws',
  parentBlockId: 'b1',
  files: [new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })],
  ...over,
})

describe('captureMediaVerb (the media-capture effect seam)', () => {
  it('is a no-op by default — no capture provider installed (attachments off)', () => {
    const runtime = resolveFacetRuntimeSync([])
    expect(captureMediaVerb.runSync(runtime, input())).toBeUndefined()
  })

  it('runs the registered impl with the input (the attachments plugin supplies it)', () => {
    const seen: CaptureMediaInput[] = []
    const runtime = resolveFacetRuntimeSync([captureMediaVerb.impl(i => void seen.push(i))])
    captureMediaVerb.runSync(runtime, input({ parentBlockId: 'parent-x' }))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ workspaceId: 'ws', parentBlockId: 'parent-x' })
  })

  it('a decorator can wrap/veto the effect (confirm-before-capture, throttle, swap uploader)', () => {
    let captured = false
    const runtime = resolveFacetRuntimeSync([
      captureMediaVerb.impl(() => void (captured = true)),
      // A guard that declines to call `next` short-circuits the capture.
      captureMediaVerb.decorator(() => () => {}),
    ])
    captureMediaVerb.runSync(runtime, input())
    expect(captured).toBe(false)
  })
})

describe('fireCaptureMedia (the host-handler-safe fire-and-forget wrapper)', () => {
  it('swallows a SYNCHRONOUS throw from a capture plugin (onError:rethrow would otherwise escape the paste handler)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A confirm-before-capture decorator that throws synchronously — under
    // onError:'rethrow' this propagates out of runSync, before the `.catch` exists.
    const runtime = resolveFacetRuntimeSync([
      captureMediaVerb.impl(() => {
        throw new Error('sync capture plugin blew up')
      }),
    ])
    // The host paste handler must not see the throw (the text half still pastes).
    expect(() => fireCaptureMedia(runtime, input())).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('swallows an ASYNC rejection (no unhandled rejection escapes)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      captureMediaVerb.impl(async () => {
        throw new Error('async capture failed')
      }),
    ])
    expect(() => fireCaptureMedia(runtime, input())).not.toThrow()
    // Let the rejected microtask settle into the wrapper's `.catch`.
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
