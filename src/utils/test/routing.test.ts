import { describe, it, expect } from 'vitest'
import {
  buildAppHash,
  buildLayout,
  buildLayoutFromSlots,
  layoutWorkspaceChanged,
  parseAppHash,
  parseLayout,
  preserveHashQueryParams,
} from '@/utils/routing'

describe('parseLayout', () => {
  it('returns an empty block list when hash is empty/undefined/null', () => {
    expect(parseLayout('')).toEqual({slots: [], blockIds: []})
    expect(parseLayout('#')).toEqual({slots: [], blockIds: []})
    expect(parseLayout(undefined)).toEqual({slots: [], blockIds: []})
    expect(parseLayout(null)).toEqual({slots: [], blockIds: []})
  })

  it('parses a workspace with no blocks', () => {
    expect(parseLayout('#ws-1')).toEqual({
      workspaceId: 'ws-1',
      slots: [],
      blockIds: [],
    })
  })

  it('parses a workspace with one block', () => {
    expect(parseLayout('#ws-1/block-1')).toEqual({
      workspaceId: 'ws-1',
      slots: [{kind: 'leaf', blockId: 'block-1'}],
      blockIds: ['block-1'],
    })
  })

  it('parses a workspace with multiple ordered blocks', () => {
    expect(parseLayout('#ws-1/block-1/block-2/block-3')).toEqual({
      workspaceId: 'ws-1',
      slots: [
        {kind: 'leaf', blockId: 'block-1'},
        {kind: 'leaf', blockId: 'block-2'},
        {kind: 'leaf', blockId: 'block-3'},
      ],
      blockIds: ['block-1', 'block-2', 'block-3'],
    })
  })

  it('parses sidebar stack slots', () => {
    expect(parseLayout('#ws-1/block-1/(s:block-2,block-3)/block-4')).toEqual({
      workspaceId: 'ws-1',
      slots: [
        {kind: 'leaf', blockId: 'block-1'},
        {
          kind: 'stack',
          children: [
            {kind: 'leaf', blockId: 'block-2'},
            {kind: 'leaf', blockId: 'block-3'},
          ],
        },
        {kind: 'leaf', blockId: 'block-4'},
      ],
      blockIds: ['block-1', 'block-2', 'block-3', 'block-4'],
    })
  })

  it('ignores hash query parameters used for local bridge pairing', () => {
    expect(parseLayout('#ws-1/block-1/block-2?agent-runtime-secret=secret')).toEqual({
      workspaceId: 'ws-1',
      slots: [
        {kind: 'leaf', blockId: 'block-1'},
        {kind: 'leaf', blockId: 'block-2'},
      ],
      blockIds: ['block-1', 'block-2'],
    })
    expect(parseLayout('#?agent-runtime-secret=secret')).toEqual({slots: [], blockIds: []})
  })
})

describe('buildLayout', () => {
  it('renders workspace-only for an empty block list', () => {
    expect(buildLayout('ws-1', [])).toBe('#ws-1')
  })

  it('renders a single block', () => {
    expect(buildLayout('ws-1', ['block-1'])).toBe('#ws-1/block-1')
  })

  it('renders multiple blocks in order', () => {
    expect(buildLayout('ws-1', ['block-1', 'block-2', 'block-3'])).toBe('#ws-1/block-1/block-2/block-3')
  })

  it('renders sidebar stack slots', () => {
    expect(buildLayoutFromSlots('ws-1', [
      {kind: 'leaf', blockId: 'block-1'},
      {
        kind: 'stack',
        children: [
          {kind: 'leaf', blockId: 'block-2'},
          {kind: 'leaf', blockId: 'block-3'},
        ],
      },
    ])).toBe('#ws-1/block-1/(s:block-2,block-3)')
  })
})

describe('preserveHashQueryParams', () => {
  it('carries bridge pairing params onto a replacement layout hash', () => {
    expect(
      preserveHashQueryParams(
        '#ws-1/block-1',
        '#?agent-runtime-secret=secret&agent-runtime-open-tokens=1',
      ),
    ).toBe('#ws-1/block-1?agent-runtime-secret=secret&agent-runtime-open-tokens=1')
  })

  it('keeps replacement hash params authoritative when keys overlap', () => {
    expect(
      preserveHashQueryParams(
        '#ws-1/block-1?agent-runtime-secret=next&debug=1',
        '#old?agent-runtime-secret=old&agent-runtime-open-tokens=1',
      ),
    ).toBe('#ws-1/block-1?agent-runtime-secret=next&debug=1&agent-runtime-open-tokens=1')
  })
})

describe('layoutWorkspaceChanged', () => {
  it('ignores same-workspace panel layout changes', () => {
    expect(layoutWorkspaceChanged('#ws-1/a', '#ws-1/b/c')).toBe(false)
    expect(layoutWorkspaceChanged('#ws-1/a', '#ws-1')).toBe(false)
  })

  it('detects workspace/bootstrap hash changes', () => {
    expect(layoutWorkspaceChanged('#ws-1/a', '#ws-2/a')).toBe(true)
    expect(layoutWorkspaceChanged('#ws-1/a', '')).toBe(true)
    expect(layoutWorkspaceChanged('', '#ws-1/a')).toBe(true)
  })
})

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

  it('keeps single-block compatibility by returning the first layout block', () => {
    expect(parseAppHash('#ws-1/block-1/block-2')).toEqual({
      workspaceId: 'ws-1',
      blockId: 'block-1',
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
