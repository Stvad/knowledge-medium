/** Prev/next-day arrows flanking a zoomed-in daily note's title.
 *
 *  These used to be two buttons in the app header. "Shift the date" is a
 *  property of the note you are looking at, not of the app: with more than one
 *  panel open the header pair had to GUESS which panel it meant (via
 *  `resolveGlobalCommandTarget`), and it sat there inert on every non-date
 *  page. A content decorator already knows — it renders inside the panel whose
 *  title it flanks, so it navigates that panel by id (`target: 'panel'`) and
 *  only exists while a daily note is the focal block.
 *
 *  The keyboard actions (`open_previous_daily_note` / `open_next_daily_note`)
 *  are unchanged and still resolve their target globally — a key press has no
 *  panel to read.
 *
 *  Gate shape follows the `blockContentDecoratorsFacet` contract: the
 *  contribution decides only structural things (`isFocalRender`), and
 *  "is this block a daily note" is decided INSIDE the component from a
 *  reactive `aliases` read — so a block that gains or loses its ISO alias
 *  picks the arrows up (or drops them) without a decorator re-resolve.
 */
import { useCallback, type ComponentType } from 'react'
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import { useBlockContext } from '@/context/block.js'
import type { Block } from '@/data/block'
import { aliasesProp } from '@/data/properties.js'
import {
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import { useProperty, useWorkspaceId } from '@/hooks/block.js'
import { isFocalRender } from '@/hooks/useIsFocalRender.js'
import type { BlockRenderer } from '@/types.js'
import { navigate } from '@/utils/navigation.js'
import {
  addDaysIso,
  dailyNoteIsoFromAliases,
  getOrCreateDailyNote,
} from './dailyNotes.ts'

const ARROW_CLASS = 'inline-flex h-7 w-7 shrink-0 items-center justify-center '
  + 'rounded-md text-muted-foreground transition-colors '
  + 'hover:bg-accent hover:text-foreground sm:h-8 sm:w-8'

const DateNavArrow = ({Icon, label, onOpen}: {
  Icon: LucideIcon
  label: string
  onOpen: () => void
}) => (
  <button
    type="button"
    // The arrows live inside the block's content surface — without this the
    // click lands on the block and drops the title into edit mode.
    data-block-interaction="ignore"
    className={ARROW_CLASS}
    title={label}
    aria-label={label}
    onClick={event => {
      event.stopPropagation()
      onOpen()
    }}
  >
    <Icon className="h-5 w-5"/>
  </button>
)

interface DateNavDecoratorProps {
  block: Block
  Inner: BlockRenderer
}

const DateNavDecorator = ({block, Inner}: DateNavDecoratorProps) => {
  const repo = block.repo
  const [aliases] = useProperty(block, aliasesProp)
  const {panelId} = useBlockContext()
  // The note's OWN workspace, not `repo.activeWorkspaceId`: the neighbouring
  // day has to be created and opened in the same workspace as the note the
  // arrows are attached to.
  const workspaceId = useWorkspaceId(block)
  const iso = dailyNoteIsoFromAliases(aliases)

  const openOffset = useCallback((offset: number) => {
    if (!iso || !panelId || !workspaceId) return
    void (async () => {
      const note = await getOrCreateDailyNote(repo, workspaceId, addDaysIso(iso, offset))
      // `navigate` never rejects (logs + returns null), so this only catches a
      // failed get-or-create — e.g. a read-only workspace.
      await navigate(repo, {
        target: 'panel',
        panelId,
        blockId: note.id,
        workspaceId,
        origin: 'daily-note',
      })
    })().catch(error => {
      console.error('[daily-notes] date nav failed', error)
    })
  }, [repo, iso, panelId, workspaceId])

  // Not a daily note, or nothing to navigate (no panel / workspace not loaded
  // yet) → the content renders exactly as it would undecorated.
  if (!iso || !panelId || !workspaceId) return <Inner block={block}/>

  return (
    // The arrows hug the title rather than claiming the panel's full width:
    // no `flex-1` on the content, so the next-day arrow sits right after the
    // date instead of floating at the far right edge. `min-w-0` lets a long
    // title shrink instead of pushing the arrow off-screen.
    //
    // `items-start`, NOT `items-center`. The content box is TALLER than the
    // text line it starts with — the block editor carries `min-h-[1.7em]`
    // (40.8px at the 24px title size) around a 30px line, and that slack sits
    // BELOW the text. Centring against the box therefore lands ~5px under the
    // title's cap band, which reads as "not centred" even though the boxes
    // agree exactly. Measured against canvas glyph metrics: items-center is
    // +5.0px off the cap band, items-start +0.6px, items-baseline -1.4px.
    // Top-aligning also keeps the arrows on the FIRST line no matter what
    // stacks below them inside this row.
    <div className="flex w-full items-start gap-1">
      <DateNavArrow
        Icon={ChevronLeft}
        label="Open previous daily note"
        onOpen={() => openOffset(-1)}
      />
      <div className="min-w-0">
        <Inner block={block}/>
      </div>
      <DateNavArrow
        Icon={ChevronRight}
        label="Open next daily note"
        onOpen={() => openOffset(1)}
      />
    </div>
  )
}

// Memoized per inner renderer so a parent re-render doesn't hand React a new
// component identity and unmount the content subtree (same invariant as the
// todo / type-chip decorators).
const cache = new WeakMap<BlockRenderer, BlockRenderer>()

const decorate: BlockContentDecorator = inner => {
  const cached = cache.get(inner)
  if (cached) return cached

  const Decorated: ComponentType<{block: Block}> = ({block}) => (
    <DateNavDecorator block={block} Inner={inner}/>
  )
  Decorated.displayName = 'WithDateNav'
  cache.set(inner, Decorated)
  return Decorated
}

export const dateNavDecoratorContribution: BlockContentDecoratorContribution =
  ctx => isFocalRender(ctx) ? decorate : null
