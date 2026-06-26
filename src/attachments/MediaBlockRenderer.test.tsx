import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block.js'
import { typesProp } from '@/data/properties.js'
import type { BlockRendererProps } from '@/types.js'

// Control the block's props + the resolved URL state without the data layer.
const h = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  urlState: { status: 'loading' } as { status: string; url?: string; reason?: string },
}))
vi.mock('@/hooks/block.js', () => ({
  usePropertyValue: (_b: unknown, s: { name: string }) => [h.props[s.name], () => {}],
  useWorkspaceId: () => 'ws-A',
}))
vi.mock('./useAssetObjectUrl.js', () => ({ useAssetObjectUrl: () => h.urlState }))
vi.mock('./assetResolver.js', () => ({
  getAssetResolver: () => ({ resolve: async () => ({ ok: false, reason: 'error' }) }),
}))

const { MediaBlockRenderer, MediaContentRenderer } = await import('./MediaBlockRenderer.js')

const block = { repo: { activeWorkspaceId: 'ws-A' }, hasType: (t: string) => t === 'media' } as unknown as Block
const renderContent = () => render(<MediaContentRenderer block={block} />)

afterEach(cleanup)
beforeEach(() => {
  h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'image/png', 'media:filename': 'cat.png' }
  h.urlState = { status: 'loading' }
})

describe('MediaContentRenderer — image branch', () => {
  it('renders the lightbox <img> at the object URL when resolved', () => {
    h.urlState = { status: 'ready', url: 'blob:fake/1' }
    renderContent()
    const img = screen.getByRole('img', { name: 'cat.png' })
    expect(img).toHaveAttribute('src', 'blob:fake/1')
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
})

describe('MediaContentRenderer — non-image branch', () => {
  it('renders a file chip for a non-image MIME, regardless of resolve state', () => {
    h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'application/pdf', 'media:filename': 'doc.pdf' }
    h.urlState = { status: 'ready', url: 'blob:should-not-be-used' }
    renderContent()
    expect(screen.getByTestId('media-file')).toHaveTextContent('doc.pdf')
    expect(screen.queryByRole('img')).toBeNull()
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
})
