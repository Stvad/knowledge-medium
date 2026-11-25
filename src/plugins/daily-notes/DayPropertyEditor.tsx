import { useState, type FormEvent } from 'react'
import { CalendarDays } from 'lucide-react'
import type { PropertyEditorProps } from '@/data/api'
import { Block } from '@/data/block'
import { getAliases } from '@/data/properties'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAppHashInContext } from '@/context/layoutWsContext'
import { useHandle, useWorkspaceId } from '@/hooks/block'
import { isImeKeyEvent } from '@/shortcuts/utils'
import { formatRoamDate } from '@/utils/dailyPage'
import { openDialog, type DialogContextProps } from '@/utils/dialogs'
import { useOpenBlock } from '@/utils/navigation'
import { CalendarGrid } from './CalendarGrid'
import { firstOfMonth, initialDateFromIso } from './calendar'
import { dailyNoteDateValue, dailyNoteIsoFromAliases, getOrCreateDailyNoteInTx } from './dailyNotes'
import { resolveDayInput } from './dayProperty'
import { dailyNoteDateProp } from './schema'

const useSavedDay = (block: Block, workspaceId: string, targetId: string | undefined) => {
  const target = targetId ? block.repo.block(targetId) : undefined
  return useHandle(target ?? block, {
    selector: row => {
      if (!target || !row || row.deleted || row.workspaceId !== workspaceId) return null
      const date = safeDecodeRowProperty(row, dailyNoteDateProp)
      const alias = date ? null : dailyNoteIsoFromAliases(getAliases(row))
      return {
        date: date ?? (alias ? dailyNoteDateValue(alias) : undefined),
        title: row.content.trim(),
      }
    },
  })
}

function SavedDay({targetId, workspaceId, saved}: {
  targetId: string
  workspaceId: string
  saved: ReturnType<typeof useSavedDay>
}) {
  const href = useAppHashInContext(workspaceId, targetId)
  const openBlock = useOpenBlock({blockId: targetId, workspaceId})
  if (!saved) return <span className="text-sm text-muted-foreground">Unavailable daily note</span>
  const label = saved.date ? formatRoamDate(saved.date, 'UTC') : saved.title || targetId
  return (
    <a href={href} title={saved.title || undefined}
      className="min-w-0 truncate text-sm text-primary underline-offset-2 hover:underline"
      onClick={openBlock}>
      {label}
    </a>
  )
}

export function StoredDayReference({block, targetId}: {block: Block; targetId: string}) {
  const workspaceId = useWorkspaceId(block)
  const saved = useSavedDay(block, workspaceId, targetId)
  return <SavedDay targetId={targetId} workspaceId={workspaceId} saved={saved}/>
}

function DayCalendarDialog({
  initialIso,
  hasValue,
  opener,
  onPick,
  resolve,
  cancel,
}: DialogContextProps<void> & {
  initialIso: string | null
  hasValue: boolean
  opener: HTMLButtonElement
  onPick: (iso: string | undefined) => Promise<void>
}) {
  const [input, setInput] = useState(initialIso ?? '')
  const [visibleMonth, setVisibleMonth] = useState(() => firstOfMonth(initialDateFromIso(initialIso ?? undefined)))
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const choose = async (text: string | undefined) => {
    if (pending) return
    setError(undefined)
    setPending(true)
    try {
      await onPick(text === undefined ? undefined : resolveDayInput(text))
      resolve()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not set day')
      setPending(false)
    }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void choose(input)
  }

  return (
    <Dialog open onOpenChange={next => {if (!next && !pending) cancel()}}>
      <DialogContent
        aria-describedby={undefined}
        aria-busy={pending || undefined}
        hideClose={pending}
        className="max-h-[calc(100dvh-1rem)] w-[min(24rem,calc(100vw-1rem))] overflow-y-auto rounded-lg p-4"
        onCloseAutoFocus={event => {
          if (!opener.isConnected) return
          event.preventDefault()
          opener.focus()
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.stopPropagation()
        }}
      >
        <DialogTitle>{hasValue ? 'Change day' : 'Choose day'}</DialogTitle>
        <form className="flex items-center gap-2" onSubmit={submit}>
          <Input
            aria-label="Day"
            aria-invalid={error !== undefined}
            disabled={pending}
            placeholder="YYYY-MM-DD or tomorrow"
            value={input}
            onChange={event => {
              setInput(event.target.value)
              setError(undefined)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && isImeKeyEvent(event.nativeEvent)) event.preventDefault()
            }}
          />
          <Button type="submit" size="sm" disabled={pending || !input.trim()}>Set day</Button>
        </form>
        {error && <div role="alert" className="text-sm text-destructive">{error}</div>}
        <div>
          <CalendarGrid
            visibleMonth={visibleMonth}
            onVisibleMonthChange={setVisibleMonth}
            selectedIso={initialIso}
            disabled={pending}
            onSelect={iso => void choose(iso)}
          />
        </div>
        {hasValue && (
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void choose(undefined)}>
            Clear day
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BoundDayPropertyEditor({
  block,
  value,
  resolveAndChange,
}: PropertyEditorProps<string | undefined> & {block: Block}) {
  const workspaceId = useWorkspaceId(block)
  const saved = useSavedDay(block, workspaceId, value)
  const editable = !block.repo.isReadOnly && workspaceId && resolveAndChange
  const pick = async (iso: string | undefined) => {
    if (!workspaceId || !resolveAndChange) return
    const written = await resolveAndChange(async tx => {
      // Both scalar ref codecs accept an empty string as their clear value.
      if (iso === undefined) return ''
      return getOrCreateDailyNoteInTx(tx, block.repo.snapshotTypeRegistries(), workspaceId, iso)
    })
    if (!written) throw new Error('The date property changed or is no longer editable')
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1">
      {value && workspaceId && <SavedDay targetId={value} workspaceId={workspaceId} saved={saved}/>}
      {editable ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-haspopup="dialog"
          aria-label={value ? 'Change day' : 'Choose day'}
          onClick={event => void openDialog(DayCalendarDialog, {
            initialIso: saved?.date?.toISOString().split('T')[0] ?? null,
            hasValue: Boolean(value),
            opener: event.currentTarget,
            onPick: pick,
          })}
        >
          <CalendarDays className="size-4" aria-hidden="true"/>
          {!value && 'Choose day'}
        </Button>
      ) : (!value && <span className="text-sm text-muted-foreground">Empty</span>)}
    </div>
  )
}

export function DayPropertyEditor(props: PropertyEditorProps<string | undefined>) {
  return props.block instanceof Block
    ? <BoundDayPropertyEditor {...props} block={props.block}/>
    : <>{props.value}</>
}
