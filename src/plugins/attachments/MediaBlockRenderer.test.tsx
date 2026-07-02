// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block.js'
import { typesProp } from '@/data/properties.js'
import type { BlockRendererProps } from '@/types.js'

// Control the block's props, the eager URL state, and the lazy resolve without the data layer.
const h = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  urlState: { status: 'loading' } as { status: string; url?: string; reason?: string },
  reportDecodeFailure: vi.fn(),
  resolve: vi.fn(),
  downloadBlob: vi.fn(),
  useAssetObjectUrl: vi.fn(),
}))
vi.mock('@/hooks/block.js', () => ({
  usePropertyValue: (_b: unknown, s: { name: string }) => [h.props[s.name], () => {}],
  useWorkspaceId: () => 'ws-A',
}))
// The eager hook returns [state, reportDecodeFailure]; the renderer wires onError → the latter.
// Record the call so a test can assert the renderer passed the right `{ enabled }` (the
// lazy-vs-eager gate) — the spy captures args; the return is the controlled state.
vi.mock('./useAssetObjectUrl.js', () => ({
  useAssetObjectUrl: (...args: unknown[]) => {
    h.useAssetObjectUrl(...args)
    return [h.urlState, h.reportDecodeFailure]
  },
}))
vi.mock('./assetResolver.js', () => ({ getAssetResolver: () => ({ resolve: h.resolve }) }))
vi.mock('@/utils/downloadBlob.js', () => ({ downloadBlob: h.downloadBlob }))
// The runtime resolves the media-viewer facet to the (real) image + PDF viewers, so an
// image mime dispatches to ImageViewer, application/pdf to PdfViewer, and everything
// else to the download fallback.
vi.mock('@/extensions/runtimeContext.js', async () => {
  const { imageMediaViewer, pdfMediaViewer } = await import('./mediaViewers.js')
  return { useAppRuntime: () => ({ read: () => [imageMediaViewer, pdfMediaViewer] }) }
})

const { MediaBlockRenderer, MediaContentRenderer } = await import('./MediaBlockRenderer.js')

const block = { repo: { activeWorkspaceId: 'ws-A' }, hasType: (t: string) => t === 'media' } as unknown as Block
const renderContent = () => render(<MediaContentRenderer block={block} />)

afterEach(cleanup)
beforeEach(() => {
  h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'image/png', 'media:filename': 'cat.png' }
  h.urlState = { status: 'loading' }
  h.reportDecodeFailure.mockClear()
  h.resolve.mockReset()
  h.resolve.mockResolvedValue({ ok: true, bytes: new Uint8Array([1, 2, 3]) })
  h.downloadBlob.mockReset()
  h.useAssetObjectUrl.mockClear()
})

describe('MediaContentRenderer — image branch', () => {
  it('renders the lightbox <img> at the object URL when resolved', () => {
    h.urlState = { status: 'ready', url: 'blob:fake/1' }
    renderContent()
    const img = screen.getByRole('img', { name: 'cat.png' })
    expect(img).toHaveAttribute('src', 'blob:fake/1')
    // The image viewer is EAGER: the renderer resolves its bytes up front.
    expect(h.useAssetObjectUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { enabled: true })
  })

  it('shows the loading placeholder while resolving', () => {
    h.urlState = { status: 'loading' }
    renderContent()
    expect(screen.getByTestId('media-loading')).toBeInTheDocument()
  })

  it('shows the broken-asset placeholder (and NO real <img>) on a fail-closed resolve', () => {
    h.urlState = { status: 'error', reason: 'hash-mismatch' }
    const { container } = renderContent()
    expect(screen.getByTestId('media-broken')).toBeInTheDocument()
    // The load-bearing assertion: nothing is ever served for an unverified asset.
    expect(container.querySelector('img')).toBeNull()
  })

  it('reports a decode failure to the hook when verified bytes fail to DECODE', () => {
    // The bytes hash-verified, but the <img> can't decode them — e.g. an untrusted
    // media:mime claiming image/* over non-image bytes. The renderer must report it
    // so the hook REVOKES the object URL (frees the Blob) and goes terminal — the
    // resulting error→placeholder is covered by the fail-closed test above and the
    // hook's own test; here we pin the renderer's onError → reportDecodeFailure wire.
    h.urlState = { status: 'ready', url: 'blob:fake/undecodable' }
    renderContent()
    fireEvent.error(screen.getByRole('img', { name: 'cat.png' }))
    expect(h.reportDecodeFailure).toHaveBeenCalledWith('blob:fake/undecodable')
  })
})

