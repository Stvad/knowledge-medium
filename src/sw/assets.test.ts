import {describe, expect, it} from 'vitest'
import {isCacheableAsset} from './assets'

describe('isCacheableAsset', () => {
  it('matches by request.destination even when the path carries no asset extension', () => {
    // The browser labels module/preload/style/worker/font/image requests, and
    // the URL may have a query or no extension — destination is the primary signal.
    expect(isCacheableAsset('script', '/src/main', true)).toBe(true)
    expect(isCacheableAsset('style', '/assets/x', true)).toBe(true)
    expect(isCacheableAsset('worker', '/wasm-worker', true)).toBe(true)
  })

  it('falls back to the extension when the browser left destination empty', () => {
    expect(isCacheableAsset('', '/src/data/api/blockType.js', true)).toBe(true)
    expect(isCacheableAsset('', '/assets/inter.woff2', true)).toBe(true)
    expect(isCacheableAsset('', '/foo/thing.wasm', true)).toBe(true)
  })

  it('is false for a same-origin non-asset with no asset destination', () => {
    // version.json must stay fresh (network), not be served cache-first.
    expect(isCacheableAsset('', '/version.json', true)).toBe(false)
    expect(isCacheableAsset('fetch', '/api/thing', true)).toBe(false)
  })

  it('never claims a cross-origin request, whatever its destination/extension', () => {
    expect(isCacheableAsset('script', '/src/main.js', false)).toBe(false)
    expect(isCacheableAsset('image', '/icon.png', false)).toBe(false)
  })
})
