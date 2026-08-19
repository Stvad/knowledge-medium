const encodeScopePart = (value: string): string => encodeURIComponent(value)

const joinScope = (kind: string, parts: readonly string[]): string =>
  [kind, ...parts.map(encodeScopePart)].join(':')

export const outlineRenderScopeId = (topLevelBlockId: string): string =>
  joinScope('outline', [topLevelBlockId])

/** Scope of a PANEL's top-level outline. Includes the panel id so two panes
 *  showing the SAME block render under distinct scopes — per-pane registries
 *  (e.g. the video plugin's player handles, keyed by (renderScopeId,
 *  blockId)) and focus locations resolve to the right pane. The top-level
 *  block id is ALSO part of the scope so it changes on in-pane navigation:
 *  focus locations minted for one page self-invalidate rather than matching
 *  a same-id occurrence on the next. Every producer of a panel top-level
 *  scope must use this; `outlineRenderScopeId` remains for non-panel
 *  surfaces (`TopLevelRenderer`, embed fallbacks). */
export const panelRenderScopeId = (panelId: string, topLevelBlockId: string): string =>
  joinScope('panel', [panelId, topLevelBlockId])

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
