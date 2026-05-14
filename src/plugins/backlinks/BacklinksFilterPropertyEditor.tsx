import { useMemo } from 'react'
import { type PropertyEditorProps } from '@/data/api'
import { useRepo } from '@/context/repo.tsx'
import {
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'
import { BacklinkFilters } from './BacklinkFilters.tsx'
import type { StoredBacklinksFilter } from './filterProperty.ts'

const isReadOnlyBlock = (block: unknown): boolean => {
  if (!block || typeof block !== 'object') return false
  const repo = (block as { repo?: { isReadOnly?: unknown } }).repo
  return repo?.isReadOnly === true
}

const workspaceIdFromBlock = (block: unknown): string | undefined => {
  if (!block || typeof block !== 'object') return undefined
  const peek = (block as { peek?: unknown }).peek
  if (typeof peek !== 'function') return undefined
  const data = (peek as () => { workspaceId?: unknown } | null | undefined)()
  return typeof data?.workspaceId === 'string' ? data.workspaceId : undefined
}

export const BacklinksFilterPropertyEditor = ({
  value,
  onChange,
  block,
}: PropertyEditorProps<StoredBacklinksFilter>) => {
  const repo = useRepo()
  const readOnly = isReadOnlyBlock(block)
  const filter = useMemo(() => normalizeBacklinksFilter(value), [value])
  const workspaceId = repo.activeWorkspaceId ?? workspaceIdFromBlock(block) ?? ''
  const handleChange = (next: BacklinksFilter) => onChange(normalizeBacklinksFilter(next))

  if (!workspaceId) return <div className="text-xs text-muted-foreground">No workspace selected.</div>

  return (
    <BacklinkFilters
      workspaceId={workspaceId}
      filter={filter}
      onChange={handleChange}
      readOnly={readOnly}
    />
  )
}
