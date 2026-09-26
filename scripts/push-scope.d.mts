// Hand-written declarations for push-scope.mjs (runtime must stay plain
// node-runnable JS — it is invoked as a Claude Code hook with no loader).
import type { GitInvocation } from './check-stash-worktree.mjs'
export declare const pushInvocations: (cmd: string) => GitInvocation[]
export declare const pushSources: (rest: string[]) => { sources: string[]; declined: string | null }
