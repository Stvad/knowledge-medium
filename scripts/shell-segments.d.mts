// Hand-written declarations for shell-segments.mjs (runtime must stay
// plain node-runnable JS — it is imported by Claude Code hooks with no loader).
export interface ShellSegment {
  tokens: string[]
  depth: number
}
export declare const shellSegmentsWithDepth: (cmd: string) => ShellSegment[]
export declare const shellSegments: (cmd: string) => string[][]
