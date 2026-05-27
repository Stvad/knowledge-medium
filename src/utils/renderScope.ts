const encodeScopePart = (value: string): string => encodeURIComponent(value)

const joinScope = (kind: string, parts: readonly string[]): string =>
  [kind, ...parts.map(encodeScopePart)].join(':')

export const outlineRenderScopeId = (topLevelBlockId: string): string =>
  joinScope('outline', [topLevelBlockId])

export const embedRenderScopeId = (
  parentRenderScopeId: string,
  sourceBlockId: string,
  occurrenceId: string,
  targetBlockId: string,
): string => joinScope('embed', [
  sourceBlockId,
  occurrenceId,
  targetBlockId,
  parentRenderScopeId,
])

export const backlinkRenderScopeId = (
  parentRenderScopeId: string,
  occurrenceId: string,
): string => joinScope('backlink', [occurrenceId, parentRenderScopeId])

export const breadcrumbRenderScopeId = (
  parentRenderScopeId: string,
  blockId: string,
  occurrenceId: string,
): string => joinScope('breadcrumb', [blockId, occurrenceId, parentRenderScopeId])
