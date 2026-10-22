// Hand-written declarations for bd-prime-hook.mjs (runtime must stay plain
// node-runnable JS — it is invoked as a Claude/Codex hook with no loader).
export type MemoryIndex = { keys: string[] } | { error: string }
export declare const MAX_CONTEXT_CHARS: number
export declare const parseMemoryKeys: (stdout: string | null | undefined) => MemoryIndex
export declare const readMemoryIndex: (result: {
  error?: Error & { code?: string }
  status: number | null
  signal: string | null
  stdout?: string | null
  stderr?: string | null
}) => MemoryIndex
export declare const buildAdditionalContext: (index: MemoryIndex, notice?: string) => string
export declare const sessionStartOutput: (nativeRaw: string | null | undefined, context: string) => string
export declare const transformCodexHookStdout: (raw: string, readContext: () => string) => string
