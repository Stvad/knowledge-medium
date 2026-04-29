/** ChangeScope drives undo behavior, upload routing, and read-only gating
 *  for every write made through `repo.tx`. v1 ships three scopes; plugins
 *  pick the one whose engine semantics match their need (no plugin-extensible
 *  scope registry — see §5.8 of the data-layer spec). */
export const ChangeScope = {
  /** User document edits. Undoable; uploads to server. */
  BlockDefault: 'block-default',
  /** Selection / focus / chrome state. Not undoable; never uploads
   *  (`tx_context.source = 'local-ephemeral'`). */
  UiState: 'local-ui',
  /** parseReferences bookkeeping. Separate undo bucket; uploads. */
  References: 'block-default:references',
} as const

export type ChangeScope = (typeof ChangeScope)[keyof typeof ChangeScope]

/** `tx_context.source` values written by `repo.tx`. Sync-applied writes leave
 *  `source = NULL`; row_events triggers `COALESCE` it to `'sync'`. The string
 *  `'sync'` is therefore reserved for the trigger output and is not assignable
 *  from any caller. */
export type TxSource = 'user' | 'local-ephemeral'

export const sourceForScope = (scope: ChangeScope): TxSource =>
  scope === ChangeScope.UiState ? 'local-ephemeral' : 'user'
