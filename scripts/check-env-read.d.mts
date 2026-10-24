// Hand-written declarations for check-env-read.mjs (runtime must stay plain
// node-runnable JS — it is invoked as a Claude Code hook with no loader).
export interface SecretRead {
  file: string
  walked: boolean
}
export declare const secretRead: (script: string, cwd: string) => SecretRead | null
