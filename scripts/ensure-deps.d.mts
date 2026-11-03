// Hand-written declarations for ensure-deps.mjs (runtime must stay plain
// node-runnable JS because the SessionStart hook invokes it directly).

export declare const FROZEN_INSTALL_ARGS: readonly string[]
export declare const BUILD_ARGS: readonly string[]

export interface DistPackage {
  dir: string
  buildInfo: string
  generated?: readonly string[]
}
export declare const DIST_PACKAGES: readonly DistPackage[]

export type DepsState = 'fresh' | 'missing' | 'mismatch' | 'no-lockfile'
export declare const readDepsState: (root: string) => DepsState

export interface StaleDist {
  dir: string
  reason: 'missing' | 'orphaned' | 'outdated'
}
export declare const staleDist: (root: string) => StaleDist[]

export declare const sessionRoot: (hookInput: string) => string

export declare const ensureDeps:(options: { root: string; env?: NodeJS.ProcessEnv }) => string
