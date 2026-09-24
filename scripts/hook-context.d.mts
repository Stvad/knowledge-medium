// Hand-written declarations for hook-context.mjs (runtime must stay plain
// node-runnable JS — Claude Code hooks import it with no loader).
export declare const NOTE_BUDGET: number
export declare const CONTEXT_MAX: number
export declare const fitLines: (
  head: string[],
  lines: string[],
  more: (n: number) => string,
  budget?: number,
) => string[]
export declare const emitPreToolUseContext: (notes: string[]) => void
