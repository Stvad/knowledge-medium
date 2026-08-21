// Hand-written declarations for bd-github-sync.mjs (runtime must stay plain
// node-runnable JS — it is invoked as a Claude Code hook with no loader).
export declare const REPO: string
export declare const BEAD_ID: RegExp
export declare const extractBeadIds: (text: string) => string[]
export declare const matchesPrCommand: (cmd: string) => boolean
export declare const matchesApiPublish: (cmd: string) => boolean
export declare const hasExplicitGetMethod: (cmd: string) => boolean
export declare const isCompoundCommand: (cmd: string) => boolean
export declare const repairableKinds: (cmd: string) => Set<string>
export declare const tryRun: (file: string, args: string[], opts?: object) => string | null
export declare const preconditions: (root?: string | null) => { ok: boolean; reason?: string; root?: string; env?: Record<string, string | undefined> }
export declare const bdShowRows: (ids: string[], opts?: object) => object[] | null
export declare const beadIssueLookup: (ids: string[]) => Map<string, number | null>
export declare const beadIssueLookupWithMint: (ids: string[], opts?: { dry?: boolean }) => Map<string, number | null>
export declare const fetchIssueInfo: (
  number: number,
) => { title: string; state: string; isPr: boolean } | 'not-found' | null
export declare const isMainModule: (metaUrl: string) => boolean
export declare const issueRefsTable: (text: string, refs: number[], mode?: 'pre' | 'post') => string
export declare const allowsBeadIds: (cmd: string) => boolean
export declare const bodyFilePaths: (cmd: string) => string[]
export declare const resolveBodyPath: (p: string, cwd: string, home: string) => string
export declare const deriveLabelPriority: (labels: string[]) => number | null
export declare const issueNumberFromRef: (ref: string | null | undefined) => number | null
export declare const initializedDbRoot: () => string | null
export declare const extractIssueRefs: (text: string) => number[]
export declare const matchesCommitCommand: (cmd: string) => boolean
export declare const hasDynamicBody: (cmd: string) => boolean
export declare const hasStdinBody: (cmd: string) => boolean
export declare const closeKeywordRefs: (text: string) => number[]
export declare const allowsIssueRefs: (cmd: string) => boolean
export declare const buildIssueRefsMessage: (
  refs: { number: number; info: { title: string; state: string; isPr: boolean } | 'not-found' | null }[],
  closeNums: Set<number>,
  mode?: 'pre' | 'post',
) => string

export interface BeadRow {
  id: string
  status: string
  priority: number
  external_ref?: string | null
  updated_at?: string
  title?: string
  description?: string
  assignee?: string
  close_reason?: string
  issue_type?: string
  labels?: string[]
}
export interface IssueInfo {
  state: 'OPEN' | 'CLOSED'
  labels: string[]
  updatedAt?: string
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
export declare const planMintedRefs: (
  preBeads: BeadRow[],
  postBeads: BeadRow[],
) => { id: string; number: number }[]
export declare const planMintedNonOpen: (
  preBeads: BeadRow[],
  freshBeads: BeadRow[],
) => { id: string; number: number }[]
export declare const planReopenedClosed: (
  beads: BeadRow[],
  issueByNumber: Map<number, IssueInfo>,
) => { id: string; number: number }[]
export declare const planLocalWins: (
  beads: BeadRow[],
  issueByNumber: Map<number, IssueInfo>,
) => { id: string; number: number }[]
export declare const detectReverts: (snapshotRows: BeadRow[], postById: Map<string, BeadRow>) => BeadRow[]
export declare const planRestoreArgs: (row: BeadRow, post?: BeadRow) => string[][]
