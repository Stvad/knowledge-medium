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
 * The drafts re-adopt the committed value whenever it changes underneath them
 * (a peer edit, an undo, a preset switch that resets the config), which is the
 * same trade the name field records: a remote write landing mid-edit beats a
 * stale draft overwriting it on the next blur.
 *
 * ADDING OR REMOVING A CHOICE CARRIES THE PENDING EDIT rather than racing it.
 * Clicking one of those buttons blurs whatever input was being typed in, so
 * the naive pair is two writes from one user action — and the second is
 * judged against a definition row the first has already changed, which the
 * gesture's staleness check then refuses. Both buttons write from the DRAFT,
 * so one write carries both, and the blur that precedes the click is told to
 * stand down.
 */
import {useRef, useState} from 'react'
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
  if (committed !== adopted) {
    setAdopted(committed)
    setDraft(value.options)
  }

  // Set on the pointer press that is about to steal focus from an input, so
  // the blur it causes knows the click behind it is already writing. Cleared
  // when an input takes focus, which is the only thing that can produce
  // another blur — so a press abandoned without a click cannot swallow a
  // later commit.
  const structural = useRef(false)

  const edit = (index: number, patch: {value?: string; label?: string}) => {
    setDraft(draft.map((option, i) => i === index ? {...option, ...patch} : option))
  }
  /** Commit the draft, or put it back if nothing moved — an input left
   *  untouched must not write, or tabbing through the editor would fan out. */
  const commit = () => {
    if (structural.current) return
    if (JSON.stringify(draft) === committed) return
    onChange({options: draft})
  }
  /** Write from the draft, so a structural click carries whatever was being
   *  typed when it stole focus. */
  const commitStructural = (options: EnumPresetConfig['options']) => {
    structural.current = false
    onChange({options})
  }
  return (
    <div className="space-y-2">
      {draft.map((option, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`Choice ${index + 1} value`}
            value={option.value}
            placeholder="value"
            onChange={event => edit(index, {value: event.target.value})}
            onFocus={() => { structural.current = false }}
            onBlur={commit}
          />
          <Input
            aria-label={`Choice ${index + 1} label`}
            value={option.label}
            placeholder="Label"
            onChange={event => edit(index, {label: event.target.value})}
            onFocus={() => { structural.current = false }}
            onBlur={commit}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove choice ${index + 1}`}
            onPointerDown={() => { structural.current = true }}
            onClick={() => commitStructural(draft.filter((_, i) => i !== index))}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onPointerDown={() => { structural.current = true }}
        onClick={() => commitStructural([...draft, {value: '', label: ''}])}
      >
        <Plus className="mr-1 h-4 w-4" /> Add choice
      </Button>
    </div>
  )
}
