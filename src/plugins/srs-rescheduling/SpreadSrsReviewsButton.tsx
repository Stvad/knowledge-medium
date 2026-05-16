import { FormEvent, MouseEvent, useMemo, useState } from 'react'
import { Shuffle } from 'lucide-react'
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
import type {
  GroupedBacklinksGroupHeaderControlProps,
} from '@/plugins/grouped-backlinks/facet.ts'
import { showError, showSuccess } from '@/utils/toast.ts'
import { srsBlockDateAdapter } from './srsBlockDateAdapter.ts'
import { spreadSrsReviewDates } from './spreadReviews.ts'

const DEFAULT_SPREAD_DAYS = '15'

const parseDays = (value: string): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.floor(parsed)
}

export const SpreadSrsReviewsButton = ({
  sourceBlocks,
}: GroupedBacklinksGroupHeaderControlProps) => {
  const [open, setOpen] = useState(false)
  const [days, setDays] = useState(DEFAULT_SPREAD_DAYS)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eligibleCount = useMemo(
    () => sourceBlocks.filter(block => srsBlockDateAdapter.canHandle(block)).length,
    [sourceBlocks],
  )

  if (eligibleCount === 0) return null

  const handleOpen = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setError(null)
    setOpen(true)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const dayCount = parseDays(days)
    if (dayCount === null) {
      setError('Choose at least 1 day')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const result = await spreadSrsReviewDates(sourceBlocks, {days: dayCount})
      setOpen(false)
      if (result.updated > 0) {
        showSuccess(`Spread ${result.updated} SRS review${result.updated === 1 ? '' : 's'}`)
      } else {
        showError('No SRS reviews were updated')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to spread SRS reviews')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
        title="Randomly spread SRS reviews"
        aria-label="Randomly spread SRS reviews"
        onClick={handleOpen}
      >
        <Shuffle className="h-3.5 w-3.5" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setError(null)
          setOpen(next)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Spread SRS reviews</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="srs-spread-days">Days</Label>
              <Input
                id="srs-spread-days"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={days}
                disabled={submitting}
                onChange={event => setDays(event.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Spreading...' : 'Spread'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
