import { useState, type FormEvent } from 'react'
import { CalendarDays } from 'lucide-react'
import type { PropertyEditorProps } from '@/data/api'
import { Block } from '@/data/block'
import { getAliases } from '@/data/properties'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAppHashInContext } from '@/context/layoutWsContext'
import { useHandle } from '@/hooks/block'
import { isImeKeyEvent } from '@/shortcuts/utils'
import { useOpenBlock } from '@/utils/navigation'
import { CalendarGrid } from './CalendarGrid'
import { firstOfMonth, initialDateFromIso } from './calendar'
import { dailyNoteIsoFromAliases, getOrCreateDailyNoteInTx } from './dailyNotes'
import { resolveDayInput } from './dayProperty'
import { dailyNoteDateProp } from './schema'

function SavedDay({targetId, workspaceId, label}: {targetId: string; workspaceId: string; label: string}) {
  const href = useAppHashInContext(workspaceId, targetId)
  const openBlock = useOpenBlock({blockId: targetId, workspaceId})
  return (
    <a href={href} title="Open daily note"
      className="min-w-0 truncate text-sm text-primary underline-offset-2 hover:underline"
      onClick={openBlock}>
      {label}
    </a>
  )
}

function DayCalendar({
  initialIso,
  hasValue,
  pending,
  onPick,
}: {
  initialIso: string | null
  hasValue: boolean
  pending: boolean
  onPick: (iso: string | undefined) => Promise<void>
}) {
  const [input, setInput] = useState(initialIso ?? '')
  const [visibleMonth, setVisibleMonth] = useState(() => firstOfMonth(initialDateFromIso(initialIso ?? undefined)))
  const [error, setError] = useState<string>()
  const choose = async (text: string | undefined) => {
    setError(undefined)
    try {
      await onPick(text === undefined ? undefined : resolveDayInput(text))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not set day')
    }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void choose(input)
  }

  return (
    <>
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
    </>
  )
}

function BoundDayPropertyEditor({
  block,
  value,
  resolveAndChange,
}: PropertyEditorProps<string | undefined> & {block: Block}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const workspaceId = useHandle(block, {selector: row => row?.workspaceId})
  const target = value ? block.repo.block(value) : undefined
  const saved = useHandle(target ?? block, {
    selector: row => {
      if (!target || !row || row.workspaceId !== workspaceId) return null
      const day = safeDecodeRowProperty(row, dailyNoteDateProp)
      return {
        iso: day?.toISOString().slice(0, 10) ?? dailyNoteIsoFromAliases(getAliases(row)),
        content: row.content,
      }
    },
  })
  const editable = !block.repo.isReadOnly && workspaceId && resolveAndChange
  const pick = async (iso: string | undefined) => {
    if (!workspaceId || !resolveAndChange || pending) return
    setPending(true)
    try {
      const written = await resolveAndChange(async tx => {
        // Both scalar ref codecs accept an empty string as their clear value.
        if (iso === undefined) return ''
        return getOrCreateDailyNoteInTx(tx, block.repo.snapshotTypeRegistries(), workspaceId, iso)
      })
      if (!written) throw new Error('The date property changed or is no longer editable')
      setOpen(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1">
      {value && workspaceId && (saved ? (
        <SavedDay
          targetId={value}
          workspaceId={workspaceId}
          label={saved.content || saved.iso || value}
        />
      ) : <span className="text-sm text-muted-foreground">Unavailable daily note</span>)}
      {editable ? (
        <Dialog open={open} onOpenChange={next => {if (!pending) setOpen(next)}}>
          <DialogTrigger asChild>
            <Button type="button" size="sm" variant="ghost" aria-label={value ? 'Change day' : 'Choose day'}>
              <CalendarDays className="size-4" aria-hidden="true"/>
              {!value && 'Choose day'}
            </Button>
          </DialogTrigger>
          <DialogContent
            aria-describedby={undefined}
            aria-busy={pending || undefined}
            className="max-h-[calc(100dvh-1rem)] w-[min(24rem,calc(100vw-1rem))] overflow-y-auto rounded-lg p-4"
            onKeyDown={event => {
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.stopPropagation()
            }}
          >
            <DialogTitle>{value ? 'Change day' : 'Choose day'}</DialogTitle>
            <DayCalendar initialIso={saved?.iso ?? null} hasValue={Boolean(value)} pending={pending} onPick={pick}/>
          </DialogContent>
        </Dialog>
      ) : (!value && <span className="text-sm text-muted-foreground">Empty</span>)}
    </div>
  )
}

export function DayPropertyEditor(props: PropertyEditorProps<string | undefined>) {
  return props.block instanceof Block
    ? <BoundDayPropertyEditor {...props} block={props.block}/>
    : <>{props.value}</>
}
