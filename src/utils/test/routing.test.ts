import { describe, it, expect } from 'vitest'
import { buildAppHash, parseAppHash } from '@/utils/routing'

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

  it('ignores hash query parameters used for local bridge pairing', () => {
    expect(parseAppHash('#ws-1/block-2?agent-runtime-secret=secret')).toEqual({
      workspaceId: 'ws-1',
      blockId: 'block-2',
    })
    expect(parseAppHash('#?agent-runtime-secret=secret')).toEqual({})
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
