import type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexSandbox,
  Executor,
} from './config.js'
import type { AgentRunOptions } from './runner.js'

export interface AgentResumeOptions {
  version: 1
  executor: Executor
  cwd: string
  model?: string
  codex?: {
    sandbox: CodexSandbox
    addDirs: string[]
    networkAccess: boolean
    approvalPolicy: CodexApprovalPolicy
    approvalsReviewer?: CodexApprovalsReviewer
  }
}

export const resumeOptionsForRun = (options: AgentRunOptions): AgentResumeOptions => ({
  version: 1,
  executor: options.executor ?? 'claude',
  cwd: options.cwd ?? '',
  ...(options.model ? {model: options.model} : {}),
  ...(options.executor === 'codex'
    ? {
        codex: {
          sandbox: options.codexSandbox ?? 'read-only',
          addDirs: options.codexAddDirs ?? [],
          networkAccess: Boolean(options.codexNetworkAccess),
          approvalPolicy: options.codexApprovalPolicy ?? 'never',
          ...(options.codexApprovalsReviewer ? {approvalsReviewer: options.codexApprovalsReviewer} : {}),
        },
      }
    : {}),
})
