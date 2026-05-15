/**
 * Global keyboard actions for navigating daily notes:
 *
 *   - `open_today` (cmd+shift+`)               — today's note
 *   - `append_today_daily_block` (ctrl+shift+n) — new block in today's note,
 *     opened in a stacked panel
 *   - `open_previous_daily_note` (cmd+shift+[) — yesterday relative to
 *     the currently viewed daily note (or to today if not on one)
 *   - `open_next_daily_note` (cmd+shift+])     — tomorrow relative
 *
 * The prev/next actions need to figure out "what daily note is this
 * panel showing right now" so the offset is relative. We do that by
 * walking ancestors of the panel's top-level block and looking for a
 * page whose `aliases` list contains an ISO-shaped date — that's the
 * canonical alias for a daily note, written by `getOrCreateDailyNote`
 * via `dailyPageAliases`. Falling back to `todayIso()` when nothing in
 * the ancestor chain is a daily note keeps the shortcuts functional
 * from any view.
 *
 * Originally lived in `src/shortcuts/defaultShortcuts.ts` alongside
 * the rest of the kernel action set; extracted here so the daily-notes
 * feature can be removed/replaced as a single unit.
 */
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { ChangeScope } from '@/data/api'
import { getLayoutSessionBlock } from '@/data/globalState.ts'
import {
  activePanelIdProp,
  aliasesProp,
  editorSelection,
  isEditingProp,
} from '@/data/properties.ts'
import {
  ActionConfig,
  ActionContextTypes,
} from '@/shortcuts/types.ts'
import { CalendarDays, CalendarPlus } from 'lucide-react'
import { getLayoutSessionId } from '@/utils/layoutSessionId.ts'
import { parseAppHash } from '@/utils/routing.ts'
import {
  navigateFromGlobalCommand,
  resolveGlobalCommandTopLevelBlockId,
} from '@/utils/navigation.ts'
import { insertSidebarStackedPanel } from '@/utils/panelLayoutProjection.ts'
import { addDaysIso, getOrCreateDailyNote, todayIso } from './dailyNotes.ts'

export const OPEN_TODAY_ACTION_ID = 'open_today'
export const APPEND_TODAY_DAILY_BLOCK_ACTION_ID = 'append_today_daily_block'
export const OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID = 'open_previous_daily_note'
export const OPEN_NEXT_DAILY_NOTE_ACTION_ID = 'open_next_daily_note'

const ISO_ALIAS_RE = /^\d{4}-\d{2}-\d{2}$/

const dailyNoteIsoFromBlock = (block: Block): string | null => {
  const aliases = block.peekProperty(aliasesProp) ?? []
  return aliases.find(alias => ISO_ALIAS_RE.test(alias)) ?? null
}

const findContainingDailyNoteIso = async (
  repo: Repo,
  blockId: string,
  workspaceId: string,
): Promise<string | null> => {
  const data = await repo.load(blockId, {ancestors: true})
  if (!data || data.workspaceId !== workspaceId) return null

  let block: Block | null = repo.block(blockId)
  while (block) {
    const iso = dailyNoteIsoFromBlock(block)
    if (iso) return iso
    block = block.parent
  }
  return null
}

/** Resolve the ISO date of the daily note currently visible in the
 *  primary (or active, on mobile) panel. Returns null when the panel's
 *  top-level block isn't a daily note or no panel is open. Used by both
 *  the prev/next offset actions and the date picker to open with the
 *  correct month + selected day. */
export const resolveCurrentDailyNoteIso = async (
  repo: Repo,
  workspaceId: string,
): Promise<string | null> => {
  const topLevelBlockId = await resolveGlobalCommandTopLevelBlockId(repo, workspaceId)
  if (!topLevelBlockId) return null
  return findContainingDailyNoteIso(repo, topLevelBlockId, workspaceId)
}

const openDailyNoteByOffset = async (repo: Repo, offsetDays: number) => {
  const route = parseAppHash(window.location.hash)
  const workspaceId = route.workspaceId ?? repo.activeWorkspaceId
  if (!workspaceId) return

  const currentIso = await resolveCurrentDailyNoteIso(repo, workspaceId)
  const targetIso = addDaysIso(currentIso ?? todayIso(), offsetDays)
  const note = await getOrCreateDailyNote(repo, workspaceId, targetIso)
  navigateFromGlobalCommand(repo, {blockId: note.id, workspaceId})
}

const appendTodayDailyBlockInStack = async (
  repo: Repo,
  uiStateBlock: Block,
): Promise<void> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId || repo.isReadOnly) return

  const note = await getOrCreateDailyNote(repo, workspaceId, todayIso())
  const blockId = await repo.mutate.createChild({
    parentId: note.id,
    position: {kind: 'last'},
  })

  const layoutSessionBlock = await getLayoutSessionBlock(uiStateBlock, getLayoutSessionId())
  await layoutSessionBlock.load()
  const sourcePanelId = layoutSessionBlock.peekProperty(activePanelIdProp)
  const panelId = await insertSidebarStackedPanel(repo, layoutSessionBlock, blockId, {sourcePanelId})

  await repo.tx(async tx => {
    await tx.setProperty(panelId, editorSelection, {blockId, start: 0})
    await tx.setProperty(panelId, isEditingProp, true)
  }, {scope: ChangeScope.UiState, description: 'edit new daily block'})
}

export const dailyNotesActions = (
  {repo}: {repo: Repo},
): readonly ActionConfig<typeof ActionContextTypes.GLOBAL>[] => [
  {
    // Keep the legacy `open_today` id rather than the more-descriptive
    // `open_today_daily_note`. User-customised key bindings persist
    // under the action id; renaming would silently break them on
    // upgrade. (Prev/next never had a shorter id, so they keep theirs.)
    id: OPEN_TODAY_ACTION_ID,
    description: "Open today's daily note",
    context: ActionContextTypes.GLOBAL,
    icon: CalendarDays,
    handler: async () => {
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) return
      const note = await getOrCreateDailyNote(repo, workspaceId, todayIso())
      navigateFromGlobalCommand(repo, {blockId: note.id, workspaceId})
    },
    defaultBinding: {
      keys: ['cmd+shift+`', 'ctrl+shift+`'],
    },
  },
  {
    id: APPEND_TODAY_DAILY_BLOCK_ACTION_ID,
    description: 'New daily block',
    context: ActionContextTypes.GLOBAL,
    icon: CalendarPlus,
    handler: async ({uiStateBlock}) => {
      await appendTodayDailyBlockInStack(repo, uiStateBlock)
    },
    defaultBinding: {
      keys: 'ctrl+shift+n',
      eventOptions: {
        preventDefault: true,
      },
    },
  },
  {
    id: OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID,
    description: 'Open previous daily note',
    context: ActionContextTypes.GLOBAL,
    handler: async () => {
      await openDailyNoteByOffset(repo, -1)
    },
    defaultBinding: {
      keys: ['cmd+shift+[', 'ctrl+shift+['],
    },
  },
  {
    id: OPEN_NEXT_DAILY_NOTE_ACTION_ID,
    description: 'Open next daily note',
    context: ActionContextTypes.GLOBAL,
    handler: async () => {
      await openDailyNoteByOffset(repo, 1)
    },
    defaultBinding: {
      keys: ['cmd+shift+]', 'ctrl+shift+]'],
    },
  },
]
