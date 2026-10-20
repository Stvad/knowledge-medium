import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export interface ActionProps {
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
}

export function Actions({primary, secondary}: {primary?: ActionProps; secondary?: ActionProps}) {
  return (
    <div className="flex justify-end gap-2">
      {secondary && <Button type="button" variant="secondary" onClick={secondary.onClick}>{secondary.label}</Button>}
      {primary && <Button type="button" disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</Button>}
    </div>
  )
}

export function ConfirmCheck({id, checked, onChange, children}: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={value => onChange(value === true)} className="mt-0.5"/>
      <Label htmlFor={id} className="text-sm font-normal leading-snug">{children}</Label>
    </div>
  )
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** Every item, scrolled: these lists are what the conversion leaves behind,
 *  shown once, so none goes unnamed. */
export function ScrollList<T>({items, render}: {items: readonly T[]; render: (item: T) => ReactNode}) {
  return (
    <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
      {items.map((item, index) => <li key={index} className="break-all">{render(item)}</li>)}
    </ul>
  )
}
