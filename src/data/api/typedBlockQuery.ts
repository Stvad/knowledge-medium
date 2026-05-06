export interface TypedBlockQueryReferenceFilter {
  readonly id: string
  readonly sourceField?: string
}

export interface TypedBlockQuery {
  /** Defaults to Repo.activeWorkspaceId for the Repo wrapper methods. */
  readonly workspaceId?: string
  /** Contains any of these type ids. Empty/omitted means no type filter. */
  readonly types?: readonly string[]
  /** Scalar property equality filters. Values are decoded-domain values. */
  readonly where?: Readonly<Record<string, unknown>>
  /** Return blocks that reference this target id, optionally via a field. */
  readonly referencedBy?: TypedBlockQueryReferenceFilter
}

export interface ResolvedTypedBlockQuery extends Omit<TypedBlockQuery, 'workspaceId'> {
  readonly workspaceId: string
}