describe('MediaContentRenderer — non-image (file) branch', () => {
  // A mime claimed by NO registered viewer (not image/*, not application/pdf) so it hits
  // the download fallback — PDF now has its own inline viewer, so it can't stand in here.
  const fileProps = (extra: Record<string, unknown> = {}) => {
    h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'application/zip', 'media:filename': 'doc.zip', ...extra }
  }

  it('renders a METADATA-ONLY download button — no eager resolve — for a non-image MIME', () => {
    fileProps({ 'media:size': 2_100_000 })
    h.urlState = { status: 'ready', url: 'blob:should-not-be-used' } // eager state is ignored here
    renderContent()
    const btn = screen.getByTestId('media-file')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn).toHaveTextContent('doc.zip')
    expect(btn).toHaveTextContent('2 MB')
    expect(screen.queryByRole('img')).toBeNull() // not the image lightbox
    // The download fallback is LAZY: the renderer must gate the eager resolve OFF for it,
    // so no object-URL Blob is held for a download nobody clicked (guards the viewer.eager wiring).
    expect(h.useAssetObjectUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { enabled: false })
    expect(h.resolve).not.toHaveBeenCalled() // and nothing is fetched until a download click
  })

  it('resolves the VERIFIED bytes on click and downloads them as a NEUTRAL octet-stream blob', async () => {
    fileProps()
    renderContent()
    fireEvent.click(screen.getByTestId('media-file'))
    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalledTimes(1))
    const [blob, name] = h.downloadBlob.mock.calls[0]
    expect(name).toBe('doc.zip')
    // NEVER the attacker-influenceable media:mime — a neutral type so a navigated blob URL
    // downloads instead of rendering (no same-origin XSS via media:mime = text/html).
    expect(blob.type).toBe('application/octet-stream')
  })

  it('fails closed on a failed resolve — nothing downloaded, retryable error affordance', async () => {
    fileProps()
    h.resolve.mockResolvedValue({ ok: false, reason: 'hash-mismatch' })
    renderContent()
    const btn = screen.getByTestId('media-file')
    fireEvent.click(btn)
    await waitFor(() => expect(btn).toHaveTextContent('unavailable'))
    // The load-bearing assertion: nothing is ever served for an unverified/failed asset.
    expect(h.downloadBlob).not.toHaveBeenCalled()
    expect(btn).toBeEnabled() // still clickable to retry a transient failure
  })

  it('names the download from the filename, else a generic name; omits size when unknown', async () => {
    h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'application/zip', 'media:size': 0 }
    renderContent()
    const btn = screen.getByTestId('media-file')
    expect(btn).toHaveTextContent('application/zip') // mime is the label fallback
    expect(btn).not.toHaveTextContent('B') // size 0/unknown → no size shown (guards the `> 0` check)
    fireEvent.click(btn)
    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalled())
    expect(h.downloadBlob.mock.calls[0][1]).toBe('attachment') // generic download name
  })
})

