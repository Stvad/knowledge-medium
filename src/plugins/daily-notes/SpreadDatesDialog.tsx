import { FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { DialogContextProps } from '@/utils/dialogs.ts'

export interface SpreadDatesDialogProps {
  defaultDays?: number
}

export interface SpreadDatesDialogResult {
  days: number
}

const DEFAULT_SPREAD_DAYS = 15

const parseDays = (value: string): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.floor(parsed)
}

export const SpreadDatesDialog = ({
  defaultDays = DEFAULT_SPREAD_DAYS,
  resolve,
  cancel,
}: SpreadDatesDialogProps & DialogContextProps<SpreadDatesDialogResult>) => {
  const [days, setDays] = useState(String(defaultDays))
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault()
    const dayCount = parseDays(days)
    if (dayCount === null) {
      setError('Choose at least 1 day')
      return
    }
    resolve({days: dayCount})
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
          <DialogTitle>Spread dates</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="spread-dates-days">Days</Label>
            <Input
              id="spread-dates-days"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={days}
              onChange={event => setDays(event.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit">Spread</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
