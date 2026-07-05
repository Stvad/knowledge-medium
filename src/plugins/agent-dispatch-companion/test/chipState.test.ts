// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import { chipStateFor, chipTitle } from '../chipState.ts'
import { agentStatusChipContribution } from '../AgentStatusChip.tsx'
import { contentWithAgentMention } from '../askAgent.ts'

describe('chipStateFor', () => {
  it('returns null without a agent:status (including reply blocks and junk values)', () => {
    expect(chipStateFor(undefined)).toBeNull()
    expect(chipStateFor({})).toBeNull()
    expect(chipStateFor({'agent:reply': true})).toBeNull()
    expect(chipStateFor({'agent:status': 'garbage'})).toBeNull()
    expect(chipStateFor({'agent:status': 42})).toBeNull()
  })

  it('maps the daemon lifecycle states with their metadata', () => {
    expect(chipStateFor({
      'agent:status': 'running',
      'agent:updated-at': 1_000,
      'agent:attempts': 2,
    })).toEqual({kind: 'running', executor: 'claude', executorLabel: 'Claude', updatedAtMs: 1_000, attempts: 2, errorMessage: '', activity: '', cancelling: false})

    expect(chipStateFor({'agent:status': 'done'})).toMatchObject({kind: 'done', attempts: 1})
    expect(chipStateFor({
      'agent:status': 'error',
      'agent:error': 'timed out after 600s',
    })).toMatchObject({kind: 'error', errorMessage: 'timed out after 600s'})
    expect(chipStateFor({
      'agent:status': 'running',
      'agent:activity': 'km: search',
    })).toMatchObject({kind: 'running', activity: 'km: search'})
  })

  it('sanitizes malformed metadata instead of propagating it', () => {
    expect(chipStateFor({
      'agent:status': 'running',
      'agent:updated-at': 'yesterday',
      'agent:attempts': -3,
      'agent:activity': 42,
    })).toEqual({kind: 'running', executor: 'claude', executorLabel: 'Claude', updatedAtMs: null, attempts: 1, errorMessage: '', activity: '', cancelling: false})
  })

  it('uses the persisted executor to label non-Claude runs', () => {
    expect(chipStateFor({'agent:status': 'running', 'agent:executor': 'codex'}))
      .toMatchObject({executor: 'codex', executorLabel: 'Codex'})
    expect(chipTitle(chipStateFor({'agent:status': 'done', 'agent:executor': 'codex'})!))
      .toContain('Codex replied')
  })

  it('flags cancelling only for a running chip with a truthy agent:cancel', () => {
    expect(chipStateFor({'agent:status': 'running', 'agent:cancel': Date.now()})).toMatchObject({cancelling: true})
    expect(chipStateFor({'agent:status': 'running'})).toMatchObject({cancelling: false})
    // A leftover agent:cancel on a non-running block must not be surfaced —
    // the daemon only honors it while status is 'running'.
    expect(chipStateFor({'agent:status': 'done', 'agent:cancel': Date.now()})).toMatchObject({cancelling: false})
  })
})

describe('chipTitle', () => {
  it('surfaces the error message and retry attempts', () => {
    expect(chipTitle(chipStateFor({'agent:status': 'error', 'agent:error': 'exit 1: boom'})!))
      .toContain('exit 1: boom')
    expect(chipTitle(chipStateFor({'agent:status': 'running', 'agent:attempts': 3})!))
      .toContain('attempt 3')
  })

  it('appends the activity label for a running chip when present', () => {
    const withActivity = chipTitle(chipStateFor({'agent:status': 'running', 'agent:activity': 'Searching the web'})!)
    expect(withActivity).toContain('Searching the web')
    const withoutActivity = chipTitle(chipStateFor({'agent:status': 'running'})!)
    expect(withoutActivity).not.toContain('—')
  })
})

describe('contentWithAgentMention', () => {
  it('appends the mention once, preserving existing content', () => {
    expect(contentWithAgentMention('')).toBe('[[claude]]')
    expect(contentWithAgentMention('summarize this  ')).toBe('summarize this [[claude]]')
    expect(contentWithAgentMention('already [[claude]] here')).toBe('already [[claude]] here')
    expect(contentWithAgentMention('case [[CLAUDE]] variant')).toBe('case [[CLAUDE]] variant')
  })
})

describe('agentStatusChipContribution gate', () => {
  const ctx = (over: Partial<BlockResolveContext>): BlockResolveContext =>
    ({isTopLevel: false, ...over}) as BlockResolveContext

  const withContext = (over: Record<string, unknown>) =>
    ctx({blockContext: over as BlockResolveContext['blockContext']})

  it('attaches where the block renders as a full row — outline, backlinks, embeds', () => {
    expect(agentStatusChipContribution(ctx({}))).toBeTruthy()
    expect(agentStatusChipContribution(ctx({isTopLevel: true}))).toBeTruthy()
    // A backlink-entry body / embed sets isNestedSurface but still renders
    // the block as a full row, so the chip belongs there — the review
    // surface for what the daemon picked up must not hide status.
    expect(agentStatusChipContribution(withContext({isNestedSurface: true, isBacklink: true}))).toBeTruthy()
    expect(agentStatusChipContribution(withContext({isNestedSurface: true, isEmbedded: true}))).toBeTruthy()
  })

  it('suppresses only inline references and breadcrumb segments (a gutter pill cannot lay out inline)', () => {
    expect(agentStatusChipContribution(withContext({isNestedSurface: true, isReference: true}))).toBeNull()
    expect(agentStatusChipContribution(withContext({isNestedSurface: true, isBreadcrumb: true}))).toBeNull()
  })
})
