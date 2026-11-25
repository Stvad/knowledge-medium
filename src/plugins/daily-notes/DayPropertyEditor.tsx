import { useEffect, useState, type FormEvent } from 'react'
import { CalendarDays } from 'lucide-react'
import type { PropertyEditorProps } from '@/data/api'
import { Block } from '@/data/block'
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
import { dailyNoteDateValue, dailyNoteIsoFromRow, getOrCreateDailyNoteInTx } from './dailyNotes'
import { resolveDayInput, storedIsoDay } from './dayProperty'

const useSavedDay = (block: Block, workspaceId: string, targetId: string | undefined) => {
  const target = targetId ? block.repo.block(targetId) : undefined
  const saved = useHandle(target ?? block, {
    selector: row => {
      if (!target || !workspaceId || row === undefined) return {kind: 'loading'} as const
      if (!row) {
        const iso = !target.peekRaw() && storedIsoDay(target.id)
        return iso ? {kind: 'missing-live-target', iso} as const : {kind: 'unavailable'} as const
      }
      if (row.workspaceId !== workspaceId) return {kind: 'unavailable'} as const
      const iso = dailyNoteIsoFromRow(row)
      return {
        kind: 'linked', iso,
        label: iso ? formatRoamDate(dailyNoteDateValue(iso), 'UTC') : row.content.trim() || target.id,
        title: row.content.trim(),
      } as const
    },
  })
  const candidateId = saved.kind === 'missing-live-target' ? targetId : undefined
  const [confirmedAbsent, setConfirmedAbsent] = useState<string>()
  const repo = block.repo
  useEffect(() => {
    if (!candidateId) return
    let active = true
    // A normal block load treats tombstones as missing. A deleted literal ID still owns its reference.
    void repo.db.getOptional('SELECT id FROM blocks WHERE id = ?', [candidateId]).then(row => {
      if (active) setConfirmedAbsent(row ? undefined : candidateId)
    }).catch((error: unknown) => console.error('Could not check day reference', error))
    return () => { active = false }
  }, [candidateId, repo])
  if (saved.kind === 'missing-live-target') return confirmedAbsent === candidateId
    ? {kind: 'unlinked', iso: saved.iso} as const
    : {kind: 'unavailable'} as const
  return saved
}

type DayWrite = PropertyEditorProps<string | undefined>['resolveAndChange']

function UnlinkedDay({block, workspaceId, targetId, iso, resolveAndChange}: {
  block: Block
  workspaceId: string
  targetId: string
  iso: string
  resolveAndChange?: DayWrite
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const relink = async () => {
    if (pending || !resolveAndChange || block.repo.isReadOnly) return
    setPending(true)
    setError(undefined)
    try {
      const written = await resolveAndChange(async tx => {
        const source = await tx.get(block.id)
        if (!source || source.deleted || source.workspaceId !== workspaceId || await tx.get(targetId)) {
          throw new Error('The day or reference changed before it could be relinked')
        }
        return getOrCreateDailyNoteInTx(tx, block.repo.snapshotTypeRegistries(), workspaceId, iso)
      }, {ifUnchanged: true})
      if (!written) setError('The date property changed or is no longer editable')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not relink day')
    } finally {
      setPending(false)
    }
  }
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 text-sm">
      <span className="text-muted-foreground">{iso}, not linked</span>
      {!block.repo.isReadOnly && resolveAndChange && (
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void relink()}>
          Relink day
        </Button>
      )}
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </span>
  )
}

function SavedDay({block, targetId, workspaceId, saved, resolveAndChange}: {
  block: Block
  targetId: string
  workspaceId: string
  saved: ReturnType<typeof useSavedDay>
  resolveAndChange?: DayWrite
}) {
  const href = useAppHashInContext(workspaceId, targetId)
  const openBlock = useOpenBlock({blockId: targetId, workspaceId})
  if (saved.kind === 'unlinked') {
    return <UnlinkedDay key={targetId} block={block} workspaceId={workspaceId} targetId={targetId}
      iso={saved.iso} resolveAndChange={resolveAndChange}/>
  }
  if (saved.kind !== 'linked') return <span className="text-sm text-muted-foreground">Unavailable daily note</span>
  return (
    <a href={href} title={saved.title || undefined}
      className="min-w-0 truncate text-sm text-primary underline-offset-2 hover:underline"
      onClick={openBlock}>
      {saved.label}
    </a>
  )
}

export function StoredDayReference({block, targetId, resolveAndChange}: {
  block: Block; targetId: string; resolveAndChange?: DayWrite
}) {
  const workspaceId = useWorkspaceId(block)
  const saved = useSavedDay(block, workspaceId, targetId)
  return <SavedDay block={block} targetId={targetId} workspaceId={workspaceId} saved={saved}
    resolveAndChange={resolveAndChange}/>
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
      {value && workspaceId && <SavedDay block={block} targetId={value} workspaceId={workspaceId} saved={saved}
        resolveAndChange={resolveAndChange}/>}
      {editable ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-haspopup="dialog"
          aria-label={value ? 'Change day' : 'Choose day'}
          onClick={event => void openDialog(DayCalendarDialog, {
            initialIso: saved.kind === 'linked' || saved.kind === 'unlinked' ? saved.iso : null,
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
