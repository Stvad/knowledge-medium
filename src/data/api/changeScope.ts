/** ChangeScope drives undo behavior, upload routing, and read-only gating
 *  for every write made through `repo.tx`. Plugins pick the one whose
 *  engine semantics match their need (no plugin-extensible scope registry —
 *  see §5.8 of the data-layer spec). */
export const ChangeScope = {
  /** User document edits. Undoable; uploads to server. */
  BlockDefault: 'block-default',
  /** Selection / focus / chrome state. Not undoable; never uploads
   *  (`tx_context.source = 'local-ephemeral'`). */
  UiState: 'local-ui',
  /** User-owned preferences. Not undoable; uploads when writable, but
   *  degrades to local-ephemeral in read-only workspaces. */
  UserPrefs: 'user-prefs',
  /** parseReferences bookkeeping. Separate undo bucket; uploads. */
  References: 'block-default:references',
} as const

export type ChangeScope = (typeof ChangeScope)[keyof typeof ChangeScope]

/** `tx_context.source` values written by `repo.tx`. Sync-applied writes leave
 *  `source = NULL`; row_events triggers `COALESCE` it to `'sync'`. The string
 *  `'sync'` is therefore reserved for the trigger output and is not assignable
 *  from any caller. */
export type TxSource = 'user' | 'local-ephemeral'

export type ReadOnlyScopeBehavior = 'reject' | 'preserve-source' | 'local-ephemeral'

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
    source: 'local-ephemeral',
    readOnly: 'preserve-source',
  },
  [ChangeScope.UserPrefs]: {
    undoable: false,
    source: 'user',
    readOnly: 'local-ephemeral',
  },
  [ChangeScope.References]: {
    undoable: true,
    source: 'user',
    readOnly: 'reject',
  },
} satisfies Readonly<Record<ChangeScope, ChangeScopePolicy>>

export interface ScopeRoutingOptions {
  /** Read-only repos may still record user preferences locally, but
   *  those writes must not enter the upload queue. */
  isReadOnly?: boolean
}

export const policyForScope = (scope: ChangeScope): ChangeScopePolicy =>
  CHANGE_SCOPE_POLICIES[scope]

export const scopeAllowedInReadOnly = (scope: ChangeScope): boolean =>
  policyForScope(scope).readOnly !== 'reject'

export const scopeIsUndoable = (scope: ChangeScope): boolean =>
  policyForScope(scope).undoable

export const sourceForScope = (
  scope: ChangeScope,
  opts: ScopeRoutingOptions = {},
): TxSource => {
  const policy = policyForScope(scope)
  if (opts.isReadOnly && policy.readOnly === 'local-ephemeral') {
    return 'local-ephemeral'
  }
  return policy.source
}

export const scopeUploadsToServer = (
  scope: ChangeScope,
  opts: ScopeRoutingOptions = {},
): boolean => sourceForScope(scope, opts) === 'user'
