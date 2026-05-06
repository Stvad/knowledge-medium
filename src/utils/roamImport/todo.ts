import type { RoamTodoState } from '@/plugins/todo/schema'

const ROAM_TODO_MARKER_RE =
  /(^|\s)(?:#\[\[(TODO|DONE)\]\]|#(TODO|DONE)\b|\{\{\s*\[\[(TODO|DONE)\]\]\s*\}\})(?=$|\s)/g

export const extractRoamTodoMarker = (
  rawContent: string,
): {content: string; todoState?: RoamTodoState} => {
  let todoState: RoamTodoState | undefined
  ROAM_TODO_MARKER_RE.lastIndex = 0
  const content = rawContent
    .replace(ROAM_TODO_MARKER_RE, (_match, _lead, pageState, tagState, commandState) => {
      const nextState = (pageState ?? tagState ?? commandState) as RoamTodoState
      todoState ??= nextState
      return ' '
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  return {content, todoState}
}

export const stripRoamTodoContent = (rawContent: string | undefined): string =>
  extractRoamTodoMarker(rawContent ?? '').content
