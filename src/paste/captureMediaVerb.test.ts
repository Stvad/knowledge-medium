import { describe, expect, it } from 'vitest'
import type { Repo } from '@/data/repo.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { captureMediaVerb, type CaptureMediaInput, type CaptureMediaOutcome } from './captureMediaVerb.js'

const input = (over: Partial<CaptureMediaInput> = {}): CaptureMediaInput => ({
  repo: {} as Repo,
  workspaceId: 'ws',
  files: [new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })],
  ...over,
})

describe('captureMediaVerb (the media-capture effect seam)', () => {
  it('captures NOTHING by default — no provider installed (attachments off)', async () => {
    const runtime = resolveFacetRuntimeSync([])
    expect(await captureMediaVerb.run(runtime, input())).toEqual({ references: [] })
  })

  it('runs the registered impl with the input and returns its references (for the renderer to place)', async () => {
    const seen: CaptureMediaInput[] = []
    const runtime = resolveFacetRuntimeSync([
      captureMediaVerb.impl((i): CaptureMediaOutcome => {
        seen.push(i)
        return { references: ['((a))'] }
      }),
    ])
    expect(await captureMediaVerb.run(runtime, input({ workspaceId: 'ws-x' }))).toEqual({ references: ['((a))'] })
    expect(seen[0]).toMatchObject({ workspaceId: 'ws-x' })
  })

  it('a decorator can wrap/veto the effect (confirm-before-capture, throttle, swap uploader)', async () => {
    let captured = false
    const runtime = resolveFacetRuntimeSync([
      captureMediaVerb.impl((): CaptureMediaOutcome => {
        captured = true
        return { references: ['((a))'] }
      }),
      // A guard that declines to call `next` short-circuits the capture (no references).
      captureMediaVerb.decorator(() => () => ({ references: [] })),
    ])
    expect(await captureMediaVerb.run(runtime, input())).toEqual({ references: [] })
    expect(captured).toBe(false)
  })
})
