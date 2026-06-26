/** Editor for `enum` codec properties — a plain `<select>` whose options
 *  ride on the codec (`codecs.enum(options)`), so a single component
 *  serves every enum property without per-name wiring. Resolved by the
 *  `enum` ValuePreset keyed on `codec.type`. */

import { isEnumCodec, type PropertyEditorProps } from '@/data/api'
import { Block } from '@/data/block'

const EMPTY_OPTIONS: readonly { value: string; label: string }[] = []

export function SelectPropertyEditor({
  value,
  onChange,
  block,
  schema,
}: PropertyEditorProps<string>) {
  const readOnly = block instanceof Block && block.repo.isReadOnly
  const options = schema && isEnumCodec(schema.codec) ? schema.codec.options : EMPTY_OPTIONS
  const current = typeof value === 'string' ? value : ''
  // The controlled value must always match a rendered <option>, or the
  // browser silently shows option 0 while the real value stays put.
  // Render an extra entry for any current value not in the set: a stale
  // value (an option was removed) as "… (unknown)" so the user can swap
  // it, and the unset/empty case as a "— Select —" placeholder.
  const inOptions = options.some(option => option.value === current)

  return (
    <div className="flex h-7 items-center">
      <select
        className="h-7 min-w-0 max-w-full rounded-md border bg-background px-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        value={current}
        disabled={readOnly}
        aria-label={schema?.name ? `Select ${schema.name}` : 'Select value'}
        onChange={event => {
          if (!readOnly) onChange(event.target.value)
        }}
      >
        {!inOptions && (
          <option value={current}>
            {current === '' ? '— Select —' : `${current} (unknown)`}
          </option>
        )}
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
