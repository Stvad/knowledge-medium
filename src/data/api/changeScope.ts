/** ChangeScope drives undo behavior, upload routing, and read-only gating
 *  for every write made through `repo.tx`. Plugins pick the one whose
 *  engine semantics match their need (no plugin-extensible scope registry —
 *  see §5.8 of the data-layer spec). */
export const ChangeScope = {
  /** User document edits. Undoable; uploads to server. */
  BlockDefault: 'block-default',
  /** Selection / focus / chrome state. Not undoable; uploads like any
   *  other write — server-side RLS or FK errors land in the rejection
   *  quarantine rather than blocking the queue. The scope identity is
   *  still load-bearing for undo bucketing and schema validation
   *  (`requireSchemaScope`). */
  UiState: 'local-ui',
  /** User-owned preferences. Not undoable; uploads. */
  UserPrefs: 'user-prefs',
  /** App/automation-authored records (diagnostics, telemetry, automation
   *  output, e.g. startup-metrics) — written by the program, not the user.
   *  Durable + synced like any write, NOT undoable — and unlike a
   *  `system:`-prefixed property NAME (which is hidden), Automation-scoped
   *  properties ARE surfaced in the property panel. For machine-generated data
   *  the user may want to inspect but never hand-edits as a document. Same
   *  engine policy as UserPrefs; the distinct identity is its own undo bucket +
   *  semantic label. */
  Automation: 'automation',
  /** parseReferences bookkeeping. Separate undo bucket; uploads. */
  References: 'block-default:references',
} as const

export type ChangeScope = (typeof ChangeScope)[keyof typeof ChangeScope]

const CHANGE_SCOPE_VALUES = new Set<unknown>(Object.values(ChangeScope))

/** Runtime guard for persisted/config-provided scope strings. */
export const isChangeScope = (value: unknown): value is ChangeScope =>
  CHANGE_SCOPE_VALUES.has(value)

/** `tx_context.source` values written by `repo.tx`. Sync-applied writes leave
 *  `source = NULL`; row_events triggers `COALESCE` it to `'sync'`. The string
 *  `'sync'` is therefore reserved for the trigger output and is not assignable
 *  from any caller. Every `repo.tx` invocation is `'user'` — there is no
 *  longer a routing-time downgrade. */
export type TxSource = 'user'

/** Read-only behavior per scope: either reject the write outright or let
 *  it proceed (the upload will still be attempted; server-side RLS or FK
 *  errors land in the rejection quarantine). */
export type ReadOnlyScopeBehavior = 'reject' | 'allow'

export interface ChangeScopePolicy {
  readonly undoable: boolean
  readonly source: TxSource
  readonly readOnly: ReadOnlyScopeBehavior
}

export const CHANGE_SCOPE_POLICIES = {
  [ChangeScope.BlockDefault]: {
    undoable: true,
    source: 'user',
    readOnly: 'reject',
  },
  [ChangeScope.UiState]: {
    undoable: false,
    source: 'user',
    readOnly: 'allow',
  },
  [ChangeScope.UserPrefs]: {
    undoable: false,
    source: 'user',
    readOnly: 'allow',
  },
  [ChangeScope.Automation]: {
    undoable: false,
    source: 'user',
    readOnly: 'allow',
  },
  [ChangeScope.References]: {
    undoable: true,
    source: 'user',
    readOnly: 'reject',
  },
} satisfies Readonly<Record<ChangeScope, ChangeScopePolicy>>

export const policyForScope = (scope: ChangeScope): ChangeScopePolicy =>
  CHANGE_SCOPE_POLICIES[scope]

export const scopeAllowedInReadOnly = (scope: ChangeScope): boolean =>
  policyForScope(scope).readOnly !== 'reject'

export const scopeIsUndoable = (scope: ChangeScope): boolean =>
  policyForScope(scope).undoable

export const sourceForScope = (scope: ChangeScope): TxSource =>
  policyForScope(scope).source

export const scopeUploadsToServer = (scope: ChangeScope): boolean =>
  sourceForScope(scope) === 'user'
