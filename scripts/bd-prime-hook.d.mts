// Hand-written declarations for bd-prime-hook.mjs (runtime must stay plain
// node-runnable JS — it is invoked as a Claude/Codex hook with no loader).
export declare const MAX_CONTEXT_CHARS: number
export declare const parsePrimeContext: (ctx: string | null | undefined) => {
  memories: { key: string; preview: string }[]
  parseOk: boolean
}
export declare const buildAdditionalContext: (ctx: string | null | undefined) => string
export declare const transformHookStdout: (raw: string | null | undefined) => string | null
export declare const transformCodexHookStdout: (
  raw: string,
  primeRaw?: string | null,
) => string
