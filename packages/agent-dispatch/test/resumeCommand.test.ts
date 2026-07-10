import {describe, expect, it} from 'vitest'
import {resumeOptionsForRun} from '../src/resumeCommand'
import type {AgentRunOptions} from '../src/runner'

const baseOptions: AgentRunOptions = {
  claudeBin: 'claude',
  prompt: 'hello',
  cwd: '/Users/vlad/project',
  allowedTools: [],
  timeoutMs: 10_000,
  executor: 'claude',
}

describe('resumeOptionsForRun', () => {
  it('captures non-authority context needed to rebuild an interactive resume command', () => {
    expect(resumeOptionsForRun({
      ...baseOptions,
      executor: 'codex',
      model: 'gpt-5-codex',
      codexSandbox: 'workspace-write',
      codexAddDirs: ['/private/tmp', '/Users/vlad/.codex/worktrees'],
      codexNetworkAccess: true,
      codexApprovalPolicy: 'on-request',
      codexApprovalsReviewer: 'auto_review',
    })).toEqual({
      version: 1,
      executor: 'codex',
      model: 'gpt-5-codex',
    })
  })
})
