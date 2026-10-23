// Hand-written declarations for compaction-handoff.mjs (runtime must stay plain
// node-runnable JS — Claude Code hooks import it with no loader).
export declare const injectHandoff: (payload: { scratchpad_dir?: string; [key: string]: unknown }, now?: number) => string
