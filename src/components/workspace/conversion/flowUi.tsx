import { Button } from '@/components/ui/button'

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
