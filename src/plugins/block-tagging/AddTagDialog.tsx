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
import { usePluginPrefsProperty } from '@/data/globalState.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import {
  blockTaggingPrefsType,
  blockTagsConfigProp,
  isValidTagName,
  normalizeBlockTagsConfig,
  tagNameIssue,
} from './config.ts'
import { MAX_ALIAS_LENGTH } from '@/plugins/references/referenceParser'

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
  const [storedTags] = usePluginPrefsProperty(blockTaggingPrefsType, blockTagsConfigProp)
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
  // `null` when valid; 'empty' can't surface here (guarded by the length
  // check) so the two rendered branches below cover every visible case.
  const queryIssue = trimmedQuery.length > 0 ? tagNameIssue(trimmedQuery) : null
  const canCreateCustom = trimmedQuery.length > 0 && !exactQueryMatch && queryIssue === null

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
          {queryIssue === 'delimiters' && (
            <p className="text-xs text-destructive">
              Tag names can&apos;t contain <code>[[</code> or <code>]]</code>.
            </p>
          )}
          {queryIssue === 'too-long' && (
            <p className="text-xs text-destructive">
              Tag names must be under {MAX_ALIAS_LENGTH} characters.
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
