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
  /** parseReferences bookkeeping. Separate undo bucket; uploads. */
  References: 'block-default:references',
} as const

export type ChangeScope = (typeof ChangeScope)[keyof typeof ChangeScope]

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
