import {describe, expect, it} from 'vitest'
import {collectRestAssets, isPrecacheableAsset} from './precache-assets'

describe('isPrecacheableAsset', () => {
  it('accepts the same-origin runtime asset types the SW serves cache-first', () => {
    for (const rel of [
      'src/main.js',
      'src/extensions/api.js',
      'assets/index.css',
      'node_modules/@journeyapps/wa-sqlite/wa-sqlite.wasm',
      'assets/inter.woff2',
      'icon-192.png',
      'icon.svg',
    ]) {
      expect(isPrecacheableAsset(rel), rel).toBe(true)
    }
  })

  it('rejects sourcemaps, the SW itself, and non-asset files', () => {
    // .map is dev-only (~30MB) and never fetched by the running app; sw.js is
    // managed by the SW lifecycle, not imported; version.json must stay fresh;
    // the shell HTML/manifest are handled network-first, not from the asset set.
    for (const rel of [
      'src/main.js.map',
      'sw.js',
      'version.json',
      'index.html',
      'manifest.webmanifest',
    ]) {
      expect(isPrecacheableAsset(rel), rel).toBe(false)
    }
  })
})

describe('collectRestAssets', () => {
  const toBaseUrl = (rel: string) => `/${rel.replace(/^\/+/, '')}`

  it('is the full emitted asset graph minus first-paint, base-prefixed + sorted', () => {
    const allFiles = [
      'src/main.js', // first-paint — excluded
      'assets/index.css', // first-paint — excluded
      'src/extensions/api.js', // lazy — the module whose skew this precache fixes
      'src/data/api/blockType.js', // lazy
      'node_modules/@babel/standalone/babel.js', // lazy (was the babel-only list)
    ]
    const restAssets = collectRestAssets({
      allFiles,
      firstPaint: ['/src/main.js', '/assets/index.css'],
      toBaseUrl,
    })
    expect(restAssets).toEqual([
      '/node_modules/@babel/standalone/babel.js',
      '/src/data/api/blockType.js',
      '/src/extensions/api.js',
    ])
  })

  it('drops sourcemaps, sw.js, and other non-cacheable files by construction', () => {
    const restAssets = collectRestAssets({
      allFiles: [
        'src/main.js.map',
        'sw.js',
        'version.json',
        'index.html',
        'src/extensions/api.js',
      ],
      firstPaint: [],
      toBaseUrl,
    })
    expect(restAssets).toEqual(['/src/extensions/api.js'])
  })

  it('excludes ONLY the root sw.js — a nested dep sw.js stays precached (not grafted)', () => {
    const restAssets = collectRestAssets({
      allFiles: ['sw.js', 'node_modules/some-dep/sw.js', 'src/main.js'],
      firstPaint: [],
      toBaseUrl,
    })
    expect(restAssets).toEqual(['/node_modules/some-dep/sw.js', '/src/main.js'])
  })

  it('honors a non-root base path so URLs resolve against the SW scope', () => {
    const baseUrl = (rel: string) => `/knowledge-medium/${rel.replace(/^\/+/, '')}`
    const restAssets = collectRestAssets({
      allFiles: ['src/main.js', 'src/lazy.js'],
      firstPaint: ['/knowledge-medium/src/main.js'],
      toBaseUrl: baseUrl,
    })
    expect(restAssets).toEqual(['/knowledge-medium/src/lazy.js'])
  })
})
