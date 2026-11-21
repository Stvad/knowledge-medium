// Hand-written declarations for bd-publish-verify.mjs (runtime must stay
// plain node-runnable JS — it is invoked as a Claude Code hook, no loader).
export type PublishTarget =
  | { kind: 'pr'; number: number }
  | { kind: 'issue'; number: number }
  | { kind: 'comment'; id: number }
  | { kind: 'review-comment'; id: number }
  | { kind: 'review'; pr: number; id: number }
  | { kind: 'release'; tag: string }

export declare const publishedTargets: (cmd: string, output: string) => PublishTarget[]
export declare const mergedPrNumbers: (output: string) => number[]
export declare const apiPathFor: (t: PublishTarget) => string
export declare const clipContext: (s: string, max?: number) => string
