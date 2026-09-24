// Hand-written declarations for mutate.mjs (runtime must stay plain
// node-runnable JS — `pnpm mutate` runs it with no loader).
export interface MutateConfig {
  cwd: string
  file: string
  test: string
  mutation: { kind: 'delete'; text: string } | { kind: 'edit'; command: string }
  testName: string | undefined
  baseline: boolean
}
export type Verdict =
  | { kind: 'pinned'; names: string[]; passed: number }
  | { kind: 'unpinned'; passed: number }
  | { kind: 'none'; reason: string }
export declare const parseMutateArgs: (argv: string[], cwd: string) => MutateConfig
export declare const deleteOnce: (text: string, literal: string) => string
export declare const changedLines: (before: string, after: string) => { removed: string[]; added: string[] }
export declare const verdictOf: (report: unknown, testFile: string) => Verdict
export declare const journalPaths: (target: string) => {
  dir: string
  journal: string
  snapshot: string
  report: (label: string) => string
}
