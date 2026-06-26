import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { captureMediaVerb } from '@/paste/captureMediaVerb.js'
import { pasteDecisionVerb, type PasteRequest } from '@/paste/decision.js'

// Stub the up-lane so the capture-impl test asserts the WIRING (arg mapping) without
// real capture/upload — and without loading assetUpload's heavy deps.
const mocks = vi.hoisted(() => ({
  captureMediaFromFiles: vi.fn(async () => []),
  reportCaptureFailures: vi.fn(),
}))
vi.mock('./assetUpload.js', () => mocks)

const { captureMediaContribution, mediaPasteDecisionContribution } = await import('./pasteCapture.js')

const pngFile = () => new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' })

const shell = (over: { text?: string; files?: readonly File[] } = {}): PasteRequest => ({
  text: over.text ?? '',
  intent: 'split',
  surface: 'shell',
  files: over.files,
})

describe('mediaPasteDecisionContribution (attachments-owned paste rule)', () => {
  // The runtime carries ONLY this contribution — i.e. the plugin is "on". With the
  // attachments plugin off, this contribution isn't present (see decision.test.ts:
  // a file paste is then text-only).
  const runtime = resolveFacetRuntimeSync([mediaPasteDecisionContribution])

  it('a file paste decides media (and the media kind passes the verb validateResult)', () => {
    expect(pasteDecisionVerb.runSync(runtime, shell({ files: [pngFile()] }))).toEqual({ kind: 'media' })
  })

  it('a file+text paste still decides media (the FILE half — the renderer pastes the text separately)', () => {
    expect(pasteDecisionVerb.runSync(runtime, shell({ files: [pngFile()], text: 'a\nb' }))).toEqual({ kind: 'media' })
  })

  it('defers to the text decision when there are no files (never hijacks a plain text paste)', () => {
    // This is also what the renderer's "text half" re-run (files stripped) relies on.
    expect(pasteDecisionVerb.runSync(runtime, shell({ text: 'a\nb' }))).toEqual({ kind: 'split' })
    expect(pasteDecisionVerb.runSync(runtime, shell({ files: [], text: 'a\nb' }))).toEqual({ kind: 'split' })
  })
})

describe('captureMediaContribution (the captureMediaVerb impl)', () => {
  it('forwards the verb input to captureMediaFromFiles, then reports failures', async () => {
    mocks.captureMediaFromFiles.mockClear()
    mocks.reportCaptureFailures.mockClear()
    const runtime = resolveFacetRuntimeSync([captureMediaContribution])
    const repo = {} as Repo
    const files = [pngFile()]
    await captureMediaVerb.runSync(runtime, { repo, workspaceId: 'ws', parentBlockId: 'b1', files })
    expect(mocks.captureMediaFromFiles).toHaveBeenCalledWith(repo, 'ws', 'b1', files)
    expect(mocks.reportCaptureFailures).toHaveBeenCalledTimes(1)
  })
})
