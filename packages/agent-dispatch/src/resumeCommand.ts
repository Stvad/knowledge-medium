import path from 'node:path'
import type { Executor } from './config.js'
import type { AgentRunOptions } from './runner.js'

export interface AgentResumeOptions {
  version: 1
  executor: Executor
  cwd: string
  model?: string
}

export const resumeOptionsForRun = (options: AgentRunOptions): AgentResumeOptions => ({
  version: 1,
  executor: options.executor ?? 'claude',
  cwd: path.resolve(options.cwd ?? ''),
  ...(options.model ? {model: options.model} : {}),
})
