import { describe, expect, it } from 'vitest'
import type { Repo } from '@/data/repo.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { captureMediaVerb, type CaptureMediaInput } from './captureMediaVerb.js'

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
