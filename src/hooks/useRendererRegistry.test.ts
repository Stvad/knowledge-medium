import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BlockRenderer, RendererRegistry } from '@/types.js'
import { resolveRendererFromRegistry } from './useRendererRegistry.js'

const block = {} as Parameters<BlockRenderer>[0]['block']

const makeRenderer = (
  name: string,
  options: {
    canRender?: boolean
    priority?: number
  } = {},
): BlockRenderer => {
  const renderer = (() => null) as BlockRenderer
  renderer.displayName = name
  if (options.canRender !== undefined) {
    renderer.canRender = () => options.canRender ?? false
  }
  if (options.priority !== undefined) {
    renderer.priority = () => options.priority ?? 0
  }
  return renderer
}

describe('resolveRendererFromRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a registered renderer override without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const selected = makeRenderer('selected')
    const fallback = makeRenderer('fallback', {canRender: true, priority: 10})
    const registry: RendererRegistry = {
      default: makeRenderer('default'),
      fallback,
      selected,
    }

    const resolved = resolveRendererFromRegistry({
      block,
      registry,
      rendererKey: 'selected',
    })

    expect(resolved).toBe(selected)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns and falls through when a renderer override is not registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lowPriority = makeRenderer('low', {canRender: true, priority: 1})
    const highPriority = makeRenderer('high', {canRender: true, priority: 10})
    const registry: RendererRegistry = {
      default: makeRenderer('default'),
      highPriority,
      lowPriority,
    }

    const resolved = resolveRendererFromRegistry({
      block,
      registry,
      rendererKey: 'misspelled',
    })

    expect(resolved).toBe(highPriority)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('misspelled'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('default, highPriority, lowPriority'))
  })
})
