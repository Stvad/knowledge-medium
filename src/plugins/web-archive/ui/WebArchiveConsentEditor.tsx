/**
 * The consent surface for `webarchive:enabled`.
 *
 * This is a custom editor rather than the default boolean checkbox for one
 * reason: a bare "Enabled ☐" does not tell the user that turning it on hands
 * a third party a record of what they read. The consequence has to be next to
 * the switch, in plain language, before the click — not in a doc, not in a
 * tooltip, not discovered afterwards.
 *
 * It doubles as the volume readout the user asked for: total published, and
 * the rolling hour and day, live from the records themselves.
 */

import { useMemo } from 'react'
import type { PropertyEditorProps } from '@/data/api'
import { isReadOnlyBlock } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { useBlockQuery, useProperty } from '@/hooks/block.js'
import { Checkbox } from '@/components/ui/checkbox.js'
import { Label } from '@/components/ui/label.js'
import { ARCHIVE_SNAPSHOT_TYPE } from '../schema.ts'
import { toArchiveRecord } from '../snapshots.ts'
import { computeVolume, submissionBudget } from '../rateLimit.ts'
import { readArchiveServices } from '../serviceRegistry.ts'
import { SKIP_REASON_LABELS } from '../hostPolicy.ts'
import {
  archiveDailyLimitProp,
  archiveHourlyLimitProp,
  archiveServiceIdProp,
  type WebArchivePrefs,
} from '../prefs.ts'
import type { Block } from '@/data/block.js'

const NEVER_SUBMITTED = [
  SKIP_REASON_LABELS['non-public-host'],
  SKIP_REASON_LABELS['credentials-in-url'],
  SKIP_REASON_LABELS['sensitive-query'],
  SKIP_REASON_LABELS['non-http'],
]

const Stat = ({label, value}: {label: string; value: number | string}) => (
  <div className="flex flex-col">
    <span className="text-lg tabular-nums leading-tight">{value}</span>
    <span className="text-xs text-muted-foreground">{label}</span>
  </div>
)

export const WebArchiveConsentEditor = ({
  value,
  onChange,
  block,
}: PropertyEditorProps<boolean>) => {
  const repo = useRepo()
  const prefsBlock = block as Block
  const readOnly = isReadOnlyBlock(block)
  const workspaceId = repo.activeWorkspaceId ?? ''

  const rows = useBlockQuery({workspaceId, types: [ARCHIVE_SNAPSHOT_TYPE]})
  const stats = useMemo(
    () => computeVolume(rows.map(toArchiveRecord), new Date()),
    [rows],
  )

  // Reactive reads: the limit fields sit in this same property panel, so a
  // non-reactive `block.get` would leave the budget line stale the moment the
  // user edits the number right above it.
  const [serviceId] = useProperty(prefsBlock, archiveServiceIdProp)
  const [hourlyLimit] = useProperty(prefsBlock, archiveHourlyLimitProp)
  const [dailyLimit] = useProperty(prefsBlock, archiveDailyLimitProp)

  const service = readArchiveServices(repo).get(serviceId)
  const limits: Pick<WebArchivePrefs, 'hourlyLimit' | 'dailyLimit'> =
    {hourlyLimit, dailyLimit}
  const budget = submissionBudget(stats, limits)

  return (
    <div className="flex flex-col gap-3 py-1">
      <div className="flex items-start gap-2">
        <Checkbox
          id="web-archive-enabled"
          checked={value}
          disabled={readOnly}
          onCheckedChange={next => { onChange(next === true) }}
          className="mt-0.5"
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="web-archive-enabled" className="cursor-pointer">
            Submit links in my notes to a public web archive
          </Label>
          <p className="text-xs text-muted-foreground max-w-prose">
            <strong className="text-foreground">This publishes what you read.</strong>{' '}
            Every link you write in a note is sent to{' '}
            {service ? service.label : `“${serviceId}”`}, which records the URL and
            the time it was submitted, permanently and publicly. Anyone can later
            look up that this URL was submitted. Turn this on only for links you
            are comfortable being seen.
          </p>
          {service ? (
            <p className="text-xs text-muted-foreground max-w-prose">{service.privacyNote}</p>
          ) : (
            <p className="text-xs text-destructive max-w-prose">
              No archive service is registered under “{serviceId}”. Nothing will be
              submitted until one is.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-md border border-border p-3 flex flex-col gap-2">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="submitted, all time" value={stats.total}/>
          <Stat label="in the last hour" value={stats.lastHour}/>
          <Stat label="in the last 24h" value={stats.lastDay}/>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="queued" value={stats.pending}/>
          <Stat label="awaiting snapshot" value={stats.awaitingSnapshot}/>
          <Stat label="failed" value={stats.failed}/>
        </div>
        {budget.blockedBy ? (
          <p className="text-xs text-muted-foreground">
            {budget.blockedBy === 'hourly' ? 'Hourly' : 'Daily'} limit reached —
            queued links are waiting, not dropped.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {budget.remaining} more submission{budget.remaining === 1 ? '' : 's'} allowed
            before the next limit.
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground max-w-prose">
        Never submitted, whatever this is set to: links whose{' '}
        {NEVER_SUBMITTED.join(', ')}. Add hosts to the denylist below to exclude
        more; a host there also covers its subdomains, and{' '}
        <code>*.example.com</code> covers subdomains only.
      </p>
    </div>
  )
}
