import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useUserPrefsProperty } from '@/data/globalState.ts'
import type { DialogContextProps } from '@/utils/dialogs.ts'
import {
  blockTagsConfigProp,
  isValidTagName,
  normalizeBlockTagsConfig,
} from './config.ts'

export interface AddTagDialogResult {
  tagName: string
}

const filterTags = (tags: readonly string[], query: string): string[] => {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return [...tags]
  return tags.filter(tag => tag.toLowerCase().includes(trimmed))
}

export const AddTagDialog = ({
  resolve,
  cancel,
}: DialogContextProps<AddTagDialogResult>) => {
  const [storedTags] = useUserPrefsProperty(blockTagsConfigProp)
  const tags = useMemo(() => normalizeBlockTagsConfig(storedTags), [storedTags])
  const [query, setQuery] = useState('')
  const filteredTags = useMemo(() => filterTags(tags, query), [tags, query])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const trimmedQuery = query.trim()
  const exactQueryMatch = trimmedQuery.length > 0
    && tags.some(tag => tag.toLowerCase() === trimmedQuery.toLowerCase())
  const queryInvalid = trimmedQuery.length > 0 && !isValidTagName(trimmedQuery)
  const canCreateCustom = trimmedQuery.length > 0 && !exactQueryMatch && !queryInvalid

  const submitTag = (tagName: string): void => {
    const next = tagName.trim()
    if (!isValidTagName(next)) return
    resolve({tagName: next})
  }

  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next) cancel()
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add tag</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={event => {
            event.preventDefault()
            if (filteredTags.length > 0) {
              submitTag(filteredTags[0])
              return
            }
            if (canCreateCustom) submitTag(trimmedQuery)
          }}
        >
          <Input
            ref={inputRef}
            value={query}
            placeholder={
              tags.length > 0 ? 'Search or type a new tag' : 'Type a tag name'
            }
            onChange={event => setQuery(event.target.value)}
          />
          {tags.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No tags configured yet. Type a name to apply it once, or add
              defaults under the user-prefs &quot;Block tags&quot; entry.
            </p>
          )}
          {queryInvalid && (
            <p className="text-xs text-destructive">
              Tag names can&apos;t contain <code>[[</code> or <code>]]</code>.
            </p>
          )}
          {filteredTags.length > 0 && (
            <ul className="flex flex-col gap-1">
              {filteredTags.map(tag => (
                <li key={tag}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-sm border border-border/60 px-2 py-1 text-left text-sm hover:bg-accent"
                    onClick={() => submitTag(tag)}
                  >
                    <span className="truncate">[[{tag}]]</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {canCreateCustom && (
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-sm border border-dashed border-border px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => submitTag(trimmedQuery)}
            >
              <span className="truncate">Apply [[{trimmedQuery}]] (one-off)</span>
            </button>
          )}
          <DialogFooter className="pt-1">
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
