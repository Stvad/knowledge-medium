/**
 * Choices for an enum property.
 *
 * Text edits COMMIT ON BLUR, the way the property-schema name field beside
 * this one does, and the reason is the same only louder: `onChange` here is a
 * write to the definition row, and every write to a definition row fans out to
 * every block using that property inside the same transaction. Committing per
 * keystroke made one character a whole fan-out — and once that is large enough
 * to be worth confirming (#1112), a modal per character. Each input keeps its
 * own draft until it is left; adding and removing a choice are single acts and
 * commit straight away.
 *
 * The drafts re-adopt the committed value whenever SOMEBODY ELSE changes it
 * (a peer edit, an undo, a preset switch that resets the config), which is
 * the same trade the name field records: a remote write landing mid-edit
 * beats a stale draft overwriting it on the next blur.
 *
 * Somebody else, and that qualifier is load-bearing now that a write is not
 * instant — it is planned, counted, sometimes confirmed, and only then
 * committed, so the props go on describing the old value for as long as that
 * takes. `pending` is what this editor has asked for and not yet seen come
 * back, and it settles two things that both read as "my own write is not
 * mine". A request that never lands is not one of them: the host remounts
 * this editor when a change is cancelled or refused, which is the only way
 * the outcome reaches here at all — `onChange` returns void. Its acknowledgement must not wipe a draft: tab out of one field and
 * type in the next, and the first field's write coming back would otherwise
 * replace everything with its own snapshot, erasing what is being typed. And
 * a blur caused by that write must not write again: a structural change big
 * enough to be confirmed mounts a focus trap, which blurs the input this
 * editor had just kept focused, and the commit behind it would queue a
 * second change that puts back the choice the first one removed.
 *
 * ADDING OR REMOVING A CHOICE CARRIES THE PENDING EDIT rather than racing it.
 * Those buttons would otherwise blur whatever input was being typed in, and
 * one user action would be two writes — the second judged against a
 * definition row the first had already changed, which the gesture's
 * staleness check then refuses. So they write from the DRAFT, and they
 * decline the focus that would cause the blur at all (`preventDefault` on
 * mousedown, the toolbar-button convention).
 *
 * DECLINED: suppressing the blur's commit with a flag set on pointer-down
 * instead. A press that is dragged away or cancelled never reaches a click
 * to clear such a flag, and the typed edit then sits in a draft no blur
 * will commit. Nothing may be remembered between the press and the click.
 */
import {useState} from 'react'
import {Plus, X} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import type {ValuePresetConfigEditorProps} from '@/data/api'
import type {EnumPresetConfig} from '@/data/kernelValuePresetCores'

export function EnumOptionsConfigEditor({
  value,
  onChange,
}: ValuePresetConfigEditorProps<EnumPresetConfig>) {
  // Render-phase resync, keyed on the committed options: the draft array is
  // replaced whole rather than merged, because a peer edit can add or remove
  // choices and a per-index merge would pair a draft with somebody else's row.
  const committed = JSON.stringify(value.options)
  const [adopted, setAdopted] = useState(committed)
  const [draft, setDraft] = useState(value.options)
  const [pending, setPending] = useState<string | null>(null)
  if (committed !== adopted) {
    setAdopted(committed)
    // Only what this editor did NOT ask for takes the draft away.
    if (committed !== pending) setDraft(value.options)
    setPending(null)
  }
  /** What the stored options are, or are about to be. Comparing against this
   *  rather than `committed` is what keeps an in-flight write from being
   *  asked for twice. */
  const requested = pending ?? committed

  const edit = (index: number, patch: {value?: string; label?: string}) => {
    setDraft(draft.map((option, i) => i === index ? {...option, ...patch} : option))
  }
  /** Commit the draft, or put it back if nothing moved — an input left
   *  untouched must not write, or tabbing through the editor would fan out. */
  const request = (options: EnumPresetConfig['options']) => {
    setDraft(options)
    setPending(JSON.stringify(options))
    onChange({options})
  }
  const commit = () => {
    if (JSON.stringify(draft) === requested) return
    request(draft)
  }
  /** Keeps the PRESS from taking focus, so it does not blur the input being
   *  typed in — the click then carries that edit in the draft it writes
   *  from, as one change. It claims nothing about focus afterwards: a
   *  confirmation mounting behind the click traps focus and blurs the input
   *  anyway, which is `pending`'s half of the job, not this one's. */
  const keepFocus = (event: {preventDefault: () => void}) => { event.preventDefault() }
  return (
    <div className="space-y-2">
      {draft.map((option, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`Choice ${index + 1} value`}
            value={option.value}
            placeholder="value"
            onChange={event => edit(index, {value: event.target.value})}
            onBlur={commit}
          />
          <Input
            aria-label={`Choice ${index + 1} label`}
            value={option.label}
            placeholder="Label"
            onChange={event => edit(index, {label: event.target.value})}
            onBlur={commit}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove choice ${index + 1}`}
            onMouseDown={keepFocus}
            onClick={() => request(draft.filter((_, i) => i !== index))}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onMouseDown={keepFocus}
        onClick={() => request([...draft, {value: '', label: ''}])}
      >
        <Plus className="mr-1 h-4 w-4" /> Add choice
      </Button>
    </div>
  )
}