describe('MediaContentRenderer — PDF branch', () => {
  const pdfProps = (extra: Record<string, unknown> = {}) => {
    h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'application/pdf', 'media:filename': 'doc.pdf', ...extra }
  }

  it('renders a bounded inline <object> of the VERIFIED object URL, typed application/pdf', () => {
    pdfProps()
    h.urlState = { status: 'ready', url: 'blob:pdf/1' }
    const { container } = renderContent()
    expect(screen.getByTestId('media-pdf')).toBeInTheDocument()
    const object = container.querySelector('object')
    expect(object).toHaveAttribute('data', 'blob:pdf/1')
    // Pinned to application/pdf so the browser hands it to its PDF viewer, never HTML-sniffs it.
    expect(object).toHaveAttribute('type', 'application/pdf')
    // The PDF viewer is EAGER: the renderer resolves the object URL up front for the inline preview.
    expect(h.useAssetObjectUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { enabled: true })
  })

  it('shows the loading placeholder while resolving', () => {
    pdfProps()
    h.urlState = { status: 'loading' }
    renderContent()
    expect(screen.getByTestId('media-loading')).toBeInTheDocument()
  })

  it('shows the broken-asset placeholder (and NO object) on a fail-closed resolve', () => {
    pdfProps()
    h.urlState = { status: 'error', reason: 'hash-mismatch' }
    const { container } = renderContent()
    expect(screen.getByTestId('media-broken')).toBeInTheDocument()
    // The load-bearing assertion: nothing is ever served for an unverified asset.
    expect(container.querySelector('object')).toBeNull()
  })

  it('downloads the VERIFIED bytes as a NEUTRAL octet-stream blob on the download click', async () => {
    pdfProps()
    h.urlState = { status: 'ready', url: 'blob:pdf/1' }
    renderContent()
    fireEvent.click(screen.getByTestId('media-pdf-download'))
    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalledTimes(1))
    const [blob, name] = h.downloadBlob.mock.calls[0]
    expect(name).toBe('doc.pdf')
    // NEVER a navigable blob typed with the attacker-influenceable media:mime.
    expect(blob.type).toBe('application/octet-stream')
  })

  it('fails the download closed on a failed resolve — nothing downloaded, retryable', async () => {
    pdfProps()
    h.urlState = { status: 'ready', url: 'blob:pdf/1' }
    h.resolve.mockResolvedValue({ ok: false, reason: 'fetch-failed' })
    renderContent()
    const btn = screen.getByTestId('media-pdf-download')
    fireEvent.click(btn)
    await waitFor(() => expect(btn).toHaveTextContent('Retry'))
    expect(h.downloadBlob).not.toHaveBeenCalled()
    expect(btn).toBeEnabled() // still clickable to retry a transient failure
  })
})

describe('MediaBlockRenderer.canRender', () => {
  // canRender must gate on a LOADED snapshot via peek() — `block.hasType()` reads
  // block.data, which THROWS for a not-yet-loaded / missing row, and useRenderer
  // runs canRender for every block during its load window.
  const peeking = (value: unknown) => ({ peek: () => value }) as unknown as Block
  const typed = (types: string[]) => ({ properties: { [typesProp.name]: typesProp.codec.encode(types) } })

  it('returns true only for a loaded media-typed block', () => {
    expect(MediaBlockRenderer.canRender?.({ block: peeking(typed(['media'])) } as BlockRendererProps)).toBe(true)
    expect(MediaBlockRenderer.canRender?.({ block: peeking(typed(['note'])) } as BlockRendererProps)).toBe(false)
  })

  it('never throws on a not-yet-loaded (undefined) or confirmed-missing (null) block', () => {
    expect(MediaBlockRenderer.canRender?.({ block: peeking(undefined) } as BlockRendererProps)).toBe(false)
    expect(MediaBlockRenderer.canRender?.({ block: peeking(null) } as BlockRendererProps)).toBe(false)
  })

  it('never throws on a malformed types value (raw read, not the throwing codec)', () => {
    // The cache boundary validates JSON syntax, not shape — a corrupt/legacy row
    // could carry types: "media" (string) or [1] (non-string). canRender must
    // read it total (Array.isArray), never route through the throwing codec.
    const malformed = (types: unknown) => peeking({ properties: { types } })
    expect(MediaBlockRenderer.canRender?.({ block: malformed('media') } as BlockRendererProps)).toBe(false)
    expect(MediaBlockRenderer.canRender?.({ block: malformed([1, 2]) } as BlockRendererProps)).toBe(false)
    expect(MediaBlockRenderer.canRender?.({ block: malformed(undefined) } as BlockRendererProps)).toBe(false)
  })
})
