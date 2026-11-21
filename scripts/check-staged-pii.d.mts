// Hand-written declarations for check-staged-pii.mjs (runtime must stay
// plain node-runnable JS — it is invoked as a Claude Code hook with no loader).
export declare const isSyntheticUuid: (uuid: string) => boolean
export declare const parseAllowlist: (text: string) => Set<string>
export declare const ALLOWLIST_PATH: string
