/**
 * Global keyboard actions for navigating daily notes:
 *
 *   - `open_today` ($mod+Shift+`)                — today's note
 *   - `append_today_daily_block` (Ctrl+Shift+n)  — new block in today's note,
 *     opened in a stacked panel
 *   - `open_previous_daily_note` (Ctrl+Shift+[)  — yesterday relative to
 *     the currently viewed daily note (or to today if not on one)
 *   - `open_next_daily_note` (Ctrl+Shift+])      — tomorrow relative
 *
 * Prev/next use literal Ctrl (not $mod) because Cmd+Shift+[ / Cmd+Shift+]
 * are reserved on Mac for browser prev/next-tab and aren't reliably
 * cancellable — falling through to the browser would silently swap
 * tabs instead of navigating daily notes. Ctrl+Shift+[/] is free on
 * every platform and matches what Mac users have been using
 * historically (the legacy ['cmd+shift+[', 'ctrl+shift+['] pair only
 * worked via the Ctrl entry in practice).
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
import { getLayoutSessionBlock } from '@/data/stateBlocks.js'
import {
  activePanelIdProp,
  aliasesProp,
  editorSelection,
  isEditingProp,
} from '@/data/properties.js'
import type { EditorSelectionState } from '@/data/properties.js'
import {
  ActionConfig,
  ActionContextTypes,
} from '@/shortcuts/types.js'
import { CalendarDays, CalendarPlus } from 'lucide-react'
import { getLayoutSessionId } from '@/utils/layoutSessionId.js'
import {
  activeWorkspaceIdPreferringHash,
  navigate,
  navigateFromGlobalCommand,
  resolveGlobalCommandTarget,
} from '@/utils/navigation.js'
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

/** The panel a navigator command targets, as a daily-note anchor: the workspace
 *  that panel lives in, plus the visible block's daily-note ISO (or null if it
 *  isn't a daily note). Goes through the same policy + destination resolution as
 *  the navigation, so the workspace and validation match where prev/next will
 *  create + open — even under a policy that retargets the workspace. Returns
 *  null only when no panel is open. */
const resolveDailyNoteAnchor = async (
  repo: Repo,
  workspaceId: string,
): Promise<{workspaceId: string; iso: string | null} | null> => {
  const target = await resolveGlobalCommandTarget(repo, workspaceId)
  if (!target) return null
  return {
    workspaceId: target.workspaceId,
    iso: await findContainingDailyNoteIso(repo, target.blockId, target.workspaceId),
  }
}

/** Resolve just the ISO date of the currently-visible daily note — for the date
 *  picker, which only needs the month/day to open on. */
export const resolveCurrentDailyNoteIso = async (
  repo: Repo,
  workspaceId: string,
): Promise<string | null> => (await resolveDailyNoteAnchor(repo, workspaceId))?.iso ?? null

const openDailyNoteByOffset = async (repo: Repo, offsetDays: number) => {
  const fallbackWorkspaceId = activeWorkspaceIdPreferringHash(repo)
  if (!fallbackWorkspaceId) return

  // Anchor on the targeted panel's workspace uniformly — so under a
  // workspace-retargeting policy we create + open the offset note in that same
  // workspace even when the panel isn't currently a daily note. Falls back to
  // the command workspace + today only when no panel is open.
  const anchor = await resolveDailyNoteAnchor(repo, fallbackWorkspaceId)
  const workspaceId = anchor?.workspaceId ?? fallbackWorkspaceId
  const targetIso = addDaysIso(anchor?.iso ?? todayIso(), offsetDays)
  const note = await getOrCreateDailyNote(repo, workspaceId, targetIso)
  navigateFromGlobalCommand(repo, {blockId: note.id, workspaceId})
}

/** Append a fresh block to today's daily note and open it in a new
 *  sidebar-stacked panel ready for editing. Shared between the
 *  `append_today_daily_block` keyboard action and the
 *  `consumeAppIntent` PWA-shortcut / share-target dispatcher in
 *  the app-intents plugin — both want the exact same UX (drop the
 *  user into a fresh, focused, editable block on today's note);
 *  `content` lets the share-target seed the block with the shared
 *  title/text/URL. Cursor lands at end-of-content so the user can
 *  keep typing.
 *
 *  Returns the new block id on success, or `null` when nothing was
 *  done (no active workspace, or read-only mode). The PWA-intent
 *  dispatcher inspects the return value before stripping the URL
 *  params — that way a shared payload that hits a read-only repo
 *  isn't silently lost (the params survive so a reload, after the
 *  user exits read-only mode, retries the dispatch). */
export const appendTodayDailyBlockInStack = async (
  repo: Repo,
  layoutSessionBlock: Block,
  options: {content?: string} = {},
): Promise<string | null> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId || repo.isReadOnly) return null

  const content = options.content
  // One undo entry for note creation + the appended block.
  const blockId = await repo.undoGroup(async repo => {
    const note = await getOrCreateDailyNote(repo, workspaceId, todayIso())
    return repo.mutate.createChild({
      parentId: note.id,
      content,
      position: {kind: 'last'},
    })
  })

  await layoutSessionBlock.load()
  const sourcePanelId = layoutSessionBlock.peekProperty(activePanelIdProp)
  // Route through navigate() (not insertSidebarStackedPanel directly) so the
  // open is observable/interceptable via navigationVerb like every other
  // navigation; the returned panelId is where we place the cursor.
  const dest = await navigate(repo, {target: 'sidebar-stack', blockId, workspaceId, sourcePanelId, origin: 'daily-note'})

  // Only drop into edit mode when the navigation actually landed on the block
  // we just created. A navigationVerb decorator can retarget the open to a
  // different block; in that case the cursor (sized to our content) and the
  // selection (pointing at our blockId) don't belong to the panel's displayed
  // block, so we leave the panel as the decorator placed it rather than writing
  // a mismatched selection. The created block still exists either way.
  if (dest && dest.blockId === blockId) {
    const cursor = content ? content.length : 0
    const selection: EditorSelectionState = {blockId, start: cursor}
    await repo.tx(async tx => {
      await tx.setProperty(dest.panelId, editorSelection, selection)
      await tx.setProperty(dest.panelId, isEditingProp, true)
    }, {scope: ChangeScope.UiState, description: 'edit new daily block'})
  }

  return blockId
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
      keys: 'Control+Shift+Backquote',
    },
  },
  {
    id: APPEND_TODAY_DAILY_BLOCK_ACTION_ID,
    description: 'New daily block',
    context: ActionContextTypes.GLOBAL,
    icon: CalendarPlus,
    handler: async ({uiStateBlock}) => {
      const layoutSessionBlock = await getLayoutSessionBlock(uiStateBlock, getLayoutSessionId())
      await appendTodayDailyBlockInStack(repo, layoutSessionBlock)
    },
    defaultBinding: {
      keys: 'Control+Shift+n',
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
      // Literal Control (not $mod) — Cmd+Shift+[ is browser prev-tab
      // on Mac. See file-header comment.
      keys: 'Control+Shift+BracketLeft',
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
      // Literal Control (not $mod) — Cmd+Shift+] is browser next-tab
      // on Mac. See file-header comment.
      keys: 'Control+Shift+BracketRight',
    },
  },
]
