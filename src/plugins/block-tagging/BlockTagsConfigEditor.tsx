import { KeyboardEvent, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { type PropertyEditorProps } from '@/data/api'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { isValidTagName, normalizeBlockTagsConfig } from './config.ts'

const isReadOnlyBlock = (block: unknown): boolean => {
  if (!block || typeof block !== 'object') return false
  const repo = (block as { repo?: { isReadOnly?: unknown } }).repo
  return repo?.isReadOnly === true
}

export const BlockTagsConfigEditor = ({
  value,
  onChange,
  block,
}: PropertyEditorProps<string[]>) => {
  const readOnly = isReadOnlyBlock(block)
  const tags = useMemo(() => normalizeBlockTagsConfig(value), [value])
  const [draft, setDraft] = useState('')

  const commitDraft = (): void => {
    const trimmed = draft.trim()
    if (!isValidTagName(trimmed) || tags.includes(trimmed)) return
    onChange(normalizeBlockTagsConfig([...tags, trimmed]))
    setDraft('')
  }

  const draftInvalid = draft.trim().length > 0 && !isValidTagName(draft)

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitDraft()
    }
  }

  const removeTag = (tag: string): void => {
    onChange(normalizeBlockTagsConfig(tags.filter(t => t !== tag)))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {tags.map(tag => (
          <span
            key={tag}
            className="inline-flex min-w-0 items-center gap-1 rounded-sm border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs"
            title={tag}
          >
            <span className="max-w-[18ch] truncate">[[{tag}]]</span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="shrink-0 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={`Remove ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {!readOnly && (
        <>
          <div className="flex items-center gap-1">
            <Input
              value={draft}
              placeholder="Add tag"
              onChange={event => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={commitDraft}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={commitDraft}
              disabled={!isValidTagName(draft)}
              title="Add tag"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {draftInvalid && (
            <p className="text-xs text-destructive">
              Tag names can&apos;t contain <code>[[</code> or <code>]]</code>.
            </p>
          )}
        </>
      )}
    </div>
  )
}
