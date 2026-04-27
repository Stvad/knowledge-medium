import { describe, it, expect } from 'vitest'
import { buildAppHash, buildBlockHash, parseAppHash } from '@/utils/routing'

describe('parseAppHash', () => {
  it('returns empty when hash is empty/undefined/null', () => {
    expect(parseAppHash('')).toEqual({})
    expect(parseAppHash('#')).toEqual({})
    expect(parseAppHash(undefined)).toEqual({})
    expect(parseAppHash(null)).toEqual({})
  })

  it('parses workspace + block from #<wsId>/<blockId>', () => {
    expect(parseAppHash('#ws-1/block-2')).toEqual({
      workspaceId: 'ws-1',
      blockId: 'block-2',
    })
  })

  it('parses workspace-only hash', () => {
    expect(parseAppHash('#ws-1')).toEqual({
      workspaceId: 'ws-1',
      blockId: undefined,
    })
  })

  it('handles a missing leading #', () => {
    expect(parseAppHash('ws-1/block-2')).toEqual({
      workspaceId: 'ws-1',
      blockId: 'block-2',
    })
  })

  it('treats trailing slash as no block id', () => {
    expect(parseAppHash('#ws-1/')).toEqual({
      workspaceId: 'ws-1',
      blockId: undefined,
    })
  })
})

describe('buildAppHash', () => {
  it('renders workspace + block', () => {
    expect(buildAppHash('ws-1', 'block-2')).toBe('#ws-1/block-2')
  })

  it('renders workspace-only when blockId is omitted', () => {
    expect(buildAppHash('ws-1')).toBe('#ws-1')
  })
})

describe('buildBlockHash', () => {
  it('includes the workspace prefix when workspaceId is present', () => {
    expect(buildBlockHash('ws-1', 'block-2')).toBe('#ws-1/block-2')
  })

  it('falls back to a bare #<blockId> when workspaceId is missing', () => {
    // The legacy shape — won't resolve cleanly under the workspace-aware
    // bootstrap, but at least keeps the renderer from crashing.
    expect(buildBlockHash(null, 'block-2')).toBe('#block-2')
    expect(buildBlockHash(undefined, 'block-2')).toBe('#block-2')
  })
})
