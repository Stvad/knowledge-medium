// Hand-written declarations for bd-github-sync.mjs (runtime must stay plain
// node-runnable JS — it is invoked as a Claude Code hook with no loader).
export declare const REPO: string
export declare const extractBeadIds: (text: string) => string[]
export declare const matchesPrCommand: (cmd: string) => boolean
export declare const allowsBeadIds: (cmd: string) => boolean
export declare const bodyFilePaths: (cmd: string) => string[]
export declare const resolveBodyPath: (p: string, cwd: string, home: string) => string
export declare const deriveLabelPriority: (labels: string[]) => number | null
export declare const issueNumberFromRef: (ref: string | null | undefined) => number | null
export declare const initializedDbRoot: () => string | null

export interface BeadRow {
  id: string
  status: string
  priority: number
  external_ref?: string | null
}
export interface IssueInfo {
  state: 'OPEN' | 'CLOSED'
  labels: string[]
}
export declare const planCloseReconciliation: (
  beads: BeadRow[],
  issueByNumber: Map<number, IssueInfo>,
) => { id: string; number: number }[]
export declare const planClosePushes: (
  beads: BeadRow[],
  issueByNumber: Map<number, IssueInfo>,
  maxKnownIssueNumber: number,
) => { id: string; number: number }[]
export declare const planPriorityFixes: (
  preById: Map<string, BeadRow>,
  postBeads: BeadRow[],
  issueByNumber: Map<number, IssueInfo>,
) => { id: string; to: number }[]
export declare const buildDenyMessage: (
  mapped: { id: string; number: number }[],
  unmapped: string[],
) => string
