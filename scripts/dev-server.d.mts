// Hand-written declarations for dev-server.mjs (runtime must stay plain
// node-runnable JS: `pnpm dev` and .claude/launch.json run it with no loader).

/** stdout of a command, or null when it is missing or fails. */
export type Exec = (command: string, args: string[]) => string | null

export type Mode = 'dev' | 'preview'
export declare const MODES: Record<Mode, { viteArgs: readonly string[]; defaultPort: number }>
export declare const SCAN_SPAN: number

export interface RequestedPort {
  port: number
  source: '--port' | 'PORT'
}
export declare const parsePort: (value: unknown, source: string) => number
export declare const requestedPort: (args: readonly string[], env: Record<string, string | undefined>) => RequestedPort | null
export declare const viteArgsWithout: (args: readonly string[]) => string[]

export declare const parseLsofFields: (output: string | null) => { pid: number; names: string[] }[]
export declare const listListeners: (exec?: Exec) => Map<number, Set<number>>
export declare const canBind: (port: number, host: string) => Promise<boolean>
export declare const loopbackFree: (port: number) => Promise<boolean>
export declare const portIsBusy: (port: number, listeners: Map<number, Set<number>>) => Promise<boolean>
export declare const pickPort: (options: {
  requested: { port: number } | null
  defaultPort: number
  isBusy: (port: number) => Promise<boolean>
}) => Promise<{ port: number | null; busy: number[] }>

export interface Checkout {
  toplevel: string
  commonDir: string
  branch: string
}
export declare const checkoutOf: (dir: string, exec?: Exec) => Checkout | null
export declare const parseProcesses: (output: string | null) => Map<number, { startedAt: Date; command: string }>
export declare const serverKind: (command: string) => string
export declare const moduleClosure: (entry: string) => string[]
export declare const bridgeBuildNote: (bridge: { script: string; startedAt: Date }, ownScript: string) => string | null
export declare const bridgeScript: (command: string, cwd: string | null) => string | undefined

export interface Server {
  pid: number
  ports: number[]
  startedAt: Date | null
  command: string
  kind: string
  cwd: string | null
  checkout: Checkout | null
  note: string | null
}
export declare const inspectServers: (pidsByPort: Map<number, Set<number>>, options?: { exec?: Exec; root?: string }) => Server[]
export declare const formatAge: (ms: number) => string
export declare const formatServer: (server: Server, here: Checkout | null, now?: number) => string

export declare const startDevServer: (options: {
  mode: Mode
  args: readonly string[]
  env?: Record<string, string | undefined>
  exec?: Exec
  isBusy?: (port: number) => Promise<boolean>
  log?: (line: string) => void
  spawnVite: (viteArgs: string[]) => Promise<number>
}) => Promise<number>
export declare const whoHolds: (ports: readonly number[], options?: { exec?: Exec }) => Promise<string[]>
