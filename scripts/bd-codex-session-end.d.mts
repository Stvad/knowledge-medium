// Hand-written declarations for bd-codex-session-end.mjs (runtime must stay
// plain node-runnable JS because it is invoked directly by the SessionEnd hook).
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export declare const resolveMainRepoRoot: (options?: { cwd?: string }) => string | null
export declare const syncLogPath: (root: string) => string

type SessionEndChild = Pick<ChildProcess, 'once' | 'unref'>

export interface SessionEndLaunchOptions {
  cwd?: string
  syncScript?: string
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => SessionEndChild
}

export type SessionEndLaunchResult =
  | { started: true; root: string; logPath: string }
  | { started: false; root: string | null; logPath: string | null; error: string }

export declare const launchSessionEndSync: (
  options?: SessionEndLaunchOptions,
) => SessionEndLaunchResult
