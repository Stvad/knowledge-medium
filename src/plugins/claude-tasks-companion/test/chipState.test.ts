// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import { chipStateFor, chipTitle } from '../chipState.ts'
import { claudeStatusChipContribution } from '../ClaudeStatusChip.tsx'

describe('chipStateFor', () => {
  it('returns null without a claude:status (including reply blocks and junk values)', () => {
    expect(chipStateFor(undefined)).toBeNull()
    expect(chipStateFor({})).toBeNull()
    expect(chipStateFor({'claude:reply': true})).toBeNull()
    expect(chipStateFor({'claude:status': 'garbage'})).toBeNull()
    expect(chipStateFor({'claude:status': 42})).toBeNull()
  })

  it('maps the daemon lifecycle states with their metadata', () => {
    expect(chipStateFor({
      'claude:status': 'running',
      'claude:updated-at': 1_000,
      'claude:attempts': 2,
    })).toEqual({kind: 'running', updatedAtMs: 1_000, attempts: 2, errorMessage: ''})

    expect(chipStateFor({'claude:status': 'done'})).toMatchObject({kind: 'done', attempts: 1})
    expect(chipStateFor({
      'claude:status': 'error',
      'claude:error': 'timed out after 600s',
    })).toMatchObject({kind: 'error', errorMessage: 'timed out after 600s'})
  })

  it('sanitizes malformed metadata instead of propagating it', () => {
    expect(chipStateFor({
      'claude:status': 'running',
      'claude:updated-at': 'yesterday',
      'claude:attempts': -3,
    })).toEqual({kind: 'running', updatedAtMs: null, attempts: 1, errorMessage: ''})
  })
})

describe('chipTitle', () => {
  it('surfaces the error message and retry attempts', () => {
    expect(chipTitle(chipStateFor({'claude:status': 'error', 'claude:error': 'exit 1: boom'})!))
      .toContain('exit 1: boom')
    expect(chipTitle(chipStateFor({'claude:status': 'running', 'claude:attempts': 3})!))
      .toContain('attempt 3')
  })
})

describe('claudeStatusChipContribution gate', () => {
  const ctx = (over: Partial<BlockResolveContext>): BlockResolveContext =>
    ({isTopLevel: false, ...over}) as BlockResolveContext

  it('attaches to ordinary and focal blocks, but not nested surfaces', () => {
    expect(claudeStatusChipContribution(ctx({}))).toBeTruthy()
    expect(claudeStatusChipContribution(ctx({isTopLevel: true}))).toBeTruthy()
    expect(claudeStatusChipContribution(
      ctx({blockContext: {isNestedSurface: true} as BlockResolveContext['blockContext']}),
    )).toBeNull()
  })
})
