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
export interface InventoryRow {
  name: string
  from: string
  current: string
  users: string[]
}
export declare const classifyPackage: (
  pkg: {name: string; current: string},
  packument: {time?: Record<string, string>; versions?: Record<string, {deprecated?: string}>},
  policy: {now: number; cooldownMs: number},
) => PackageRow
export declare const refreshCommands: (
  rows: {name: string; from: string; users: string[]; packageManager?: boolean; sameMajor: {version: string} | null}[],
  label?: string,
) => string[]
export declare const readInventory: (result: {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}) => InventoryRow[]
export declare const parseWorkflowUses: (text: string) => {action: string; ref: string}[]
export declare const actionRefMajor: (ref: string) => number | null
