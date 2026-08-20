// Hand-written declarations for check-stash-worktree.mjs (runtime must stay
// plain node-runnable JS — it is invoked as a Claude Code hook with no loader).
export interface StashInvocation {
  sub: string | null
  args: string[]
  cArgs: string[]
  cdPath: string | null
  optOut: boolean
}
export interface StashEntry {
  ref: string
  subject: string
}
export interface RepoStashState {
  worktrees: number
  branch: string | null
  stashes: StashEntry[] | null
}
export interface GitInvocation {
  word: string
  rest: string[]
  cArgs: string[]
  cdPath: string | null
  assigns: string[]
}
export interface AmendInvocation {
  all: boolean
  paths: string[]
  cArgs: string[]
  cdPath: string | null
  optOut: boolean
}
export declare const stashInvocations: (cmd: string) => StashInvocation[]
export declare const amendInvocations: (cmd: string) => AmendInvocation[]
export declare const explicitEntry: (args: string[]) => string | null
export declare const hasMessage: (sub: string | null, args: string[]) => boolean
export declare const renumbersStack: (inv: Pick<StashInvocation, 'sub'>) => boolean
export declare const gitInvocations: (cmd: string) => GitInvocation[]
export declare const baseBranch: (subject: string) => string | null
export declare const decide: (
  inv: Pick<StashInvocation, 'sub' | 'args'>,
  state: RepoStashState | null,
) => string | null
