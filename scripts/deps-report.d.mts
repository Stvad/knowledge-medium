// Hand-written declarations for deps-report.mjs (runtime must stay plain
// node-runnable JS — the skill runs it with no loader).
export interface VersionPick {
  version: string
  published: string
  eligibleAt: string
}
export interface PackageRow {
  name: string
  current: string
  prerelease: boolean
  sameMajor: VersionPick | null
  major: VersionPick | null
  held: VersionPick | null
}
export declare const classifyPackage: (
  pkg: {name: string; current: string},
  times: Record<string, string>,
  policy: {now: number; cooldownMs: number},
) => PackageRow
export declare const sameMajorUpCommand: (
  rows: (Pick<PackageRow, 'name' | 'sameMajor'> & {from?: string; packageManager?: boolean})[],
) => string | null
export declare const readInventory: (result: {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}) => {name: string; from: string; current: string; usedBy: string}[]
export declare const parseWorkflowUses: (text: string) => {action: string; ref: string}[]
export declare const parseEsmShPins: (text: string) => {name: string; version: string}[]
export declare const actionRefMajor: (ref: string) => number | null
