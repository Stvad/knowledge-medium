import type { ReactNode } from 'react'
import type { PropertyKind } from '@/data/api'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

const INLINE_INPUT_CLASS =
  'h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/55 focus-visible:border-transparent focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-60'

function InlineValueShell({children}: {children: ReactNode}) {
  return (
    <div className="min-w-0">{children}</div>
  )
}

export function InlineEmptyValue({kind}: {kind: PropertyKind}) {
  return (
    <InlineValueShell>
      <div className="h-7 truncate py-1 text-sm text-muted-foreground/55">
        {kind === 'list' || kind === 'refList' ? 'Select option' : 'Empty'}
      </div>
    </InlineValueShell>
  )
}

export function InlinePropertyValueEditor({
  kind,
  value,
  onChange,
  readOnly,
  ariaLabel,
}: {
  kind: PropertyKind
  value: unknown
  onChange: (next: unknown) => void
  readOnly: boolean
  ariaLabel?: string
}) {
  if (kind === 'list' || kind === 'refList') {
    const items = Array.isArray(value) ? value.map(v => typeof v === 'string' ? v : String(v)) : []
    return (
      <InlineValueShell>
        <Input
          className={INLINE_INPUT_CLASS}
          value={items.join(', ')}
          placeholder="Select option"
          readOnly={readOnly}
          onChange={(event) => {
            if (readOnly) return
            const text = event.target.value
            onChange(text.trim() ? text.split(',').map(item => item.trim()).filter(Boolean) : [])
          }}
        />
      </InlineValueShell>
    )
  }

  if (kind === 'boolean') {
    return (
      <InlineValueShell>
        <div className="flex h-7 items-center">
          <Checkbox
            aria-label={ariaLabel ?? 'Toggle boolean value'}
            checked={value === true}
            disabled={readOnly}
            onCheckedChange={(checked) => {
              if (readOnly) return
              onChange(checked === true)
            }}
          />
        </div>
      </InlineValueShell>
    )
  }

  if (kind === 'number') {
    return (
      <InlineValueShell>
        <Input
          type="number"
          className={INLINE_INPUT_CLASS}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder="Empty"
          readOnly={readOnly}
          onChange={(event) => {
            if (readOnly) return
            const n = parseFloat(event.target.value)
            onChange(Number.isNaN(n) ? undefined : n)
          }}
        />
      </InlineValueShell>
    )
  }

  if (kind === 'object') {
    return (
      <InlineValueShell>
        <Input
          className={`${INLINE_INPUT_CLASS} font-mono`}
          value={JSON.stringify(value ?? {})}
          placeholder="Empty"
          readOnly={readOnly}
          onChange={(event) => {
            if (readOnly) return
            try {
              onChange(JSON.parse(event.target.value))
            } catch {
              // Keep the inline editor forgiving while the user is typing malformed JSON.
            }
          }}
        />
      </InlineValueShell>
    )
  }

  if (kind === 'date') {
    const isoString = value instanceof Date
      ? value.toISOString().slice(0, 10)
      : (typeof value === 'string' && value ? value.slice(0, 10) : '')
    return (
      <InlineValueShell>
        <Input
          type="date"
          className={INLINE_INPUT_CLASS}
          value={isoString}
          placeholder="Empty"
          readOnly={readOnly}
          onChange={(event) => {
            if (readOnly) return
            const text = event.target.value
            onChange(text ? new Date(text) : undefined)
          }}
        />
      </InlineValueShell>
    )
  }

  return (
    <InlineValueShell>
      <Input
        className={INLINE_INPUT_CLASS}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder="Empty"
        readOnly={readOnly}
        onChange={(event) => {
          if (!readOnly) onChange(event.target.value)
        }}
      />
    </InlineValueShell>
  )
}
