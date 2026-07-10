// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { AGENT_PROPS } from '../chipState.ts'
import {
  COPY_AGENT_RESUME_COMMAND_ACTION_ID,
  agentResumeCommandForProperties,
  copyAgentResumeCommand,
  copyAgentResumeCommandActions,
} from '../resumeCommand.ts'

const toast = vi.hoisted(() => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
}))

vi.mock('@/utils/toast.js', () => toast)

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  vi.unstubAllGlobals()
  toast.showError.mockReset()
  toast.showSuccess.mockReset()
})

const createBlock = async (id: string, properties: Record<string, unknown> = {}) => {
  await repo.tx(
    tx => tx.create({id, workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'do the thing', properties}),
    {scope: ChangeScope.BlockDefault},
  )
  return new Block(repo, id)
}

describe('agentResumeCommandForProperties', () => {
  it('builds the interactive CLI command for Claude and Codex sessions', () => {
    expect(agentResumeCommandForProperties({[AGENT_PROPS.session]: 'sess_123-abc'}))
      .toBe('claude --resume sess_123-abc')
    expect(agentResumeCommandForProperties({[AGENT_PROPS.session]: 'codex:thread_123-abc'}))
      .toBe('codex resume --include-non-interactive \\\n  thread_123-abc')
  })

  it('adds persisted non-authority Codex runner context when available', () => {
    expect(agentResumeCommandForProperties({
      [AGENT_PROPS.session]: 'codex:thread_123-abc',
      [AGENT_PROPS.resumeOptions]: {
        version: 1,
        executor: 'codex',
        cwd: '/Users/vlad/project with spaces',
        model: 'gpt-5-codex',
      },
    })).toBe([
      'codex resume --include-non-interactive',
      '  -m gpt-5-codex',
      '  thread_123-abc',
    ].join(' \\\n'))
  })

  it('ignores graph-stored Codex authority flags when building the copied command', () => {
    expect(agentResumeCommandForProperties({
      [AGENT_PROPS.session]: 'codex:thread_123-abc',
      [AGENT_PROPS.resumeOptions]: {
        version: 1,
        executor: 'codex',
        cwd: '/',
        codex: {
          sandbox: 'danger-full-access',
          addDirs: ['/'],
          networkAccess: true,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
        },
      },
    })).toBe([
      'codex resume --include-non-interactive',
      '  thread_123-abc',
    ].join(' \\\n'))
  })

  it('rejects malformed session ids instead of copying option-shaped argv', () => {
    expect(agentResumeCommandForProperties({[AGENT_PROPS.session]: '-danger'})).toBeNull()
    expect(agentResumeCommandForProperties({[AGENT_PROPS.session]: 'codex:-c=tools.web_search'})).toBeNull()
    expect(agentResumeCommandForProperties({[AGENT_PROPS.session]: 'has spaces'})).toBeNull()
    expect(agentResumeCommandForProperties({[AGENT_PROPS.session]: ''})).toBeNull()
  })
})

describe('copyAgentResumeCommand', () => {
  it('copies the resume command to the system clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {clipboard: {writeText}})
    const block = await createBlock('codex-task', {[AGENT_PROPS.session]: 'codex:thread-1'})

    await copyAgentResumeCommand(block)

    expect(writeText).toHaveBeenCalledWith('codex resume --include-non-interactive \\\n  thread-1')
    expect(toast.showSuccess).toHaveBeenCalledWith('Agent resume command copied.')
    expect(toast.showError).not.toHaveBeenCalled()
  })

  it('reports a missing usable session without writing to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {clipboard: {writeText}})
    const block = await createBlock('no-session')

    await copyAgentResumeCommand(block)

    expect(writeText).not.toHaveBeenCalled()
    expect(toast.showError).toHaveBeenCalledWith('No resumable Agent session is available for this block.')
  })
})

describe('copyAgentResumeCommandActions', () => {
  it('shows the normal-mode command palette action only when the block has a resumable session', async () => {
    const action = copyAgentResumeCommandActions.find(candidate =>
      candidate.id === COPY_AGENT_RESUME_COMMAND_ACTION_ID &&
      candidate.context === ActionContextTypes.NORMAL_MODE
    ) as ActionConfig<typeof ActionContextTypes.NORMAL_MODE>
    const withSession = await createBlock('with-session', {[AGENT_PROPS.session]: 'sess-1'})
    const withoutSession = await createBlock('without-session')

    expect(action.isVisible!({block: withSession, uiStateBlock: withSession})).toBe(true)
    expect(action.isVisible!({block: withoutSession, uiStateBlock: withoutSession})).toBe(false)
  })
})
