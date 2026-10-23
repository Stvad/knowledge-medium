// Hand-written declarations for compaction-handoff.mjs (runtime must stay plain
// node-runnable JS — Claude Code hooks import it with no loader).
export declare const CONTEXT_BUDGET: number
export declare const injectHandoff: (
  payload: { session_id?: string; transcript_path?: string; [key: string]: unknown },
  env?: Record<string, string | undefined>,
  now?: number,
) => string
