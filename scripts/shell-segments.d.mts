// Hand-written declarations for shell-segments.mjs (runtime must stay
// plain node-runnable JS — it is imported by Claude Code hooks with no loader).
export interface ShellSegment {
  tokens: string[]
  depth: number
  heredoc?: boolean
  /** heredoc data nothing runs, only split into words (shellCommandsWithDepth) */
  text?: boolean
  /** the first segment of a second reading of the same heredoc data, which starts from the scope the heredoc began in */
  reread?: boolean
  /** the shallowest depth whose scope opened since the previous segment, so a sibling `(…)` or `$(…)` is a new scope */
  fresh?: number
}
export declare const shellSegmentsWithDepth: (cmd: string) => ShellSegment[]
export declare const shellSegments: (cmd: string) => string[][]
export declare const SUBSTITUTED: string
export declare const shellCommandsWithDepth: (cmd: string) => ShellSegment[]
export declare const withoutLiteralHeredocs: (cmd: string) => string
export declare const inputRedirectTargets: (cmd: string) => string[]
