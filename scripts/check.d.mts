// Hand-written declarations for check.mjs (runtime must stay plain
// node-runnable JS — it runs as a pnpm script with no loader).
export interface SlotHolder {
  pid: number
  worktree: string
  branch: string
  startedAt: number
}
export interface Slot {
  release: () => void
}
export declare const acquireSlot: (options: {
  dir: string
  slots: number
  holder: SlotHolder
  maxWaitMs?: number
  pollMs?: number
  signal?: AbortSignal
  log?: (line: string) => void
}) => Promise<Slot | null>
export declare const failingTestFiles: (output: string) => string[]
export declare const loadVerdict: (failed: string[], rerun: { code: number | null; output: string }) => string
