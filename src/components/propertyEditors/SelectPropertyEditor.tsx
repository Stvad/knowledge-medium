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
  // A stored value outside the current option set (e.g. an option was
  // removed) still needs to render rather than silently snapping to the
  // first option, so surface it as a transient extra entry.
  const hasCurrent = current === '' || options.some(option => option.value === current)

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
        {!hasCurrent && <option value={current}>{current} (unknown)</option>}
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
