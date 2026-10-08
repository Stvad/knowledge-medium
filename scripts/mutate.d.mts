// Hand-written declarations for mutate.mjs (runtime must stay plain
// node-runnable JS — `pnpm mutate` runs it with no loader).
export interface MutateConfig {
  cwd: string
  file: string
  test: string
  mutation: { kind: 'delete'; text: string } | { kind: 'edit'; command: string }
  testName: string | undefined
  baseline: boolean
  timeoutMs: number
}
export type Verdict =
  | { kind: 'pinned'; names: string[]; failures: string[]; passed: number }
  | { kind: 'unpinned'; passed: number }
  | { kind: 'none'; reason: string; loadFailed?: boolean }
export declare const parseMutateArgs: (argv: string[], cwd: string) => MutateConfig
export declare const deleteOnce: (text: string, literal: string) => string
export declare const changedLines: (before: string, after: string) => { removed: string[]; added: string[] }
export declare const verdictOf: (report: unknown, testFile: string) => Verdict
export declare const statePaths: (
  root: string,
  target: string,
) => { dir: string; lock: string; report: string; journal: string; snapshot: string; duringRun: string }
