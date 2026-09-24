// Hand-written declarations for backup-before-restore.mjs (runtime must stay
// plain node-runnable JS — it is invoked as a Claude Code hook with no loader).
export interface RestoreInvocation {
  verb: 'checkout' | 'restore'
  pathspecs: string[]
  /** the commit the files come from, when the command names one */
  source: string | null
  widened: string | null
  cArgs: string[]
  cdPath: string | null
}
export declare const restoreInvocations: (cmd: string) => RestoreInvocation[]
