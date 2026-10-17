// Hand-written declarations for hook-context.mjs (runtime must stay plain
// node-runnable JS — Claude Code hooks import it with no loader).
export declare const NOTE_BUDGET: number
export declare const readHookPayload: (
  prefilter: RegExp,
) => { payload: Record<string, unknown>; cmd: string; cwd: string } | null
export declare const git: (cwd: string, cArgs: string[], args: string[], input?: string) => string
export declare const firstLine: (e: unknown) => string
export declare const fitLines: (
  head: string[],
  lines: string[],
  more: (n: number) => string,
  budget?: number,
) => string[]
export declare const emitPreToolUseContext: (notes: string[]) => void
