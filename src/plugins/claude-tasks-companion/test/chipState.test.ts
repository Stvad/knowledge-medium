// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import { chipStateFor, chipTitle } from '../chipState.ts'
import { claudeStatusChipContribution } from '../ClaudeStatusChip.tsx'
import { contentWithClaudeMention } from '../askClaude.ts'

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
    })).toEqual({kind: 'running', updatedAtMs: 1_000, attempts: 2, errorMessage: '', activity: '', cancelling: false})

    expect(chipStateFor({'claude:status': 'done'})).toMatchObject({kind: 'done', attempts: 1})
    expect(chipStateFor({
      'claude:status': 'error',
      'claude:error': 'timed out after 600s',
    })).toMatchObject({kind: 'error', errorMessage: 'timed out after 600s'})
    expect(chipStateFor({
      'claude:status': 'running',
      'claude:activity': 'km: search',
    })).toMatchObject({kind: 'running', activity: 'km: search'})
  })

  it('sanitizes malformed metadata instead of propagating it', () => {
    expect(chipStateFor({
      'claude:status': 'running',
      'claude:updated-at': 'yesterday',
      'claude:attempts': -3,
      'claude:activity': 42,
    })).toEqual({kind: 'running', updatedAtMs: null, attempts: 1, errorMessage: '', activity: '', cancelling: false})
  })

  it('flags cancelling only for a running chip with a truthy claude:cancel', () => {
    expect(chipStateFor({'claude:status': 'running', 'claude:cancel': Date.now()})).toMatchObject({cancelling: true})
    expect(chipStateFor({'claude:status': 'running'})).toMatchObject({cancelling: false})
    // A leftover claude:cancel on a non-running block must not be surfaced —
    // the daemon only honors it while status is 'running'.
    expect(chipStateFor({'claude:status': 'done', 'claude:cancel': Date.now()})).toMatchObject({cancelling: false})
  })
})

describe('chipTitle', () => {
  it('surfaces the error message and retry attempts', () => {
    expect(chipTitle(chipStateFor({'claude:status': 'error', 'claude:error': 'exit 1: boom'})!))
      .toContain('exit 1: boom')
    expect(chipTitle(chipStateFor({'claude:status': 'running', 'claude:attempts': 3})!))
      .toContain('attempt 3')
  })

  it('appends the activity label for a running chip when present', () => {
    const withActivity = chipTitle(chipStateFor({'claude:status': 'running', 'claude:activity': 'Searching the web'})!)
    expect(withActivity).toContain('Searching the web')
    const withoutActivity = chipTitle(chipStateFor({'claude:status': 'running'})!)
    expect(withoutActivity).not.toContain('—')
  })
})

describe('contentWithClaudeMention', () => {
  it('appends the mention once, preserving existing content', () => {
    expect(contentWithClaudeMention('')).toBe('[[claude]]')
    expect(contentWithClaudeMention('summarize this  ')).toBe('summarize this [[claude]]')
    expect(contentWithClaudeMention('already [[claude]] here')).toBe('already [[claude]] here')
    expect(contentWithClaudeMention('case [[CLAUDE]] variant')).toBe('case [[CLAUDE]] variant')
  })
})

describe('claudeStatusChipContribution gate', () => {
  const ctx = (over: Partial<BlockResolveContext>): BlockResolveContext =>
    ({isTopLevel: false, ...over}) as BlockResolveContext

  const withContext = (over: Record<string, unknown>) =>
    ctx({blockContext: over as BlockResolveContext['blockContext']})

  it('attaches where the block renders as a full row — outline, backlinks, embeds', () => {
    expect(claudeStatusChipContribution(ctx({}))).toBeTruthy()
    expect(claudeStatusChipContribution(ctx({isTopLevel: true}))).toBeTruthy()
    // A backlink-entry body / embed sets isNestedSurface but still renders
    // the block as a full row, so the chip belongs there — the review
    // surface for what the daemon picked up must not hide status.
    expect(claudeStatusChipContribution(withContext({isNestedSurface: true, isBacklink: true}))).toBeTruthy()
    expect(claudeStatusChipContribution(withContext({isNestedSurface: true, isEmbedded: true}))).toBeTruthy()
  })

  it('suppresses only inline references and breadcrumb segments (a gutter pill cannot lay out inline)', () => {
    expect(claudeStatusChipContribution(withContext({isNestedSurface: true, isReference: true}))).toBeNull()
    expect(claudeStatusChipContribution(withContext({isNestedSurface: true, isBreadcrumb: true}))).toBeNull()
  })
})
