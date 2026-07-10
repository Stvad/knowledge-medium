import type { Executor } from './config.js'
import type { AgentRunOptions } from './runner.js'

export interface AgentResumeOptions {
  version: 1
  executor: Executor
  model?: string
}

export const resumeOptionsForRun = (options: AgentRunOptions): AgentResumeOptions => ({
  version: 1,
  executor: options.executor ?? 'claude',
  ...(options.model ? {model: options.model} : {}),
})
